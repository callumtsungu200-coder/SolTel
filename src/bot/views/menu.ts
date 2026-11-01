import { InlineKeyboard } from 'grammy';
import { escapeHtml } from '../../utils/format.js';
import { mainMenuKeyboard, navOnly } from '../keyboards.js';
import type { View } from '../render.js';

export function mainMenuView(firstName?: string | null): View {
  return {
    text:
      `🧠 <b>Solana Intelligence Dashboard</b>${firstName ? `\nWelcome, ${escapeHtml(firstName)}.` : ''}\n\n` +
      'Research wallets and tokens with live on-chain and market data, track public wallets, and get alerts.\n\n' +
      '💡 Tip: paste any wallet address, token mint or transaction signature at any time.\n\n' +
      '<i>Read-only analytics. This bot never asks for private keys or seed phrases and never trades. Nothing here is financial advice.</i>',
    keyboard: mainMenuKeyboard(),
  };
}

export function helpView(): View {
  return {
    text: [
      '📖 <b>Help</b>',
      '',
      '<b>Commands</b>',
      '/start, /menu — main dashboard',
      '/wallet &lt;address&gt; — wallet profile',
      '/token &lt;mint&gt; — token research report',
      '/tx &lt;signature&gt; — transaction details',
      '/trending — trending token explorer',
      '/track &lt;address&gt; [label] — track a wallet',
      '/watch &lt;mint&gt; — add a token to your watchlist',
      '/portfolio — portfolio analytics of tracked wallets',
      '/whales — whale activity monitor',
      '/alerts — manage alerts',
      '/settings — preferences',
      '/methodology — how scores and estimates are calculated',
      '/cancel — cancel the current input',
      '',
      '<b>Data labels</b>',
      '✅ verified — read directly from the Solana blockchain',
      '📈 market — reported by DexScreener / GeckoTerminal',
      '📐 estimate — calculated by this bot',
      '❔ unavailable — the data source has no value',
      '',
      '<b>Safety</b>',
      '• Only public addresses are used. Never share a private key or seed phrase with anyone.',
      '• "Swap" appears only when the data provider classified a transaction as a swap; transfers are never called buys or sells.',
      '• Trending lists and scores are informational, not recommendations.',
    ].join('\n'),
    keyboard: navOnly(),
  };
}

export function methodologyView(): View {
  return {
    text: [
      '📐 <b>Methodology</b>',
      '',
      '<b>Wallet Activity Score (0–100)</b> — describes observed activity only; it does not measure skill, trust or profitability and does not predict returns.',
      '• Frequency (35): log-scaled transactions/day in the sampled window',
      '• Recency (20): time since the latest transaction',
      '• Counterparties (20): log-scaled unique addresses interacted with',
      '• Token breadth (15): distinct tokens moved (cap 20)',
      '• Longevity (10): wallet age, 1 point per 36.5 days',
      '',
      '<b>Portfolio value</b> = on-chain balances × current DEX price of the deepest pool. Pools under $1,000 liquidity are excluded from valuation. Value changes are split into a price effect and a quantity effect; neither is realised profit.',
      '',
      '<b>Volatility</b> = standard deviation of daily log returns × √365 (GeckoTerminal daily candles). <b>Max drawdown</b> = largest peak-to-trough fall in the window.',
      '',
      '<b>Unusual volume</b>: last-hour volume ÷ (24h volume ÷ 24) ≥ 3, or latest daily volume z-score ≥ 2.5 vs prior days.',
      '',
      '<b>Holder concentration</b>: share of supply in the 20 largest token accounts (RPC). Pools, exchanges and burn accounts are included, so this overstates individual concentration.',
      '',
      '<b>Whale events</b>: transfers valued at current price above your threshold. A large transfer is not necessarily a purchase or a sale.',
    ].join('\n'),
    keyboard: navOnly(),
  };
}

export function errorView(message: string): View {
  return { text: `⚠️ ${escapeHtml(message)}`, keyboard: navOnly() };
}

export function promptView(text: string, back?: string): View {
  return { text: `${text}\n\n<i>Send /cancel to stop.</i>`, keyboard: new InlineKeyboard().text('✖️ Cancel', back ?? 'menu') };
}
