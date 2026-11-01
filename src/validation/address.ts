/**
 * Solana address / signature validation.
 *
 * Solana public keys are 32 bytes encoded with Bitcoin-alphabet base58
 * (32–44 characters). Transaction signatures are 64 bytes (usually 87–88
 * characters). We decode fully rather than relying on a length regex, so
 * strings with the right length but wrong byte size are rejected.
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = new Map<string, number>([...ALPHABET].map((c, i) => [c, i]));

export function base58Decode(input: string): Uint8Array | null {
  if (input.length === 0) return null;
  // Little-endian accumulator of the big base-58 number.
  const bytes: number[] = [];
  for (const ch of input) {
    const value = MAP.get(ch);
    if (value === undefined) return null;
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Each leading '1' encodes one leading zero byte.
  let zeros = 0;
  while (zeros < input.length && input[zeros] === '1') zeros++;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes.reverse()]);
}

export function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = '';
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out += '1';
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!];
  return out;
}

export function isValidSolanaAddress(value: string): boolean {
  const v = value.trim();
  if (v.length < 32 || v.length > 44) return false;
  return base58Decode(v)?.length === 32;
}

export function isValidSignature(value: string): boolean {
  const v = value.trim();
  if (v.length < 64 || v.length > 90) return false;
  return base58Decode(v)?.length === 64;
}

/** Extracts the first Solana address-looking token from free text (e.g. a pasted Solscan URL). */
export function extractAddress(text: string): string | null {
  const candidates = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) ?? [];
  return candidates.find(isValidSolanaAddress) ?? null;
}

export function extractSignature(text: string): string | null {
  const candidates = text.match(/[1-9A-HJ-NP-Za-km-z]{64,90}/g) ?? [];
  return candidates.find(isValidSignature) ?? null;
}

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
