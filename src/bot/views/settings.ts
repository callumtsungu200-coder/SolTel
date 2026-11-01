import { InlineKeyboard } from 'grammy';
import type { PreferencesRow } from '../../db/types.js';
import { formatSol, formatUsd } from '../../utils/format.js';
import { withNav } from '../keyboards.js';
import type { View } from '../render.js';

const onOff = (b: boolean) => (b ? '✅' : '⬜');

export function settingsView(p: PreferencesRow): View {
  const quiet = p.quiet_hours_start !== null && p.quiet_hours_end !== null ? `${p.quiet_hours_start}:00–${p.quiet_hours_end}:00 UTC` : 'off';
  const text = [
    '⚙️ <b>Settings</b>',
    '',
    `Notifications: ${p.notifications_enabled ? 'on' : 'off'}`,
    `Tracked wallet activity: ${p.notify_wallet_activity ? 'on' : 'off'} (min ${formatSol(p.min_notify_sol)})`,
    `Holding change alerts: ${p.notify_holdings_changes ? 'on' : 'off'} (≥ ${p.holding_change_pct}%)`,
    `Default whale threshold: ${formatUsd(p.whale_threshold_usd)}`,
    `Quiet hours: ${quiet}`,
    `Items per page: ${p.page_size}`,
    `Trending filters: liquidity ≥ ${formatUsd(p.trending_min_liquidity)}, volume ≥ ${formatUsd(p.trending_min_volume)}`,
    '',
    '<i>Settings are stored in your account and apply immediately.</i>',
  ].join('\n');
  const kb = new InlineKeyboard()
    .text(`${onOff(p.notifications_enabled)} All notifications`, 'set:t:notifications_enabled')
    .row()
    .text(`${onOff(p.notify_wallet_activity)} Wallet activity`, 'set:t:notify_wallet_activity')
    .text(`${onOff(p.notify_holdings_changes)} Holding changes`, 'set:t:notify_holdings_changes')
    .row()
    .text('💰 Min SOL to notify', 'set:n:min_notify_sol')
    .text('📦 Holding change %', 'set:n:holding_change_pct')
    .row()
    .text('🐋 Whale threshold', 'set:whale')
    .text('🌙 Quiet hours', 'set:quiet')
    .row()
    .text('📄 Page size', 'set:pg')
    .text('🎚 Trending filters', 'trd:f')
    .row()
    .text('📐 Methodology', 'methodology');
  return { text, keyboard: withNav(kb) };
}

export function pageSizeView(current: number): View {
  const kb = new InlineKeyboard();
  [3, 5, 8, 10, 15].forEach((n) => kb.text(`${n === current ? '• ' : ''}${n}`, `set:pgs:${n}`));
  return { text: '📄 Items per page:', keyboard: withNav(kb, 'set') };
}
