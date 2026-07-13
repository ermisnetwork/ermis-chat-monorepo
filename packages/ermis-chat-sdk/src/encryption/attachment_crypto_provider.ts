import { Sha256 } from './sha256';

export interface E2eeAttachmentHash {
  update(data: Uint8Array | ArrayBuffer): this;
  digest(): Uint8Array;
  hex(): string;
}

export interface E2eeAttachmentCryptoProvider {
  randomBytes(length: number): Uint8Array;
  generateAesGcmKey(): Promise<Uint8Array> | Uint8Array;
  aesGcmEncrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array>;
  aesGcmDecrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array>;
  createSha256(): E2eeAttachmentHash;
}

function getWebCrypto(): Crypto {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.subtle || !cryptoObj.getRandomValues) {
    throw new Error(
      'Web Crypto API is required for the default E2EE attachment provider. React Native must inject attachmentCryptoProvider.',
    );
  }
  return cryptoObj;
}

function arrayBufferFrom(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

async function importAesGcmKey(key: Uint8Array): Promise<CryptoKey> {
  return await getWebCrypto().subtle.importKey('raw', arrayBufferFrom(key), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export const webE2eeAttachmentCryptoProvider: E2eeAttachmentCryptoProvider = {
  randomBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    getWebCrypto().getRandomValues(bytes);
    return bytes;
  },

  generateAesGcmKey(): Uint8Array {
    return this.randomBytes(32);
  },

  async aesGcmEncrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
    const cryptoKey = await importAesGcmKey(key);
    return new Uint8Array(
      await getWebCrypto().subtle.encrypt({ name: 'AES-GCM', iv: arrayBufferFrom(nonce) }, cryptoKey, arrayBufferFrom(plaintext)),
    );
  },

  async aesGcmDecrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
    const cryptoKey = await importAesGcmKey(key);
    return new Uint8Array(
      await getWebCrypto().subtle.decrypt(
        { name: 'AES-GCM', iv: arrayBufferFrom(nonce) },
        cryptoKey,
        arrayBufferFrom(ciphertext),
      ),
    );
  },

  createSha256(): E2eeAttachmentHash {
    return new Sha256();
  },
};

export const defaultE2eeAttachmentCryptoProvider = webE2eeAttachmentCryptoProvider;
