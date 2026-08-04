import { db } from './db.js';

/**
 * The point of the whole exercise: after a few weeks, does the data say there
 * is a real edge, or does it say the spreads are noise?
 */
const q = (sql, ...args) => db.prepare(sql).all(...args);
const one = (sql, ...args) => db.prepare(sql).get(...args);

const money = (n) => `$${Number(n).toFixed(2)}`;
const pct = (n) => `${Number(n).toFixed(1)}%`;

const cycles = one('SELECT COUNT(*) c, MIN(ts) first, MAX(ts) last FROM cycles');
if (!cycles.c) {
  console.log('Нет данных — запусти сначала `npm run once`.');
  process.exit(0);
}

const days = (cycles.last - cycles.first) / 86_400_000;
console.log('=== Сбор данных ===');
console.log(`циклов: ${cycles.c} за ${days.toFixed(1)} дн.`);
console.log(`наблюдений цен: ${one('SELECT COUNT(*) c FROM observations').c}`);
console.log(`уникальных предметов: ${one('SELECT COUNT(DISTINCT name) c FROM observations').c}`);

const opp = one(`
  SELECT COUNT(*) c, AVG(margin_pct) avg_m, MAX(margin_pct) max_m, AVG(net_profit) avg_p
  FROM opportunities
`);
console.log('\n=== Спреды ===');
console.log(`всего срабатываний: ${opp.c}`);
if (opp.c) {
  console.log(`средняя маржа: ${pct(opp.avg_m)} · максимум: ${pct(opp.max_m)}`);
  console.log(`средняя прибыль на предмет: ${money(opp.avg_p)}`);
}

console.log('\n=== По направлениям ===');
for (const r of q(`
  SELECT buy_market, sell_market, COUNT(*) c, AVG(margin_pct) m
  FROM opportunities GROUP BY buy_market, sell_market ORDER BY c DESC
`)) {
  console.log(`  ${r.buy_market} → ${r.sell_market}: ${r.c} шт, средняя ${pct(r.m)}`);
}

console.log('\n=== Топ повторяющихся ===');
console.log('(предмет, который всплывает раз за разом, — обычно ловушка, а не эдж)');
for (const r of q(`
  SELECT name, COUNT(*) c, AVG(margin_pct) m, AVG(net_profit) p
  FROM opportunities GROUP BY name HAVING c > 1 ORDER BY c DESC LIMIT 15
`)) {
  console.log(`  ${r.c}×  ${pct(r.m)}  ${money(r.p)}  ${r.name}`);
}

/**
 * Persistence check. A spread that survives many cycles was never real: if you
 * could actually buy at A and sell at B, somebody would have closed it.
 */
console.log('\n=== Живучесть ===');
const persist = one(`
  SELECT
    SUM(CASE WHEN c = 1 THEN 1 ELSE 0 END) once,
    SUM(CASE WHEN c BETWEEN 2 AND 5 THEN 1 ELSE 0 END) few,
    SUM(CASE WHEN c > 5 THEN 1 ELSE 0 END) many
  FROM (SELECT name, COUNT(*) c FROM opportunities GROUP BY name)
`);
console.log(`  разовые: ${persist.once ?? 0}  (кандидаты в реальные)`);
console.log(`  2–5 циклов: ${persist.few ?? 0}`);
console.log(`  >5 циклов: ${persist.many ?? 0}  (почти наверняка мусор: плохой float, стикеры, скам-листинги)`);
