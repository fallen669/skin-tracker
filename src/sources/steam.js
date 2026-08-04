import { config } from '../config.js';

const BASE = 'https://steamcommunity.com/market/priceoverview/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Steam has no bulk price endpoint — it is one HTTP call per item, and it
 * starts returning 429 somewhere north of ~20 requests/minute. So this polls a
 * small rotating slice per cycle rather than trying to cover the catalogue.
 *
 * Steam is reference data only: wallet funds cannot be withdrawn, so a "spread"
 * against Steam is not realisable cash. It is useful as a sanity check on
 * whether a third-party price is genuinely below fair value.
 */
function parsePrice(str) {
  if (typeof str !== 'string') return null;
  // "$43.12" / "3 413,38 руб." / "43,12€" -> strip everything but digits and separators
  const cleaned = str.replace(/[^\d.,]/g, '').replace(/\s/g, '');
  if (!cleaned) return null;
  // Whichever separator appears last is the decimal one.
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalised;
  if (lastComma > lastDot) {
    normalised = cleaned.replace(/\./g, '').replace(',', '.');
  } else {
    normalised = cleaned.replace(/,/g, '');
  }
  const n = Number(normalised);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function fetchOne(name) {
  const url = `${BASE}?appid=730&currency=${config.steam.currency}` +
    `&market_hash_name=${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'skin-tracker/0.1 (personal price research)' },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 429) return { rateLimited: true };
  if (!res.ok) return null;

  const body = await res.json().catch(() => null);
  if (!body?.success) return null;

  const price = parsePrice(body.lowest_price ?? body.median_price);
  if (price === null) return null;

  return {
    name,
    price,
    quantity: Number.parseInt(String(body.volume ?? '0').replace(/\D/g, ''), 10) || 0,
  };
}

/**
 * @param names  candidate item names, already filtered to the universe
 * @param cursor rotating offset so successive cycles cover different items
 */
export async function fetchSteamSlice(names, cursor = 0) {
  const out = new Map();
  const slice = [];
  for (let i = 0; i < Math.min(config.steam.itemsPerCycle, names.length); i++) {
    slice.push(names[(cursor + i) % names.length]);
  }

  let backoff = config.steam.delayMs;
  for (const name of slice) {
    const r = await fetchOne(name).catch(() => null);
    if (r?.rateLimited) {
      backoff = Math.min(backoff * 2, 60_000);
      console.warn(`  steam: 429, backing off to ${backoff}ms`);
      await sleep(backoff);
      continue;
    }
    if (r) out.set(r.name, r);
    await sleep(backoff);
  }

  return { prices: out, nextCursor: (cursor + slice.length) % Math.max(names.length, 1) };
}
