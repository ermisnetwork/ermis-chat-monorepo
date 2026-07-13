import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

function toBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

export class Sha256 {
  private hasher = sha256.create();
  private finished = false;

  update(data: Uint8Array | ArrayBuffer): this {
    if (this.finished) throw new Error('SHA-256 digest already finalized');
    this.hasher.update(toBytes(data));
    return this;
  }

  digest(): Uint8Array {
    if (this.finished) throw new Error('SHA-256 digest already finalized');
    this.finished = true;
    return this.hasher.digest();
  }

  hex(): string {
    return bytesToHex(this.digest());
  }
}

export function sha256Hex(data: Uint8Array | ArrayBuffer): string {
  return new Sha256().update(data).hex();
}
