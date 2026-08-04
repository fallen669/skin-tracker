import { config } from './config.js';

const money = (n) => `$${n.toFixed(2)}`;
const MARKET_LABEL = { skinport: 'Skinport', waxpeer: 'Waxpeer', steam: 'Steam' };

function line(o) {
  const buy = MARKET_LABEL[o.buyMarket] ?? o.buyMarket;
  const sell = MARKET_LABEL[o.sellMarket] ?? o.sellMarket;
  return `**${o.name}**\n` +
    `${buy} ${money(o.buyPrice)} (${o.buyQty}) → ${sell} ${money(o.sellPrice)} (${o.sellQty})\n` +
    `net ${money(o.netProfit)} · **${o.marginPct.toFixed(1)}%**`;
}

/**
 * Discord embeds cap at 4096 characters of description and 10 embeds per
 * message; one embed with a handful of rows stays well clear of both.
 */
export async function sendAlerts(opportunities) {
  if (!config.discordWebhook || opportunities.length === 0) return false;

  const top = opportunities.slice(0, 8);
  const body = {
    embeds: [{
      title: `Найдено спредов: ${opportunities.length}`,
      description: top.map(line).join('\n\n').slice(0, 4000),
      color: 0x5865f2,
      footer: { text: 'Котировки — цены выставления, не сделок. Проверяй float и комиссии вручную.' },
      timestamp: new Date().toISOString(),
    }],
  };

  const res = await fetch(config.discordWebhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    console.warn(`  discord: ${res.status} ${await res.text().catch(() => '')}`.trim());
    return false;
  }
  return true;
}
