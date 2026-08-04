import { config } from './config.js';
import { fetchSkinport } from './sources/skinport.js';
import { fetchWaxpeer } from './sources/waxpeer.js';
import { fetchSteamSlice } from './sources/steam.js';
import { buildUniverse, findOpportunities } from './analyze.js';
import { storeObservations, storeOpportunities, storeCycle, wasRecentlyAlerted, hydrateOpportunity } from './db.js';
import { appendObservations, appendOpportunities, recentOpportunities } from './storage.js';
import { sendAlerts } from './notify.js';

const once = process.argv.includes('--once');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toLocaleTimeString('ru-RU');

let steamCursor = 0;

async function cycle() {
  const startedAt = Date.now();
  const ts = startedAt;
  const books = new Map();
  const notes = [];

  const sources = [
    ['skinport', fetchSkinport],
    ['waxpeer', fetchWaxpeer],
  ];

  // One dead market shouldn't kill the run — we just lose that leg this cycle.
  for (const [name, fn] of sources) {
    try {
      const book = await fn();
      books.set(name, book);
      console.log(`  ${name}: ${book.size} items`);
    } catch (err) {
      notes.push(`${name} failed: ${err.message}`);
      console.warn(`  ${name}: FAILED — ${err.message}`);
    }
  }

  if (books.size < 2) {
    console.warn(`  skipping cycle: need 2 cash markets, have ${books.size}`);
    storeCycle(ts, Date.now() - startedAt, 0, 0, 0, notes.join('; ') || 'insufficient sources');
    return;
  }

  const universe = buildUniverse(books);
  console.log(`  universe: ${universe.length} items`);

  if (config.steam.enabled && universe.length > 0) {
    const { prices, nextCursor } = await fetchSteamSlice(universe, steamCursor);
    steamCursor = nextCursor;
    if (prices.size > 0) books.set('steam', prices);
    console.log(`  steam: ${prices.size} items (reference only)`);
  }

  // Persist only what we actually analyse. Dumping both full books was ~46k
  // rows a cycle, and the 43k outside the universe are never looked at again.
  const inUniverse = new Set(universe);
  let stored = 0;
  for (const [market, book] of books) {
    const rows = [...book.values()].filter((r) => inUniverse.has(r.name));
    const n = storeObservations(market, rows, ts);
    stored += n;
    if (config.storage === 'ndjson') appendObservations(market, rows, ts);
  }

  const opportunities = findOpportunities(books, universe);
  for (const o of opportunities) {
    o.shouldAlert = !wasRecentlyAlerted(o, ts, config.alertCooldownHours);
  }
  storeOpportunities(opportunities, ts);
  if (config.storage === 'ndjson') appendOpportunities(opportunities, ts);

  const fresh = opportunities.filter((o) => o.shouldAlert);
  if (fresh.length > 0) {
    const sent = await sendAlerts(fresh);
    console.log(`  opportunities: ${opportunities.length} (${fresh.length} new${sent ? ', alerted' : ''})`);
    for (const o of fresh.slice(0, 5)) {
      console.log(`    ${o.marginPct.toFixed(1)}%  ${o.name}  ${o.buyMarket}→${o.sellMarket}`);
    }
  } else {
    console.log(`  opportunities: ${opportunities.length} (none new)`);
  }

  storeCycle(ts, Date.now() - startedAt, universe.length, stored, opportunities.length, notes.join('; ') || null);
  console.log(`  stored ${stored} price rows in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

async function main() {
  console.log('skin-tracker');
  console.log(`  interval ${config.intervalMinutes}m · band $${config.minPriceUsd}–${config.maxPriceUsd} · ` +
    `min listings ${config.minListings} · min margin ${config.minMarginPct}%`);
  console.log(`  discord: ${config.discordWebhook ? 'configured' : 'NOT configured (console only)'}`);
  console.log(`  storage: ${config.storage}`);
  console.log(`  steam: ${config.steam.enabled ? 'on' : 'off'}\n`);

  if (config.storage === 'ndjson') {
    const history = recentOpportunities(config.alertCooldownHours);
    for (const row of history) hydrateOpportunity(row);
    console.log(`  replayed ${history.length} recent opportunities for de-dup\n`);
  }

  for (;;) {
    console.log(`[${stamp()}] cycle`);
    try {
      await cycle();
    } catch (err) {
      console.error(`  cycle failed: ${err.stack ?? err.message}`);
    }
    if (once) break;
    console.log(`  next in ${config.intervalMinutes}m\n`);
    await sleep(config.intervalMinutes * 60_000);
  }
}

main();
