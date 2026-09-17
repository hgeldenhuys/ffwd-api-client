/**
 * Secret value encryption at rest: AES-256-GCM via WebCrypto.
 * Key: SECRETS_MASTER_KEY (32 bytes, base64). Random 12-byte nonce per write.
 * Ciphertext + nonce stored separately; name and scope used as AAD.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function aad(scope: string, scopeId: string, name: string): Uint8Array {
  return encoder.encode(`${scope}\u0000${scopeId}\u0000${name}`);
}

async function importKey(masterKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", masterKey as unknown as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export interface SealedSecret {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
}

export async function sealSecret(
  masterKey: Uint8Array,
  scope: string,
  scopeId: string,
  name: string,
  value: string
): Promise<SealedSecret> {
  const key = await importKey(masterKey);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as unknown as BufferSource, additionalData: aad(scope, scopeId, name) as unknown as BufferSource },
      key,
      encoder.encode(value) as unknown as BufferSource
    )
  );
  return { ciphertext, nonce };
}

export async function openSecret(
  masterKey: Uint8Array,
  scope: string,
  scopeId: string,
  name: string,
  sealed: SealedSecret
): Promise<string> {
  const key = await importKey(masterKey);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: sealed.nonce as unknown as BufferSource, additionalData: aad(scope, scopeId, name) as unknown as BufferSource },
    key,
    sealed.ciphertext as unknown as BufferSource
  );
  return decoder.decode(plain);
}
