import { InlineKeyboard } from 'grammy';

/** Inline keyboard builders. Callback data must stay ≤ 64 bytes. */

export const MAIN_MENU_ITEMS: Array<[string, string]> = [
  ['👛 Wallet Intelligence', 'wal'],
  ['🪙 Token Intelligence', 'tok'],
  ['🔥 Trending Tokens', 'trd:volume:0'],
  ['🧾 Transaction Monitor', 'txm'],
  ['⭐ Watchlists', 'wls'],
  ['📊 Portfolio Analytics', 'pf'],
  ['🔔 Alert Management', 'al'],
  ['⚙️ Settings', 'set'],
];

export function mainMenuKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  MAIN_MENU_ITEMS.forEach(([label, data], i) => {
    kb.text(label, data);
    if (i % 2 === 1) kb.row();
  });
  return kb;
}

/** Appends the standard "back / main menu" row. */
export function withNav(kb: InlineKeyboard, back?: string): InlineKeyboard {
  kb.row();
  if (back) kb.text('⬅️ Back', back);
  kb.text('🏠 Main menu', 'menu');
  return kb;
}

export function navOnly(back?: string): InlineKeyboard {
  return withNav(new InlineKeyboard(), back);
}

export interface Page<T> {
  items: T[];
  page: number;
  totalPages: number;
  total: number;
}

export function paginate<T>(all: T[], page: number, pageSize: number): Page<T> {
  const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
  const p = Math.min(Math.max(0, page), totalPages - 1);
  return { items: all.slice(p * pageSize, p * pageSize + pageSize), page: p, totalPages, total: all.length };
}

/** Adds ◀️ n/N ▶️ controls. `prefix` gets the page number appended. */
export function addPager(kb: InlineKeyboard, prefix: string, page: number, totalPages: number): InlineKeyboard {
  if (totalPages <= 1) return kb;
  kb.row();
  if (page > 0) kb.text('◀️', `${prefix}${page - 1}`);
  kb.text(`${page + 1}/${totalPages}`, 'noop');
  if (page < totalPages - 1) kb.text('▶️', `${prefix}${page + 1}`);
  return kb;
}
