import { createPrivateKey, createPublicKey } from 'node:crypto';
import { base58Decode } from './address.js';

/**
 * Detection of pasted wallet secrets, so they are never forwarded to any API.
 *
 * A Solana keypair secret is 64 bytes: a 32-byte ed25519 seed followed by the
 * 32-byte public key. Encoded in base58 it looks exactly like a transaction
 * signature, so shape alone cannot tell them apart. We derive the public key
 * from the first half and compare it to the second half — a match means the
 * input is a private key.
 */

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function ed25519PublicFromSeed(seed: Uint8Array): Buffer {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
  return spki.subarray(spki.length - 32);
}

export function isSecretKeyBytes(bytes: Uint8Array): boolean {
  if (bytes.length !== 64) return false;
  try {
    return ed25519PublicFromSeed(bytes.subarray(0, 32)).equals(Buffer.from(bytes.subarray(32)));
  } catch {
    return false;
  }
}

const MNEMONIC_WORD = /^[a-z]{3,8}$/;

/** True when the text contains something that looks like a private key or seed phrase. */
export function containsSecret(text: string): boolean {
  const t = text.trim();
  // JSON byte array (solana-keygen format).
  const arr = /\[\s*\d{1,3}(?:\s*,\s*\d{1,3}){31,}\s*\]/.exec(t);
  if (arr) {
    const bytes = JSON.parse(arr[0]) as number[];
    if (bytes.length === 64 || bytes.length === 32) return true;
  }
  // Base58 64-byte secret keys hidden anywhere in the text.
  for (const candidate of t.match(/[1-9A-HJ-NP-Za-km-z]{80,90}/g) ?? []) {
    const bytes = base58Decode(candidate);
    if (bytes && isSecretKeyBytes(bytes)) return true;
  }
  // BIP39 mnemonic: 12–24 short lowercase words.
  const words = t.toLowerCase().split(/\s+/);
  if ([12, 15, 18, 21, 24].includes(words.length) && words.every((w) => MNEMONIC_WORD.test(w))) return true;
  return false;
}
