const BASE = 'https://api.skinport.com/v1/items?app_id=730&currency=USD';

/**
 * Skinport's `tradable` flag does not mean what the docs suggest. Measured
 * against live data for "CZ75-Auto | Syndicate (Factory New)":
 *
 *   tradable omitted / =1  -> 25114 items, min $36.55, qty 41
 *   tradable=0             -> 21918 items, min $104.79, qty 19
 *
 * So `tradable=0` is the *unlocked-only* book: fewer listings, higher floor.
 * The default book includes trade-locked listings, which sell at a discount
 * because the buyer cannot touch the item for up to 7 days.
 *
 * This matters more than anything else in the tool. Waxpeer's price endpoint
 * does not flag lock status, so its `min` includes locked listings. Comparing
 * Waxpeer's locked-inclusive floor against Skinport's unlocked-only floor
 * manufactures spreads of 200%+ that do not exist.
 *
 * We therefore fetch both books: the default one for like-for-like comparison,
 * and the unlocked one to measure how much of the cheap end is trade-locked.
 */
/**
 * Exceeding 8 requests / 5 minutes is not a rolling window — it's a lockout.
 * Measured Retry-After after one burst: 3132 seconds, i.e. 52 minutes. Steady
 * state (2 calls per cycle, cycles 10+ minutes apart) stays far below the cap,
 * but a retry loop during a penalty just keeps extending the pain.
 */
async function fetchBook(query) {
  const res = await fetch(BASE + query, {
    headers: { 'Accept-Encoding': 'br' },
    signal: AbortSignal.timeout(60_000),
  });

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after')) || 3600;
    const err = new Error(`rate limited, retry in ${Math.ceil(retryAfter / 60)} min`);
    err.retryAfter = retryAfter;
    throw err;
  }
  if (!res.ok) throw new Error(`Skinport ${res.status} ${res.statusText}`);

  const items = await res.json();
  if (!Array.isArray(items)) throw new Error('Skinport returned a non-array payload');
  return items;
}

/** Set while a lockout is in force so we stop asking. */
let cooldownUntil = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchSkinport() {
  if (Date.now() < cooldownUntil) {
    const mins = Math.ceil((cooldownUntil - Date.now()) / 60_000);
    throw new Error(`rate limited, ${mins} min left on cooldown`);
  }

  let all, unlocked;
  try {
    all = await fetchBook('');
    await sleep(2000); // 8 requests per 5 minutes; two calls per cycle is fine
    unlocked = await fetchBook('&tradable=0');
  } catch (err) {
    if (err.retryAfter) cooldownUntil = Date.now() + err.retryAfter * 1000;
    throw err;
  }

  const unlockedByName = new Map();
  for (const it of unlocked) {
    if (typeof it.min_price === 'number' && it.min_price > 0) {
      unlockedByName.set(it.market_hash_name, it.min_price);
    }
  }

  const out = new Map();
  for (const it of all) {
    if (typeof it.min_price !== 'number' || it.min_price <= 0) continue;
    const unlockedPrice = unlockedByName.get(it.market_hash_name) ?? null;
    out.set(it.market_hash_name, {
      name: it.market_hash_name,
      price: it.min_price,
      quantity: it.quantity ?? 0,
      median: it.median_price ?? null,
      unlockedPrice,
      // >1 means the cheap end of the book is trade-locked.
      lockSkew: unlockedPrice ? unlockedPrice / it.min_price : null,
    });
  }
  return out;
}
