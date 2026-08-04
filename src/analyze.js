import { config } from './config.js';

/**
 * Items worth looking at: present on both cash markets, inside the price band,
 * and backed by enough listings that one outlier can't invent a spread.
 */
const isExcluded = (name) =>
  config.excludeNamePatterns.some((re) => re.test(name)) ||
  config.excludeCategoryPatterns.some((re) => re.test(name));

export function buildUniverse(books) {
  const [first, ...rest] = [...books.values()];
  if (!first) return [];

  const names = [];
  for (const name of first.keys()) {
    if (isExcluded(name)) continue;
    const rows = [first.get(name), ...rest.map((b) => b.get(name))];
    if (rows.some((r) => !r)) continue;
    if (rows.some((r) => r.price < config.minPriceUsd || r.price > config.maxPriceUsd)) continue;
    if (rows.some((r) => (r.quantity ?? 0) < config.minListings)) continue;
    names.push(name);
  }
  return names;
}

/**
 * Buy at the cheapest listing on A, relist on B, pay B's seller fee.
 *
 *   net = sellPrice * (1 - feeB) - buyPrice
 *
 * Both inputs are asking prices, so this is an upper bound on what is really
 * there: the cheap listing may be stale or mispriced for a reason (bad float,
 * a sticker-less variant, a scam listing), and your own relist has to actually
 * sell at that price rather than undercut it.
 */
export function findOpportunities(books, universe) {
  const markets = [...books.keys()];
  const found = [];

  const anchorBook = books.get('skinport');

  for (const name of universe) {
    // Fair-value anchor. Without it, every stale or mis-listed item at the
    // bottom of a book reads as free money.
    const anchor = anchorBook?.get(name)?.median ?? null;

    for (const buyMarket of markets) {
      for (const sellMarket of markets) {
        if (buyMarket === sellMarket) continue;

        // Steam wallet money can't be withdrawn, so "sell on Steam" is not a
        // cash exit. Keep it as reference only.
        if (sellMarket === 'steam') continue;

        const buy = books.get(buyMarket).get(name);
        const sell = books.get(sellMarket).get(name);
        if (!buy || !sell) continue;

        // If the cheap end of Skinport's book is trade-locked, the cheap end of
        // Waxpeer's almost certainly is too — its endpoint doesn't flag lock
        // status, so the two floors aren't the same product. Skip: a locked buy
        // means 7 days of price risk before you can even list it.
        const skew = Math.max(buy.lockSkew ?? 1, sell.lockSkew ?? 1);
        if (skew > config.maxLockSkew) continue;

        if (anchor) {
          if (buy.price / anchor < config.minAnchorRatio) continue;
          if (sell.price / anchor > config.maxAnchorRatio) continue;
        }

        const fee = config.fees[sellMarket] ?? 0;
        const netProfit = sell.price * (1 - fee) - buy.price;
        const marginPct = (netProfit / buy.price) * 100;
        if (marginPct < config.minMarginPct) continue;
        if (netProfit < config.minNetProfitUsd) continue;

        found.push({
          name,
          buyMarket, buyPrice: buy.price, buyQty: buy.quantity,
          sellMarket, sellPrice: sell.price, sellQty: sell.quantity,
          netProfit, marginPct, lockSkew: skew,
        });
      }
    }
  }

  return found.sort((a, b) => b.marginPct - a.marginPct);
}
