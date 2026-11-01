import { z } from 'zod';
import type { AlertKind, AlertRow } from '../db/types.js';
import { formatPrice, formatSol, formatUsd, shortAddr } from '../utils/format.js';
import { isValidSolanaAddress } from '../validation/address.js';

/** Zod schemas for alert parameters, one per alert kind. Stored as JSONB in alerts.params. */

const address = z.string().refine(isValidSolanaAddress, 'invalid Solana address');
const symbol = z.string().max(32).default('');

export const alertParamSchemas = {
  wallet_activity: z.object({
    walletId: z.uuid(),
    address,
    label: z.string().max(48),
    direction: z.enum(['any', 'incoming', 'outgoing']).default('any'),
    minSol: z.number().min(0).max(1_000_000).default(0),
  }),
  large_transaction: z.object({
    target: z.enum(['token', 'wallet']),
    address,
    symbol,
    minUsd: z.number().min(100).max(1_000_000_000),
  }),
  price_move: z.object({
    mint: address,
    symbol,
    percent: z.number().min(0.5).max(10_000),
    direction: z.enum(['up', 'down', 'either']).default('either'),
  }),
  price_target: z.object({
    mint: address,
    symbol,
    condition: z.enum(['above', 'below']),
    price: z.number().positive(),
  }),
  volume_spike: z.object({
    mint: address,
    symbol,
    multiplier: z.number().min(1.5).max(100),
  }),
  liquidity_change: z.object({
    mint: address,
    symbol,
    percent: z.number().min(1).max(1000),
  }),
  token_activity: z.object({
    mint: address,
    symbol,
    multiplier: z.number().min(1.5).max(100),
  }),
} satisfies Record<AlertKind, z.ZodType>;

export type AlertParams<K extends AlertKind> = z.infer<(typeof alertParamSchemas)[K]>;

export const MARKET_ALERT_KINDS: AlertKind[] = ['price_move', 'price_target', 'volume_spike', 'liquidity_change', 'token_activity'];

export const ALERT_KIND_LABELS: Record<AlertKind, string> = {
  wallet_activity: '👛 Wallet activity',
  large_transaction: '🐋 Large transaction',
  price_move: '📈 Price movement',
  price_target: '🎯 Price target',
  volume_spike: '📊 Volume spike',
  liquidity_change: '💧 Liquidity change',
  token_activity: '⚡ Token activity',
};

/** Default cooldowns (minutes) — prevent alert storms on volatile tokens. */
export const DEFAULT_COOLDOWN: Record<AlertKind, number> = {
  wallet_activity: 1,
  large_transaction: 1,
  price_move: 30,
  price_target: 60,
  volume_spike: 120,
  liquidity_change: 60,
  token_activity: 120,
};

export function parseAlertParams<K extends AlertKind>(kind: K, params: unknown): AlertParams<K> | null {
  const r = alertParamSchemas[kind].safeParse(params);
  return r.success ? (r.data as AlertParams<K>) : null;
}

/** One-line human description of an alert. */
export function describeAlert(a: Pick<AlertRow, 'kind' | 'params'>): string {
  const p = a.params as Record<string, unknown>;
  const sym = (p.symbol as string) || shortAddr(String(p.mint ?? p.address ?? ''));
  switch (a.kind) {
    case 'wallet_activity': {
      const dir = p.direction === 'any' ? 'any' : String(p.direction);
      const min = Number(p.minSol) > 0 ? ` ≥ ${formatSol(Number(p.minSol))}` : '';
      return `${p.label as string}: ${dir} activity${min}`;
    }
    case 'large_transaction':
      return `${p.target === 'token' ? 'Token' : 'Wallet'} ${sym}: transfers/swaps ≥ ${formatUsd(Number(p.minUsd))}`;
    case 'price_move':
      return `${sym}: price ${p.direction === 'either' ? 'moves' : p.direction === 'up' ? 'rises' : 'falls'} ${Number(p.percent)}%`;
    case 'price_target':
      return `${sym}: price ${p.condition as string} ${formatPrice(Number(p.price))}`;
    case 'volume_spike':
      return `${sym}: 1h volume ≥ ${Number(p.multiplier)}× hourly average`;
    case 'liquidity_change':
      return `${sym}: liquidity changes ±${Number(p.percent)}%`;
    case 'token_activity':
      return `${sym}: 1h trade count ≥ ${Number(p.multiplier)}× hourly average`;
  }
}

/** Which numeric parameter the "edit" flow changes for each kind. */
export const EDITABLE_FIELD: Record<AlertKind, { key: string; prompt: string; schema: z.ZodNumber }> = {
  wallet_activity: { key: 'minSol', prompt: 'Send the new minimum SOL amount (0 = any amount):', schema: z.number().min(0).max(1_000_000) },
  large_transaction: { key: 'minUsd', prompt: 'Send the new minimum USD value (≥ 100):', schema: z.number().min(100).max(1_000_000_000) },
  price_move: { key: 'percent', prompt: 'Send the new percentage move (e.g. 10):', schema: z.number().min(0.5).max(10_000) },
  price_target: { key: 'price', prompt: 'Send the new target price in USD:', schema: z.number().positive() },
  volume_spike: { key: 'multiplier', prompt: 'Send the new multiplier (e.g. 3 = 3× hourly average):', schema: z.number().min(1.5).max(100) },
  liquidity_change: { key: 'percent', prompt: 'Send the new percentage change (e.g. 20):', schema: z.number().min(1).max(1000) },
  token_activity: { key: 'multiplier', prompt: 'Send the new multiplier (e.g. 3):', schema: z.number().min(1.5).max(100) },
};
