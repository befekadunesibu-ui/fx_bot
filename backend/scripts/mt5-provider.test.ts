import assert from 'node:assert/strict';
import { Mt5Provider } from '../src/modules/market/providers/mt5.provider.js';

const originalFetch = globalThis.fetch;
const now = new Date().toISOString();
const requestedSymbols: string[] = [];
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  const path = url.pathname;
  if (path === '/quote') requestedSymbols.push(url.searchParams.get('symbol') ?? '');
  if (path === '/health') return new Response(JSON.stringify({ connected: true, symbols: ['EURUSD'], lastError: null }));
  if (path === '/quote') return new Response(JSON.stringify({ symbol: 'EURUSD', bid: 1.1, ask: 1.1002, time: now }));
  if (path === '/candles') return new Response(JSON.stringify({ candles: [{ time: now, open: 1, high: 1.2, low: 0.9, close: 1.1, volume: 12 }] }));
  return new Response('{}', { status: 404 });
};

const provider = new Mt5Provider();
const quote = await provider.getQuote('EUR/USD');
assert.equal(quote.source, 'MetaTrader 5');
assert.equal(quote.status, 'live');
assert.equal(quote.price, 1.1001);
assert.equal(quote.bid, 1.1);
assert.equal(quote.ask, 1.1002);
assert.ok(Math.abs((quote.spread ?? 0) - 0.0002) < Number.EPSILON);
const candles = await provider.getCandles('EUR/USD', '1h', 10);
assert.equal(candles[0].symbol, 'EUR/USD');
assert.equal(candles[0].interval, '1h');
assert.equal((await provider.getStatus()).availableSymbols.includes('EUR/USD'), true);

for (const symbol of ['XAU/USD', 'EUR/USD', 'GBP/USD', 'USD/JPY'] as const) {
  await provider.getQuote(symbol);
}
assert.deepEqual(requestedSymbols.slice(0, 5), ['EURUSD', 'XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY']);

globalThis.fetch = async (input) => {
  const path = new URL(String(input)).pathname;
  if (path === '/quote') return new Response(JSON.stringify({ symbol: 'EURUSD', bid: 1.1, ask: 1.1002, time: new Date(Date.now() - 10 * 60_000).toISOString() }));
  return new Response('{}', { status: 404 });
};
assert.equal((await provider.getQuote('EUR/USD')).status, 'stale');

globalThis.fetch = async (input) => {
  const path = new URL(String(input)).pathname;
  if (path === '/quote') return new Response(JSON.stringify({ symbol: 'EURUSD', bid: 1.1, ask: 1.1002, time: new Date(Date.now() + 10 * 60_000).toISOString() }));
  return new Response('{}', { status: 404 });
};
assert.equal((await provider.getQuote('EUR/USD')).status, 'stale');

globalThis.fetch = async () => { throw new Error('bridge offline'); };
assert.equal((await provider.getQuote('EUR/USD')).status, 'unavailable');
assert.equal((await provider.getStatus()).connected, false);
globalThis.fetch = async (input) => {
  const path = new URL(String(input)).pathname;
  if (path === '/quote') return new Response(JSON.stringify({ symbol: 'EURUSD', bid: 1.2, ask: 1.1, time: now }));
  if (path === '/health') return new Response(JSON.stringify({ connected: true, symbols: ['EURUSD'], lastError: null }));
  return new Response('{}', { status: 404 });
};
assert.equal((await provider.getQuote('EUR/USD')).status, 'unavailable');
globalThis.fetch = originalFetch;
console.log('MT5 provider tests passed');
