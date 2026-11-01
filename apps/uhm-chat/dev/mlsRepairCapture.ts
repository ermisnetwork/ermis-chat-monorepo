import { appendFile } from 'node:fs/promises';
import type { Plugin } from 'vite';

const FILE = '/private/tmp/uhm-mls-repair-local.jsonl';
const keys = new Set(['at', 'kind', 'path', 'method', 'http_status', 'reason', 'message', 'request_id', 'minimum_epoch',
  'deadline_at', 'epoch', 'is_stale', 'state', 'group_generation', 'current_epoch', 'incident_deadline_at', 'retryable',
  'source', 'cid', 'result', 'automatic_enabled', 'status', 'error_name', 'error_message', 'group_info_bytes', 'wire_prefix',
  'page_id', 'diagnostic_stack', 'message_id', 'request_message_id', 'msg_seq', 'last_event_seq', 'acceptance_context_present']);

// Served only by Vite in local development; never included in a production build.
const reproductionCapture = String.raw`
(() => {
  if (location.hostname !== 'localhost' || location.port !== '3001' || window.__uhmReproductionCapture) return;
  const originalFetch = window.fetch.bind(window), queue = [], page = crypto.randomUUID();
  let sending = false, emitted = 0, dropped = 0;
  const clean = value => String(value).replace(/Bearer\s+\S+|eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted]').replace(/[\w.+-]+@[\w.-]+\.[a-z]+/gi, '[email]').slice(0, 1500);
  const identifier = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,512}$/.test(value) ? value : undefined;
  const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const flush = async () => {
    if (sending) return;
    sending = true;
    try {
      while (queue.length) {
        const rows = queue.splice(0, 64), controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        try { await originalFetch('/__mls-repair-diagnostics', {method:'POST', credentials:'omit', headers:{'Content-Type':'application/json'}, body:JSON.stringify(rows), signal:controller.signal}); }
        catch { dropped += rows.length; }
        finally { clearTimeout(timeout); }
      }
    } finally { sending = false; }
  };
  const record = row => {
    if (emitted >= 10000 || queue.length >= 64) { dropped++; return; }
    emitted++; queue.push({at:new Date().toISOString(), page_id:page, ...row}); void flush();
  };
  const errorCategory = /Duplicate signature key in proposals and group\.?|Event-bound backend acceptance metadata is missing or invalid|Failed to send message over API|MLS registration unavailable|KeyPackageExpired|group_info_stale/i;
  for (const level of ['error','warn']) {
    const original = console[level];
    console[level] = function(...args) {
      try {
        for (const arg of args) {
          const text = typeof arg === 'string' ? arg : arg instanceof Error ? arg.message : '';
          const match = text.match(errorCategory);
          if (match) { record({kind:'reproduction_console', error_name:level, error_message:match[0], diagnostic_stack:clean((arg instanceof Error ? arg.stack : new Error().stack) || '')}); break; }
        }
      } catch {}
      return Reflect.apply(original, this, args);
    };
  }
  const contexts = new WeakMap(), originalOpen = XMLHttpRequest.prototype.open, originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(...args) {
    const result = Reflect.apply(originalOpen, this, args);
    try {
      const url = new URL(String(args[1]), location.href);
      if (['https://api-trieve.ermis.network','https://api-mac.khoakheu.pro'].includes(url.origin) && /^\/v1\/e2ee\//.test(url.pathname)) contexts.set(this, {path:url.pathname, method:String(args[0]).toUpperCase()});
      else contexts.delete(this);
    } catch { contexts.delete(this); }
    return result;
  };
  XMLHttpRequest.prototype.send = function(...args) {
    const context = contexts.get(this);
    if (context) {
      try {
        if (typeof args[0] === 'string' && args[0].length <= 131072) context.request_message_id = identifier(JSON.parse(args[0])?.message?.id);
      } catch {}
      this.addEventListener('loadend', () => {
        try {
          const row = {kind:'reproduction_http', ...context, http_status:this.status};
          const length = Number(this.getResponseHeader('Content-Length'));
          if ((!length || length <= 131072) && (!this.responseType || this.responseType === 'text') && this.responseText.length <= 131072) {
            const body = JSON.parse(this.responseText), message = body.message;
            if (message && typeof message === 'object') {
              row.message_id = identifier(message.id); row.msg_seq = integer(message.msg_seq); row.last_event_seq = integer(message.last_event_seq); row.epoch = integer(message.mls_epoch);
            }
            row.acceptance_context_present = !!(body.acceptance_context || body.protocol?.acceptance_context || body.data?.acceptance_context);
            if (typeof body.reason === 'string' && /^[a-z0-9_]{1,100}$/.test(body.reason)) row.reason = body.reason;
          }
          record(row);
        } catch { record({kind:'reproduction_http', ...context, http_status:this.status}); }
      }, {once:true});
    }
    return Reflect.apply(originalSend, this, args);
  };
  window.__uhmReproductionCapture = {page, status:() => ({emitted, dropped, pending:queue.length})};
  record({kind:'reproduction_capture_ready', source:'localhost:3001'});
})();`;

/** Same-origin, development-only receiver for allowlisted MLS repair summaries. */
export function mlsRepairCapture(): Plugin {
  return {
    name: 'uhm-local-mls-repair-capture', apply: 'serve',
    transformIndexHtml() {
      return [{tag:'script', attrs:{src:'/__mls-reproduction-capture.js'}, injectTo:'head-prepend'}];
    },
    configureServer(server) {
      server.middlewares.use('/__mls-reproduction-capture.js', (request, response) => {
        if (request.headers.host !== 'localhost:3001' || request.method !== 'GET') {
          response.statusCode = 403; response.end(); return;
        }
        response.setHeader('Content-Type', 'application/javascript');
        response.setHeader('Cache-Control', 'no-store');
        response.end(reproductionCapture);
      });
      server.middlewares.use('/__mls-repair-diagnostics', (request, response) => {
        const host = request.headers.host || '';
        if (!/^(localhost|127\.0\.0\.1):3001$/.test(host) || request.method !== 'POST' ||
            (request.headers.origin && request.headers.origin !== `http://${host}`)) {
          response.statusCode = 403; response.end(); return;
        }
        let body = '';
        request.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
          if (Buffer.byteLength(body) > 128 * 1024) request.destroy();
        });
        request.on('end', () => {
          void (async () => {
            try {
              const batch: unknown = JSON.parse(body);
              if (!Array.isArray(batch) || batch.length > 64) throw new Error('Invalid capture batch');
              const lines = batch.map((item) => {
                if (!item || typeof item !== 'object') throw new Error('Invalid capture record');
                const safe: Record<string, string | number | boolean | null> = {};
                for (const [key, value] of Object.entries(item)) {
                  if (!keys.has(key)) continue;
                  if (typeof value === 'string') safe[key] = value.replace(/Bearer\s+\S+/gi, '[redacted]')
                    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 2000);
                  else if (typeof value === 'number' || typeof value === 'boolean' || value === null) safe[key] = value;
                }
                return JSON.stringify(safe);
              });
              await appendFile(FILE, `${lines.join('\n')}\n`, { mode: 0o600 });
              response.statusCode = 204;
            } catch {
              response.statusCode = 400;
            }
            response.end();
          })();
        });
      });
    },
  };
}
