import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS observations (
    id       INTEGER PRIMARY KEY,
    ts       INTEGER NOT NULL,
    market   TEXT    NOT NULL,
    name     TEXT    NOT NULL,
    price    REAL    NOT NULL,
    quantity INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_obs_name_ts ON observations(name, ts);
  CREATE INDEX IF NOT EXISTS idx_obs_ts      ON observations(ts);

  CREATE TABLE IF NOT EXISTS opportunities (
    id          INTEGER PRIMARY KEY,
    ts          INTEGER NOT NULL,
    name        TEXT    NOT NULL,
    buy_market  TEXT    NOT NULL,
    buy_price   REAL    NOT NULL,
    sell_market TEXT    NOT NULL,
    sell_price  REAL    NOT NULL,
    net_profit  REAL    NOT NULL,
    margin_pct  REAL    NOT NULL,
    buy_qty     INTEGER,
    sell_qty    INTEGER,
    alerted     INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_opp_ts   ON opportunities(ts);
  CREATE INDEX IF NOT EXISTS idx_opp_name ON opportunities(name, buy_market, sell_market, ts);

  CREATE TABLE IF NOT EXISTS cycles (
    id        INTEGER PRIMARY KEY,
    ts        INTEGER NOT NULL,
    duration  INTEGER NOT NULL,
    universe  INTEGER NOT NULL,
    stored    INTEGER NOT NULL,
    found     INTEGER NOT NULL,
    note      TEXT
  );
`);

const insertObs = db.prepare(
  'INSERT INTO observations (ts, market, name, price, quantity) VALUES (?, ?, ?, ?, ?)'
);
const insertOpp = db.prepare(`
  INSERT INTO opportunities
    (ts, name, buy_market, buy_price, sell_market, sell_price, net_profit, margin_pct, buy_qty, sell_qty, alerted)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertCycle = db.prepare(
  'INSERT INTO cycles (ts, duration, universe, stored, found, note) VALUES (?, ?, ?, ?, ?, ?)'
);
const lastAlert = db.prepare(`
  SELECT ts, margin_pct FROM opportunities
  WHERE name = ? AND buy_market = ? AND sell_market = ? AND alerted = 1
  ORDER BY ts DESC LIMIT 1
`);

/** node:sqlite has no transaction() helper, so wrap manually. */
function inTransaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Writing every item every cycle would add ~7M rows a day and tell us nothing
 * new — most prices sit still. Only material moves get a row.
 */
const lastSeen = new Map();
const MATERIAL_CHANGE = 0.005;

export function storeObservations(market, rows, ts) {
  return inTransaction(() => {
    let stored = 0;
    for (const r of rows) {
      const key = `${market}:${r.name}`;
      const prev = lastSeen.get(key);
      if (prev !== undefined && Math.abs(r.price - prev) / prev < MATERIAL_CHANGE) continue;
      lastSeen.set(key, r.price);
      insertObs.run(ts, market, r.name, r.price, r.quantity ?? null);
      stored++;
    }
    return stored;
  });
}

export function storeOpportunities(opps, ts) {
  inTransaction(() => {
    for (const o of opps) {
      insertOpp.run(
        ts, o.name, o.buyMarket, o.buyPrice, o.sellMarket, o.sellPrice,
        o.netProfit, o.marginPct, o.buyQty ?? null, o.sellQty ?? null,
        o.shouldAlert ? 1 : 0
      );
    }
  });
}

/**
 * CI starts from an empty in-memory database each run, so recent history is
 * replayed from NDJSON before the cycle — otherwise every alert looks new and
 * the channel gets spammed with the same items every 15 minutes.
 */
export function hydrateOpportunity(row) {
  insertOpp.run(
    row.ts, row.name, row.buy_market, row.buy_price, row.sell_market, row.sell_price,
    row.net_profit, row.margin_pct, row.buy_qty ?? null, row.sell_qty ?? null, row.alerted ?? 0
  );
}

export function storeCycle(ts, duration, universe, stored, found, note) {
  insertCycle.run(ts, duration, universe, stored, found, note ?? null);
}

export function wasRecentlyAlerted(o, ts, cooldownHours) {
  const row = lastAlert.get(o.name, o.buyMarket, o.sellMarket);
  if (!row) return false;
  const ageHours = (ts - row.ts) / 3_600_000;
  if (ageHours >= cooldownHours) return false;
  // Let a materially better margin through even inside the cooldown.
  return o.marginPct < row.margin_pct + 3;
}
