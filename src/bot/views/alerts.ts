import { InlineKeyboard } from 'grammy';
import { ALERT_KIND_LABELS, describeAlert } from '../../alerts/definitions.js';
import type { AlertKind, AlertRow, NotificationRow } from '../../db/types.js';
import { escapeHtml, formatDate, relativeTime } from '../../utils/format.js';
import { addPager, paginate, withNav } from '../keyboards.js';
import type { View } from '../render.js';

/** Short codes keep callback data under Telegram's 64-byte limit. */
export const KIND_CODE: Record<AlertKind, string> = {
  wallet_activity: 'wa',
  large_transaction: 'lt',
  price_move: 'pm',
  price_target: 'pt',
  volume_spike: 'vs',
  liquidity_change: 'lc',
  token_activity: 'ta',
};
export const CODE_KIND: Record<string, AlertKind> = Object.fromEntries(Object.entries(KIND_CODE).map(([k, v]) => [v, k as AlertKind]));

export function alertsMenuView(alerts: AlertRow[], max: number): View {
  const active = alerts.filter((a) => a.is_active).length;
  return {
    text:
      `🔔 <b>Alert Management</b>\n\n${alerts.length}/${max} alerts · ${active} active\n\n` +
      'Alert types: tracked wallet activity, large transactions (whales), price movement, price target, volume spikes, liquidity changes and trading activity.\n\n' +
      '<i>Market alerts are checked every few minutes using DexScreener data; each alert has a cooldown to prevent repeated notifications.</i>',
    keyboard: withNav(
      new InlineKeyboard().text('📋 My alerts', 'al:list:0').text('➕ New alert', 'al:new').row().text('🕘 Alert history', 'al:hist:0').text('🔕 Notification settings', 'set'),
    ),
  };
}

export function alertListView(alerts: AlertRow[], page: number, pageSize: number): View {
  const pg = paginate(alerts, page, pageSize * 2);
  const lines = ['📋 <b>My alerts</b>', ''];
  if (alerts.length === 0) lines.push('No alerts yet. Tap ➕ New alert.');
  pg.items.forEach((a, i) => {
    lines.push(
      `${pg.page * pageSize * 2 + i + 1}. ${a.is_active ? '🟢' : '⏸'} ${ALERT_KIND_LABELS[a.kind]}\n   ${escapeHtml(describeAlert(a))}${a.last_triggered_at ? `\n   last fired ${relativeTime(Date.parse(a.last_triggered_at) / 1000)}` : ''}`,
    );
  });
  const kb = new InlineKeyboard();
  pg.items.forEach((a, i) => {
    kb.text(`${pg.page * pageSize * 2 + i + 1}. ${a.is_active ? '🟢' : '⏸'} ${ALERT_KIND_LABELS[a.kind].slice(3, 17)}`, `al:v:${a.id}`);
    if (i % 2 === 1) kb.row();
  });
  addPager(kb, 'al:list:', pg.page, pg.totalPages);
  kb.row().text('➕ New alert', 'al:new');
  return { text: lines.join('\n'), keyboard: withNav(kb, 'al') };
}

export function alertDetailView(a: AlertRow): View {
  const lines = [
    `${ALERT_KIND_LABELS[a.kind]}`,
    escapeHtml(describeAlert(a)),
    '',
    `Status: ${a.is_active ? '🟢 active' : '⏸ paused'}`,
    `Cooldown: ${a.cooldown_minutes} min`,
    `Triggered: ${a.trigger_count} time(s)${a.last_triggered_at ? `, last ${formatDate(Date.parse(a.last_triggered_at) / 1000)}` : ''}`,
    `Created: ${formatDate(Date.parse(a.created_at) / 1000)}`,
  ];
  const kb = new InlineKeyboard()
    .text(a.is_active ? '⏸ Pause' : '▶️ Activate', `al:tog:${a.id}`)
    .text('✏️ Edit threshold', `al:edit:${a.id}`)
    .row()
    .text('⏱ Cooldown', `al:cd:${a.id}`)
    .text('🗑 Delete', `al:del:${a.id}`);
  return { text: lines.join('\n'), keyboard: withNav(kb, 'al:list:0') };
}

export const COOLDOWN_OPTIONS = [5, 15, 30, 60, 180, 720, 1440];

export function cooldownView(a: AlertRow): View {
  const kb = new InlineKeyboard();
  COOLDOWN_OPTIONS.forEach((m, i) => {
    kb.text(`${m === a.cooldown_minutes ? '• ' : ''}${m < 60 ? `${m}m` : `${m / 60}h`}`, `al:cds:${a.id}:${m}`);
    if (i % 4 === 3) kb.row();
  });
  return { text: `⏱ Choose a cooldown for:\n${escapeHtml(describeAlert(a))}`, keyboard: withNav(kb, `al:v:${a.id}`) };
}

export function newAlertMenuView(): View {
  const kb = new InlineKeyboard()
    .text(ALERT_KIND_LABELS.wallet_activity, 'al:nk:wa')
    .text(ALERT_KIND_LABELS.large_transaction, 'al:nk:lt')
    .row()
    .text(ALERT_KIND_LABELS.price_move, 'al:nk:pm')
    .text(ALERT_KIND_LABELS.price_target, 'al:nk:pt')
    .row()
    .text(ALERT_KIND_LABELS.volume_spike, 'al:nk:vs')
    .text(ALERT_KIND_LABELS.liquidity_change, 'al:nk:lc')
    .row()
    .text(ALERT_KIND_LABELS.token_activity, 'al:nk:ta');
  return { text: '➕ <b>New alert</b>\nChoose the alert type:', keyboard: withNav(kb, 'al') };
}

export function tokenAlertMenuView(mint: string, symbol: string): View {
  const kb = new InlineKeyboard()
    .text(ALERT_KIND_LABELS.price_move, `al:nk:pm:${mint}`)
    .text(ALERT_KIND_LABELS.price_target, `al:nk:pt:${mint}`)
    .row()
    .text(ALERT_KIND_LABELS.volume_spike, `al:nk:vs:${mint}`)
    .text(ALERT_KIND_LABELS.liquidity_change, `al:nk:lc:${mint}`)
    .row()
    .text(ALERT_KIND_LABELS.token_activity, `al:nk:ta:${mint}`)
    .text(ALERT_KIND_LABELS.large_transaction, `al:nk:lt:${mint}`);
  return { text: `🔔 <b>Create an alert for ${escapeHtml(symbol)}</b>`, keyboard: withNav(kb, `tok:p:${mint}`) };
}

export const PARAM_PROMPTS: Record<AlertKind, string> = {
  wallet_activity: 'Send the direction and minimum SOL, e.g. <code>any 0</code>, <code>in 5</code> or <code>out 10</code>.',
  large_transaction: 'Send the minimum USD value per transfer, e.g. <code>50000</code>.',
  price_move: 'Send the percentage move, optionally with a direction: <code>10</code>, <code>up 15</code> or <code>down 20</code>.',
  price_target: 'Send the condition and price, e.g. <code>above 1.25</code> or <code>below 0.0042</code>.',
  volume_spike: 'Send the multiplier of last-hour volume vs the 24h hourly average, e.g. <code>3</code>.',
  liquidity_change: 'Send the liquidity change percentage, e.g. <code>20</code>.',
  token_activity: 'Send the multiplier of last-hour trade count vs the 24h hourly average, e.g. <code>3</code>.',
};

export function alertHistoryView(rows: NotificationRow[], total: number, page: number, pageSize: number): View {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const lines = [`🕘 <b>Alert history</b> (${total})`, ''];
  if (rows.length === 0) lines.push('No notifications yet.');
  for (const r of rows) {
    const status = r.delivered ? '✅' : r.error?.startsWith('suppressed') ? '🌙' : '⚠️';
    const firstLine = r.message.split('\n')[0]!.replace(/<[^>]+>/g, '');
    lines.push(`${status} ${formatDate(Date.parse(r.created_at) / 1000)} · ${escapeHtml(firstLine.slice(0, 90))}`);
  }
  lines.push('', '<i>✅ delivered · 🌙 quiet hours · ⚠️ failed</i>');
  return { text: lines.join('\n'), keyboard: withNav(addPager(new InlineKeyboard(), 'al:hist:', page, totalPages), 'al') };
}
