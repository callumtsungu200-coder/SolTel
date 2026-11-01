import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  base58Decode,
  base58Encode,
  extractAddress,
  extractSignature,
  isValidSignature,
  isValidSolanaAddress,
  USDC_MINT,
  WSOL_MINT,
} from '../../src/validation/address.js';
import {
  parseAmount,
  parseLabel,
  parsePriceMove,
  parsePriceTarget,
  parseQuietHours,
  parseWalletActivityParams,
  splitFirstToken,
} from '../../src/validation/inputs.js';
import { containsSecret, isSecretKeyBytes } from '../../src/validation/secrets.js';
import { UserInputError } from '../../src/utils/errors.js';
import { WALLET } from '../fixtures/index.js';

describe('wallet address validation', () => {
  it('accepts real mainnet addresses', () => {
    for (const a of [WALLET, USDC_MINT, WSOL_MINT, '11111111111111111111111111111111', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN']) {
      expect(isValidSolanaAddress(a), a).toBe(true);
    }
  });

  it('rejects malformed input', () => {
    expect(isValidSolanaAddress('')).toBe(false);
    expect(isValidSolanaAddress('hello')).toBe(false);
    // Invalid base58 characters: 0, O, I, l
    expect(isValidSolanaAddress('0' + WALLET.slice(1))).toBe(false);
    expect(isValidSolanaAddress('O' + WALLET.slice(1))).toBe(false);
    expect(isValidSolanaAddress(WALLET.slice(0, -1) + 'l')).toBe(false);
    // Right charset, wrong byte length
    expect(isValidSolanaAddress(base58Encode(randomBytes(31)).padStart(32, '2'))).toBe(false);
    expect(isValidSolanaAddress(base58Encode(randomBytes(33)))).toBe(false);
    // Ethereum address
    expect(isValidSolanaAddress('0x742d35Cc6634C0532925a3b844Bc454e4438f44e')).toBe(false);
  });

  it('trims surrounding whitespace', () => {
    expect(isValidSolanaAddress(`  ${WALLET}\n`)).toBe(true);
  });

  it('round-trips base58 including leading zero bytes', () => {
    for (let i = 0; i < 50; i++) {
      const bytes = randomBytes(32);
      if (i % 5 === 0) bytes[0] = 0;
      if (i % 10 === 0) bytes[1] = 0;
      const enc = base58Encode(bytes);
      expect(Buffer.from(base58Decode(enc)!)).toEqual(bytes);
    }
    expect(Array.from(base58Decode('11111111111111111111111111111111')!)).toEqual(new Array(32).fill(0));
  });

  it('validates signatures as 64-byte values', () => {
    const s = base58Encode(randomBytes(64));
    expect(isValidSignature(s)).toBe(true);
    expect(isValidSignature(WALLET)).toBe(false);
  });

  it('extracts addresses and signatures from pasted links', () => {
    expect(extractAddress(`https://solscan.io/account/${WALLET}?cluster=mainnet`)).toBe(WALLET);
    const s = base58Encode(randomBytes(64));
    expect(extractSignature(`https://solscan.io/tx/${s}`)).toBe(s);
    expect(extractAddress('no address here')).toBeNull();
  });
});

describe('secret detection (never forward private keys)', () => {
  function solanaSecretKey(): Uint8Array {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
    const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    return Uint8Array.from([...seed, ...pub]);
  }

  it('detects a base58 64-byte keypair even though it looks like a signature', () => {
    const sk = solanaSecretKey();
    expect(isSecretKeyBytes(sk)).toBe(true);
    const encoded = base58Encode(sk);
    expect(isValidSignature(encoded)).toBe(true); // same shape as a signature…
    expect(containsSecret(encoded)).toBe(true); // …but identified as a secret
    expect(containsSecret(`/tx ${encoded}`)).toBe(true);
  });

  it('does not flag real signatures or addresses', () => {
    for (let i = 0; i < 20; i++) expect(containsSecret(base58Encode(randomBytes(64)))).toBe(false);
    expect(containsSecret(WALLET)).toBe(false);
  });

  it('detects JSON byte-array keys and seed phrases', () => {
    expect(containsSecret(JSON.stringify(Array.from(solanaSecretKey())))).toBe(true);
    expect(containsSecret('abandon ability able about above absent absorb abstract absurd abuse access accident')).toBe(true);
    expect(containsSecret('what is the price of bonk today please')).toBe(false);
  });
});

describe('user input parsing', () => {
  it('parses amounts with suffixes and separators', () => {
    expect(parseAmount('50000')).toBe(50000);
    expect(parseAmount('50k')).toBe(50000);
    expect(parseAmount('$1,250.5')).toBe(1250.5);
    expect(parseAmount('1.2m')).toBeCloseTo(1_200_000);
    expect(parseAmount('.5')).toBe(0.5);
    expect(() => parseAmount('abc')).toThrow(UserInputError);
    expect(() => parseAmount('-5')).toThrow(UserInputError);
  });

  it('parses alert parameter grammars', () => {
    expect(parseWalletActivityParams('in 5')).toEqual({ direction: 'incoming', minSol: 5 });
    expect(parseWalletActivityParams('out')).toEqual({ direction: 'outgoing', minSol: 0 });
    expect(parseWalletActivityParams('any 0.5')).toEqual({ direction: 'any', minSol: 0.5 });
    expect(parsePriceMove('10')).toEqual({ percent: 10, direction: 'either' });
    expect(parsePriceMove('up 15%')).toEqual({ percent: 15, direction: 'up' });
    expect(() => parsePriceMove('up')).toThrow(UserInputError);
    expect(() => parsePriceMove('0.1')).toThrow(/Percentage/);
    expect(parsePriceTarget('above 1.25')).toEqual({ condition: 'above', price: 1.25 });
    expect(parsePriceTarget('< $0.004')).toEqual({ condition: 'below', price: 0.004 });
    expect(() => parsePriceTarget('1.25')).toThrow(UserInputError);
  });

  it('parses quiet hours and labels', () => {
    expect(parseQuietHours('22-7')).toEqual({ start: 22, end: 7 });
    expect(parseQuietHours('off')).toBeNull();
    expect(() => parseQuietHours('25-3')).toThrow(UserInputError);
    expect(() => parseQuietHours('5-5')).toThrow(UserInputError);
    expect(parseLabel('  Treasury  ')).toBe('Treasury');
    expect(() => parseLabel('')).toThrow(UserInputError);
    expect(() => parseLabel('<b>x</b>')).toThrow(UserInputError);
    expect(() => parseLabel('x'.repeat(49))).toThrow(UserInputError);
    expect(splitFirstToken(`${WALLET} My main`)).toEqual([WALLET, 'My main']);
  });
});
