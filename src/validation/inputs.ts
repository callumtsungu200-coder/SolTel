import { z } from 'zod';
import { UserInputError } from '../utils/errors.js';

/** Parsing and validation of free-text user input. All functions throw UserInputError with a readable message. */

/** Parses "50000", "50k", "$1,250.5", "1.2m", "0.0042". */
export function parseAmount(raw: string): number {
  const s = raw.trim().toLowerCase().replace(/[$,\s_]/g, '');
  const m = /^(\d+(?:\.\d+)?|\.\d+)([kmb])?$/.exec(s);
  if (!m) throw new UserInputError(`"${raw.slice(0, 30)}" is not a valid number.`);
  const mult = m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : m[2] === 'b' ? 1e9 : 1;
  const n = Number(m[1]) * mult;
  if (!Number.isFinite(n)) throw new UserInputError('Number is out of range.');
  return n;
}

export function parseBounded(raw: string, schema: z.ZodNumber, what: string): number {
  const n = parseAmount(raw);
  const r = schema.safeParse(n);
  if (!r.success) {
    const min = schema.minValue;
    const max = schema.maxValue;
    throw new UserInputError(`${what} must be${min !== null && min !== undefined ? ` ≥ ${min}` : ''}${max !== null && max !== undefined && max < Number.MAX_SAFE_INTEGER ? ` and ≤ ${max}` : ''}.`);
  }
  return n;
}

export const labelSchema = z
  .string()
  .trim()
  .min(1, 'Label cannot be empty.')
  .max(48, 'Label must be 48 characters or fewer.')
  .refine((s) => !/[<>]/.test(s), 'Label cannot contain < or >.');

export function parseLabel(raw: string): string {
  const r = labelSchema.safeParse(raw);
  if (!r.success) throw new UserInputError(r.error.issues[0]?.message ?? 'Invalid label.');
  return r.data;
}

export function parseWalletActivityParams(raw: string): { direction: 'any' | 'incoming' | 'outgoing'; minSol: number } {
  const parts = raw.trim().toLowerCase().split(/\s+/);
  let direction: 'any' | 'incoming' | 'outgoing' = 'any';
  let amountPart: string | undefined;
  for (const p of parts) {
    if (p === 'any' || p === 'all') direction = 'any';
    else if (p === 'in' || p === 'incoming') direction = 'incoming';
    else if (p === 'out' || p === 'outgoing') direction = 'outgoing';
    else amountPart = p;
  }
  const minSol = amountPart === undefined ? 0 : parseBounded(amountPart, z.number().min(0).max(1_000_000), 'Minimum SOL');
  return { direction, minSol };
}

export function parsePriceMove(raw: string): { percent: number; direction: 'up' | 'down' | 'either' } {
  const parts = raw.trim().toLowerCase().replace('%', '').split(/\s+/);
  let direction: 'up' | 'down' | 'either' = 'either';
  let amount: string | undefined;
  for (const p of parts) {
    if (p === 'up' || p === '+') direction = 'up';
    else if (p === 'down' || p === '-') direction = 'down';
    else if (p === 'either' || p === 'any') direction = 'either';
    else amount = p.replace(/^\+/, '');
  }
  if (!amount) throw new UserInputError('Please include a percentage, e.g. "10" or "up 15".');
  return { percent: parseBounded(amount, z.number().min(0.5).max(10_000), 'Percentage'), direction };
}

export function parsePriceTarget(raw: string): { condition: 'above' | 'below'; price: number } {
  const m = /^\s*(above|below|>|<)\s*\$?\s*([\d.,]+[kmb]?)\s*$/i.exec(raw);
  if (!m) throw new UserInputError('Use the format "above 1.25" or "below 0.004".');
  const condition = m[1] === '>' || m[1]!.toLowerCase() === 'above' ? 'above' : 'below';
  return { condition, price: parseBounded(m[2]!, z.number().positive(), 'Target price') };
}

/** "22-7", "22 7", "off". Returns null for off. */
export function parseQuietHours(raw: string): { start: number; end: number } | null {
  const s = raw.trim().toLowerCase();
  if (s === 'off' || s === 'none' || s === '0') return null;
  const m = /^(\d{1,2})\s*[-–\s]\s*(\d{1,2})$/.exec(s);
  if (!m) throw new UserInputError('Use the format "22-7" (UTC hours) or "off".');
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (start > 23 || end > 23) throw new UserInputError('Hours must be between 0 and 23.');
  if (start === end) throw new UserInputError('Start and end hours must differ.');
  return { start, end };
}

/** Splits "<address> <rest>" input. */
export function splitFirstToken(raw: string): [string, string] {
  const t = raw.trim();
  const i = t.search(/\s/);
  return i === -1 ? [t, ''] : [t.slice(0, i), t.slice(i + 1).trim()];
}
