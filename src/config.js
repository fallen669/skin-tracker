import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const envFile = join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const num = (key, fallback) => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new Error(`${key} must be a number, got "${raw}"`);
  return n;
};

export const config = {
  // Where alerts go. Create via: channel settings -> Integrations -> Webhooks.
  discordWebhook: process.env.DISCORD_WEBHOOK ?? '',

  // How often a full cycle runs. Skinport caches for 5 min and allows
  // 8 requests per 5 min, so anything under 5 min just re-reads stale data.
  intervalMinutes: num('INTERVAL_MINUTES', 10),

  // Universe filters. Cheap items are dominated by fees and rounding;
  // illiquid items show fake spreads because a single listing sets the price.
  minPriceUsd: num('MIN_PRICE_USD', 5),
  maxPriceUsd: num('MAX_PRICE_USD', 400),
  minListings: num('MIN_LISTINGS', 8),

  // Seller fees, as a fraction. VERIFY THESE against your own account before
  // trusting any number this tool prints — Skinport's fee drops with volume
  // and both sites have changed their schedule more than once.
  fees: {
    skinport: num('FEE_SKINPORT', 0.12),
    waxpeer: num('FEE_WAXPEER', 0.06),
    steam: num('FEE_STEAM', 0.15),
  },

  // Report an opportunity only above this net margin AND this absolute profit.
  // A 55% margin on a $6 skin is $3.40 — not worth the trade risk.
  minMarginPct: num('MIN_MARGIN_PCT', 8),
  minNetProfitUsd: num('MIN_NET_PROFIT_USD', 5),

  // Skip items whose unlocked floor sits far above their all-listings floor:
  // the cheap end of the book is trade-locked, so the two markets' "min price"
  // are not the same product. 1.25 = tolerate a 25% lock discount.
  maxLockSkew: num('MAX_LOCK_SKEW', 1.25),

  // Outlier guard. Skinport's median is our fair-value anchor; a "min price"
  // far below it is a different variant or a bad listing, not a bargain.
  minAnchorRatio: num('MIN_ANCHOR_RATIO', 0.55),
  maxAnchorRatio: num('MAX_ANCHOR_RATIO', 1.80),

  // Skins whose market_hash_name hides wildly different real values.
  // Gamma Doppler Phase 1 and Gamma Doppler Emerald share one name; so do
  // Doppler phases, Marble Fade patterns and Case Hardened blue gems.
  // Comparing "cheapest listing" across markets for these is meaningless.
  excludeNamePatterns: [
    /Doppler/i, /Marble Fade/i, /Case Hardened/i, /Fade/i,
    /Crimson Web/i, /Blue Gem/i,
  ],

  // Non-weapon categories: thin books, different dynamics, and quantity
  // doesn't mean the same thing. Set INCLUDE_NON_WEAPONS=true to keep them.
  excludeCategoryPatterns: (process.env.INCLUDE_NON_WEAPONS ?? 'false') === 'true' ? [] : [
    /^Sticker \|/i, /Capsule/i, /^Graffiti \|/i, /^Sealed Graffiti \|/i,
    /^Patch \|/i, /^Music Kit \|/i, /^Pin$|Pin$/i, /Package/i, /^Souvenir /i,
    /Pass$/i, /^Operation /i,
  ],

  // Don't repeat the same item/direction for this many hours unless the
  // margin improved by at least 3 percentage points.
  alertCooldownHours: num('ALERT_COOLDOWN_HOURS', 12),

  // Steam is polled separately: it rate-limits hard and is reference data only
  // (Steam wallet funds cannot be withdrawn). Off by default.
  steam: {
    enabled: (process.env.STEAM_ENABLED ?? 'false') === 'true',
    // Items per cycle. Steam tolerates roughly 20 requests/minute before 429s.
    itemsPerCycle: num('STEAM_ITEMS_PER_CYCLE', 40),
    delayMs: num('STEAM_DELAY_MS', 3500),
    currency: num('STEAM_CURRENCY', 1), // 1 = USD, 5 = RUB
  },

  // 'sqlite' — long-running local process, writes straight to the database.
  // 'ndjson' — CI: the container is thrown away, so rows go to append-only
  // files in the repo and SQLite is rebuilt from them by `npm run import`.
  storage: process.env.STORAGE === 'ndjson' ? 'ndjson' : 'sqlite',

  dbPath: process.env.STORAGE === 'ndjson' ? ':memory:' : join(ROOT, 'data', 'skins.db'),
};

export const MARKETS = ['skinport', 'waxpeer', 'steam'];
