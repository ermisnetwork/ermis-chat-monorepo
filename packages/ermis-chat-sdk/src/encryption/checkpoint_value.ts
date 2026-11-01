import {bytesEqual} from './aad';

/** Exact structured checkpoint equality, including bytes/dates and cyclic plain records. */
export function sameSyncCheckpointValue(a: unknown, b: unknown, seen = new WeakMap<object, object>()): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && Object.is(a.getTime(), b.getTime());
  if (a instanceof ArrayBuffer || b instanceof ArrayBuffer || ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (Object.prototype.toString.call(a) !== Object.prototype.toString.call(b)) return false;
    const bytes = (v: ArrayBuffer | ArrayBufferView) => v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    const left = bytes(a as ArrayBuffer | ArrayBufferView), right = bytes(b as ArrayBuffer | ArrayBufferView);
    return bytesEqual(left, right);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) { if (a.length !== b.length) return false; }
  else if (![Object.prototype, null].includes(Object.getPrototypeOf(a)) || ![Object.prototype, null].includes(Object.getPrototypeOf(b))) return false;
  if (seen.has(a)) return seen.get(a) === b;
  seen.set(a, b);
  const left = Object.keys(a), right = Object.keys(b);
  return left.length === right.length && left.every(key => Object.prototype.hasOwnProperty.call(b, key) &&
    sameSyncCheckpointValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], seen));
}
