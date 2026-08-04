const URL = 'https://api.waxpeer.com/v1/prices?game=csgo&minified=1';

/**
 * Waxpeer quotes integers in thousandths of a dollar: 29770 means $29.77.
 * No auth required. `count` is the number of live listings.
 */
const SCALE = 1000;

export async function fetchWaxpeer() {
  const res = await fetch(URL, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Waxpeer ${res.status} ${res.statusText}`);

  const body = await res.json();
  if (!body?.success || !Array.isArray(body.items)) {
    throw new Error('Waxpeer returned an unexpected payload');
  }

  const out = new Map();
  for (const it of body.items) {
    if (typeof it.min !== 'number' || it.min <= 0) continue;
    out.set(it.name, {
      name: it.name,
      price: it.min / SCALE,
      quantity: it.count ?? 0,
    });
  }
  return out;
}
