import { appendFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, config } from './config.js';

/**
 * GitHub Actions gives every run a fresh container, so state has to live in the
 * repository. A SQLite file committed every 15 minutes would store a full new
 * binary blob per commit — gigabytes a month. Append-only NDJSON, partitioned
 * by day, delta-compresses well and stays diffable.
 *
 * SQLite remains the analysis format; `npm run import` rebuilds it from these.
 */
export const OBS_DIR = join(ROOT, 'data', 'obs');
export const OPP_DIR = join(ROOT, 'data', 'opps');

const day = (ts) => new Date(ts).toISOString().slice(0, 10);

function appendLines(dir, ts, lines) {
  if (lines.length === 0) return;
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${day(ts)}.ndjson`), lines.join('\n') + '\n', 'utf8');
}

export function appendObservations(market, rows, ts) {
  appendLines(OBS_DIR, ts, rows.map((r) => JSON.stringify({
    ts, market, name: r.name, price: r.price, quantity: r.quantity ?? null,
  })));
}

export function appendOpportunities(opps, ts) {
  appendLines(OPP_DIR, ts, opps.map((o) => JSON.stringify({
    ts, name: o.name,
    buy_market: o.buyMarket, buy_price: o.buyPrice, buy_qty: o.buyQty ?? null,
    sell_market: o.sellMarket, sell_price: o.sellPrice, sell_qty: o.sellQty ?? null,
    net_profit: o.netProfit, margin_pct: o.marginPct, alerted: o.shouldAlert ? 1 : 0,
  })));
}

function* readDir(dir) {
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.ndjson')) continue;
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { yield JSON.parse(line); } catch { /* skip a torn final line */ }
    }
  }
}

export const readObservations = () => readDir(OBS_DIR);
export const readOpportunities = () => readDir(OPP_DIR);

/**
 * Alert de-duplication needs recent history, which in CI has to be replayed
 * from disk into the in-memory database before the cycle runs.
 */
export function recentOpportunities(hours) {
  const cutoff = Date.now() - hours * 3_600_000;
  const out = [];
  for (const row of readOpportunities()) {
    if (row.ts >= cutoff) out.push(row);
  }
  return out;
}

export const isEphemeral = config.storage === 'ndjson';
