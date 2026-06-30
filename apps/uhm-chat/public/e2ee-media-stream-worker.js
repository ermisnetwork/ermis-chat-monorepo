/* E2EE media streaming service worker. Keeps decrypted frames in memory only. */
const VIRTUAL_PREFIX = '/__ermis/e2ee-media/';
const SMOKE_PATH = '/__ermis/e2ee-media-smoke';
const FRAME_HEADER_BYTES = 8;
const GCM_TAG_BYTES = 16;
const IDLE_TTL_MS = 30 * 60 * 1000;
const SESSION_CACHE_LIMIT = 16 * 1024 * 1024;
const GLOBAL_CACHE_LIMIT = 64 * 1024 * 1024;
const MAX_R2_RETRIES = 2;
const RETRY_BASE_MS = 250;

const sessions = new Map();
let globalCacheBytes = 0;
const grantRenewals = new Map();

self.addEventListener('install', () => {
	self.skipWaiting();
});

self.addEventListener('activate', (event) => {
	// The worker uses root scope so the chat page can request virtual media URLs.
	// Fetch handling below is still limited to /__ermis/e2ee-media/* and the smoke route.
	event.waitUntil(self.clients.claim());
});

function ack(source, requestId, ok, payload, error) {
	if (!source || !requestId) return;
	source.postMessage({ type: 'ERMIS_E2EE_MEDIA_STREAM_ACK', requestId, ok, payload, error });
}

async function reportWorkerError(event, error) {
	const message = error?.message || String(error || 'E2EE media stream error');
	console.error('[E2EE media stream worker] fetch failed', message, error);
	try {
		const client = event.clientId ? await clients.get(event.clientId) : undefined;
		client?.postMessage({
			type: 'ERMIS_E2EE_MEDIA_STREAM_ERROR',
			url: event.request.url,
			range: event.request.headers.get('Range'),
			error: message,
		});
	} catch {
		// Best-effort diagnostics only.
	}
	return new Response(message, { status: 502, headers: { 'Cache-Control': 'no-store' } });
}

function base64ToBytes(value) {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function readU32(bytes, offset) {
	return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function nonceForFrame(noncePrefix, frameIndex) {
	const nonce = new Uint8Array(12);
	nonce.set(noncePrefix, 0);
	nonce[8] = (frameIndex >>> 24) & 0xff;
	nonce[9] = (frameIndex >>> 16) & 0xff;
	nonce[10] = (frameIndex >>> 8) & 0xff;
	nonce[11] = frameIndex & 0xff;
	return nonce;
}

async function importAesKey(session) {
	if (!session.cryptoKeyPromise) {
		session.cryptoKeyPromise = crypto.subtle.importKey(
			'raw',
			base64ToBytes(session.contentKey),
			{ name: 'AES-GCM' },
			false,
			['decrypt'],
		);
	}
	return await session.cryptoKeyPromise;
}

function touchSession(session) {
	session.lastAccess = Date.now();
}

function framePlainLength(session, frameIndex) {
	const start = frameIndex * session.frameSize;
	return Math.max(0, Math.min(session.frameSize, session.plaintextSize - start));
}

function frameEncryptedLength(session, frameIndex) {
	return FRAME_HEADER_BYTES + framePlainLength(session, frameIndex) + GCM_TAG_BYTES;
}

function frameStartEncrypted(session, frameIndex) {
	// This closed-form offset works because every frame before the last has a fixed plaintext size.
	return frameIndex * (FRAME_HEADER_BYTES + session.frameSize + GCM_TAG_BYTES);
}

function frameCount(session) {
	return Math.max(1, Math.ceil(session.plaintextSize / session.frameSize));
}

function cacheKey(sessionId, frameIndex) {
	return `${sessionId}:${frameIndex}`;
}

function evictFrame(session, key) {
	const frame = session.frameCache.get(key);
	if (!frame) return;
	session.frameCache.delete(key);
	session.cacheBytes -= frame.byteLength;
	globalCacheBytes -= frame.byteLength;
}

function cacheFrame(session, frameIndex, plain) {
	const key = cacheKey(session.sessionId, frameIndex);
	if (session.frameCache.has(key)) evictFrame(session, key);
	session.frameCache.set(key, plain);
	session.cacheBytes += plain.byteLength;
	globalCacheBytes += plain.byteLength;
	while (session.cacheBytes > SESSION_CACHE_LIMIT && session.frameCache.size > 0) {
		const oldest = session.frameCache.keys().next().value;
		evictFrame(session, oldest);
	}
	while (globalCacheBytes > GLOBAL_CACHE_LIMIT) {
		let evicted = false;
		for (const candidate of sessions.values()) {
			const oldest = candidate.frameCache.keys().next().value;
			if (oldest) {
				evictFrame(candidate, oldest);
				evicted = true;
				break;
			}
		}
		if (!evicted) break;
	}
}

function getCachedFrame(session, frameIndex) {
	const key = cacheKey(session.sessionId, frameIndex);
	const value = session.frameCache.get(key);
	if (!value) return undefined;
	session.frameCache.delete(key);
	session.frameCache.set(key, value);
	return value;
}

function parseRange(header, size) {
	if (!header) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return { invalid: true };
	const startRaw = match[1];
	const endRaw = match[2];
	if (!startRaw && !endRaw) return { invalid: true };
	if (!startRaw) {
		const suffix = Number(endRaw);
		if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true };
		const start = Math.max(0, size - suffix);
		return { start, endExclusive: size };
	}
	const start = Number(startRaw);
	const inclusiveEnd = endRaw ? Number(endRaw) : size - 1;
	if (
		!Number.isFinite(start) ||
		!Number.isFinite(inclusiveEnd) ||
		start < 0 ||
		inclusiveEnd < start ||
		start >= size
	) {
		return { invalid: true };
	}
	return { start, endExclusive: Math.min(size, inclusiveEnd + 1) };
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renewGrant(session, clientId) {
	if (session.renewalPromise) return await session.renewalPromise;
	const requestId = `${session.sessionId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
	session.renewalPromise = new Promise(async (resolve, reject) => {
		const client = clientId ? await clients.get(clientId) : undefined;
		if (!client) {
			reject(new Error('E2EE media stream client is unavailable'));
			return;
		}
		const timeout = setTimeout(() => {
			grantRenewals.delete(requestId);
			reject(new Error('E2EE media stream grant renewal timed out'));
		}, 15000);
		grantRenewals.set(requestId, { resolve, reject, timeout });
		client.postMessage({ type: 'ERMIS_E2EE_MEDIA_STREAM_RENEW_GRANT', requestId, sessionId: session.sessionId });
	}).finally(() => {
		session.renewalPromise = null;
	});
	return await session.renewalPromise;
}

async function fetchEncryptedRange(session, start, endExclusive, clientId, signal) {
	if (Date.now() >= session.expiresAtMs) await renewGrant(session, clientId);
	const headers = { Range: `bytes=${start}-${endExclusive - 1}` };
	for (let attempt = 0; attempt <= MAX_R2_RETRIES; attempt += 1) {
		const response = await fetch(session.grantUrl, { headers, cache: 'no-store', signal });
		if (response.status === 206) return new Uint8Array(await response.arrayBuffer());
		if (response.status === 200) throw new Error('E2EE media stream unsupported: R2 ignored Range request');
		if (response.status === 401 || response.status === 403) {
			await renewGrant(session, clientId);
			continue;
		}
		if ((response.status === 429 || response.status >= 500) && attempt < MAX_R2_RETRIES) {
			await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
			continue;
		}
		throw new Error(
			`E2EE media encrypted range fetch failed: HTTP ${response.status}; requested=${start}-${
				endExclusive - 1
			}; content-range=${response.headers.get('Content-Range') || ''}`,
		);
	}
	throw new Error('E2EE media encrypted range fetch failed');
}

async function decryptFrame(session, frameIndex, encrypted, offset) {
	const header = encrypted.slice(offset, offset + FRAME_HEADER_BYTES);
	if (header.length !== FRAME_HEADER_BYTES) throw new Error('Invalid E2EE media frame header');
	const plainLength = readU32(header, 0);
	const cipherLength = readU32(header, 4);
	const expectedPlainLength = framePlainLength(session, frameIndex);
	if (plainLength !== expectedPlainLength || cipherLength !== plainLength + GCM_TAG_BYTES) {
		throw new Error(
			`Invalid E2EE media frame lengths: frame=${frameIndex}; offset=${offset}; plain=${plainLength}; cipher=${cipherLength}; expectedPlain=${expectedPlainLength}; encryptedBytes=${encrypted.length}`,
		);
	}
	const cipher = encrypted.slice(offset + FRAME_HEADER_BYTES, offset + FRAME_HEADER_BYTES + cipherLength);
	const key = await importAesKey(session);
	const plain = new Uint8Array(
		await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: nonceForFrame(session.noncePrefix, frameIndex) },
			key,
			cipher,
		),
	);
	if (plain.length !== plainLength) throw new Error('Invalid E2EE media plaintext frame length');
	return plain;
}

async function loadFrames(session, firstFrame, lastFrame, clientId, signal) {
	const missing = [];
	for (let frame = firstFrame; frame <= lastFrame; frame += 1) {
		if (!getCachedFrame(session, frame)) missing.push(frame);
	}
	if (missing.length === 0) return;
	let groupStart = missing[0];
	let previous = missing[0];
	const flush = async (startFrame, endFrame) => {
		const encryptedStart = frameStartEncrypted(session, startFrame);
		const encryptedEnd = frameStartEncrypted(session, endFrame) + frameEncryptedLength(session, endFrame);
		const encrypted = await fetchEncryptedRange(session, encryptedStart, encryptedEnd, clientId, signal);
		let offset = 0;
		for (let frame = startFrame; frame <= endFrame; frame += 1) {
			const plain = await decryptFrame(session, frame, encrypted, offset);
			cacheFrame(session, frame, plain);
			offset += frameEncryptedLength(session, frame);
		}
	};
	for (let i = 1; i < missing.length; i += 1) {
		const frame = missing[i];
		if (frame === previous + 1) {
			previous = frame;
			continue;
		}
		await flush(groupStart, previous);
		groupStart = frame;
		previous = frame;
	}
	await flush(groupStart, previous);
}

function buildRangeStream(session, start, endExclusive, clientId, requestSignal) {
	let frame = Math.floor(start / session.frameSize);
	const lastFrame = Math.floor((endExclusive - 1) / session.frameSize);
	const abort = new AbortController();
	let cleanedUp = false;
	const cleanup = () => {
		if (cleanedUp) return;
		cleanedUp = true;
		requestSignal?.removeEventListener?.('abort', abortFromRequest);
	};
	const abortFromRequest = () => abort.abort();
	if (requestSignal?.aborted) abort.abort();
	else requestSignal?.addEventListener?.('abort', abortFromRequest, { once: true });

	return new ReadableStream({
		async pull(controller) {
			if (abort.signal.aborted || frame > lastFrame) {
				cleanup();
				controller.close();
				return;
			}
			try {
				await loadFrames(session, frame, frame, clientId, abort.signal);
				if (abort.signal.aborted) {
					cleanup();
					controller.close();
					return;
				}
				const plain = getCachedFrame(session, frame);
				if (!plain) throw new Error('E2EE media decrypted frame missing from cache');
				const plainStart = frame * session.frameSize;
				const sliceStart = Math.max(0, start - plainStart);
				const sliceEnd = Math.min(plain.length, endExclusive - plainStart);
				if (sliceEnd > sliceStart) controller.enqueue(plain.slice(sliceStart, sliceEnd));
				frame += 1;
				if (frame > lastFrame) {
					cleanup();
					controller.close();
				}
			} catch (err) {
				cleanup();
				if (abort.signal.aborted || err?.name === 'AbortError') {
					controller.close();
					return;
				}
				controller.error(err);
			}
		},
		cancel() {
			abort.abort();
			cleanup();
		},
	});
}

function responseHeaders(session, contentLength, extra = {}) {
	return new Headers({
		'Accept-Ranges': 'bytes',
		'Content-Length': String(contentLength),
		'Content-Type': session.mimeType || 'application/octet-stream',
		'Cache-Control': 'no-store',
		...extra,
	});
}

async function handleRangeRequest(event, session, range) {
	const body = buildRangeStream(session, range.start, range.endExclusive, event.clientId, event.request.signal);
	return new Response(body, {
		status: 206,
		headers: responseHeaders(session, range.endExclusive - range.start, {
			'Content-Range': `bytes ${range.start}-${range.endExclusive - 1}/${session.plaintextSize}`,
		}),
	});
}

function handleNoRangeRequest(event, session) {
	let frame = 0;
	const abort = new AbortController();
	event.request.signal.addEventListener('abort', () => abort.abort(), { once: true });
	const stream = new ReadableStream({
		async pull(controller) {
			if (abort.signal.aborted || frame >= frameCount(session)) {
				controller.close();
				return;
			}
			try {
				await loadFrames(session, frame, frame, event.clientId, abort.signal);
				if (abort.signal.aborted) {
					controller.close();
					return;
				}
				const plain = getCachedFrame(session, frame);
				if (!plain) throw new Error('E2EE media decrypted frame missing from cache');
				controller.enqueue(plain);
				frame += 1;
			} catch (err) {
				if (abort.signal.aborted || err?.name === 'AbortError') {
					controller.close();
					return;
				}
				controller.error(err);
			}
		},
		cancel() {
			abort.abort();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: responseHeaders(session, session.plaintextSize),
	});
}

async function handleMediaFetch(event) {
	const url = new URL(event.request.url);
	if (url.pathname === SMOKE_PATH)
		return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
	if (!url.pathname.startsWith(VIRTUAL_PREFIX)) return fetch(event.request);
	const sessionId = decodeURIComponent(url.pathname.slice(VIRTUAL_PREFIX.length));
	const session = sessions.get(sessionId);
	if (!session) return new Response('E2EE media stream session missing', { status: 410 });
	touchSession(session);
	const range = parseRange(event.request.headers.get('Range'), session.plaintextSize);
	if (range && range.invalid) {
		return new Response('Invalid range', {
			status: 416,
			headers: { 'Content-Range': `bytes */${session.plaintextSize}`, 'Cache-Control': 'no-store' },
		});
	}
	if (range) return await handleRangeRequest(event, session, range);
	return handleNoRangeRequest(event, session);
}

self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);
	if (url.pathname === SMOKE_PATH || url.pathname.startsWith(VIRTUAL_PREFIX)) {
		event.respondWith(handleMediaFetch(event).catch((err) => reportWorkerError(event, err)));
	}
});

self.addEventListener('message', (event) => {
	const data = event.data || {};
	if (data.type === 'ERMIS_E2EE_MEDIA_STREAM_PING') {
		ack(event.source, data.requestId, true, { ok: true });
		return;
	}
	if (data.type === 'ERMIS_E2EE_MEDIA_STREAM_CREATE_SESSION') {
		const raw = data.session || {};
		const session = {
			...raw,
			sessionId: String(raw.sessionId),
			noncePrefix: base64ToBytes(String(raw.noncePrefix || '')),
			frameCache: new Map(),
			cacheBytes: 0,
			lastAccess: Date.now(),
			cryptoKeyPromise: null,
			renewalPromise: null,
		};
		if (!session.sessionId || !session.grantUrl || !session.contentKey || session.noncePrefix.length !== 8) {
			ack(event.source, data.requestId, false, undefined, 'Invalid E2EE media stream session');
			return;
		}
		sessions.set(session.sessionId, session);
		ack(event.source, data.requestId, true, { sessionId: session.sessionId });
		return;
	}
	if (data.type === 'ERMIS_E2EE_MEDIA_STREAM_TEST_SESSION') {
		const session = sessions.get(data.sessionId);
		if (!session) {
			ack(event.source, data.requestId, false, undefined, 'E2EE media stream session missing');
			return;
		}
		loadFrames(session, 0, 0, undefined, undefined)
			.then(() => ack(event.source, data.requestId, true, { ok: true }))
			.catch((err) => {
				const message = err?.message || String(err || 'E2EE media stream session test failed');
				console.error('[E2EE media stream worker] session test failed', message, err);
				ack(event.source, data.requestId, false, undefined, message);
			});
		return;
	}
	if (data.type === 'ERMIS_E2EE_MEDIA_STREAM_DISPOSE_SESSION') {
		const session = sessions.get(data.sessionId);
		if (session) {
			for (const key of Array.from(session.frameCache.keys())) evictFrame(session, key);
			sessions.delete(data.sessionId);
		}
		ack(event.source, data.requestId, true, { ok: true });
		return;
	}
	if (data.type === 'ERMIS_E2EE_MEDIA_STREAM_DISPOSE_ALL') {
		for (const session of sessions.values()) {
			for (const key of Array.from(session.frameCache.keys())) evictFrame(session, key);
		}
		sessions.clear();
		ack(event.source, data.requestId, true, { ok: true });
		return;
	}
	if (data.type === 'ERMIS_E2EE_MEDIA_STREAM_GRANT_RENEWED' || data.type === 'ERMIS_E2EE_MEDIA_STREAM_GRANT_FAILED') {
		const renewal = grantRenewals.get(data.requestId);
		if (!renewal) return;
		grantRenewals.delete(data.requestId);
		clearTimeout(renewal.timeout);
		if (data.type === 'ERMIS_E2EE_MEDIA_STREAM_GRANT_FAILED') {
			renewal.reject(new Error(data.error || 'E2EE media stream grant renewal failed'));
			return;
		}
		const session = sessions.get(data.sessionId);
		if (session) {
			session.grantUrl = data.grantUrl;
			session.expiresAtMs = data.expiresAtMs;
		}
		renewal.resolve(true);
	}
});

setInterval(() => {
	const now = Date.now();
	for (const [sessionId, session] of sessions) {
		if (now - session.lastAccess <= IDLE_TTL_MS) continue;
		for (const key of Array.from(session.frameCache.keys())) evictFrame(session, key);
		sessions.delete(sessionId);
	}
}, 60 * 1000);
