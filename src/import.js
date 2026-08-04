/**
 * Rebuilds data/skins.db from the NDJSON files that CI commits, so `npm run
 * report` works locally against everything collected in the cloud.
 *
 * Run after `git pull`. Safe to re-run: the database is rebuilt from scratch.
 */
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';

if (process.env.STORAGE === 'ndjson') {
  console.error('Не запускай import со STORAGE=ndjson — база должна быть файловой.');
  process.exit(1);
}

const dbPath = join(ROOT, 'data', 'skins.db');
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
}

const { db } = await import('./db.js');
const { readObservations, readOpportunities } = await import('./storage.js');

const obsStmt = db.prepare(
  'INSERT INTO observations (ts, market, name, price, quantity) VALUES (?, ?, ?, ?, ?)'
);
const oppStmt = db.prepare(`
  INSERT INTO opportunities
    (ts, name, buy_market, buy_price, sell_market, sell_price, net_profit, margin_pct, buy_qty, sell_qty, alerted)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const cycleStmt = db.prepare(
  'INSERT INTO cycles (ts, duration, universe, stored, found, note) VALUES (?, ?, ?, ?, ?, ?)'
);

let obs = 0, opps = 0;
const cycleTimestamps = new Set();

db.exec('BEGIN');
for (const r of readObservations()) {
  obsStmt.run(r.ts, r.market, r.name, r.price, r.quantity ?? null);
  cycleTimestamps.add(r.ts);
  obs++;
}
for (const o of readOpportunities()) {
  oppStmt.run(
    o.ts, o.name, o.buy_market, o.buy_price, o.sell_market, o.sell_price,
    o.net_profit, o.margin_pct, o.buy_qty ?? null, o.sell_qty ?? null, o.alerted ?? 0
  );
  cycleTimestamps.add(o.ts);
  opps++;
}
// Cycle metadata isn't in NDJSON; synthesise one row per distinct timestamp so
// the report's "collection period" figures still work.
for (const ts of [...cycleTimestamps].sort()) {
  cycleStmt.run(ts, 0, 0, 0, 0, 'imported');
}
db.exec('COMMIT');

console.log(`Импортировано: ${obs} котировок, ${opps} спредов, ${cycleTimestamps.size} циклов`);
console.log('Готово — запускай `npm run report`.');
