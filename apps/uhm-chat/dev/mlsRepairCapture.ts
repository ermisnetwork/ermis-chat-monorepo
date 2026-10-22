import { appendFile } from 'node:fs/promises';
import type { Plugin } from 'vite';

const FILE = '/private/tmp/uhm-mls-repair-local.jsonl';
const keys = new Set(['at', 'kind', 'path', 'method', 'http_status', 'reason', 'message', 'request_id', 'minimum_epoch',
  'deadline_at', 'epoch', 'is_stale', 'state', 'group_generation', 'current_epoch', 'incident_deadline_at', 'retryable',
  'source', 'cid', 'result', 'automatic_enabled', 'status', 'error_name', 'error_message', 'group_info_bytes', 'wire_prefix']);

/** Same-origin, development-only receiver for allowlisted MLS repair summaries. */
export function mlsRepairCapture(): Plugin {
  return {
    name: 'uhm-local-mls-repair-capture', apply: 'serve',
    configureServer(server) {
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
