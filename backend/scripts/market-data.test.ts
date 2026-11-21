import assert from 'node:assert/strict';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { TwelveDataProvider } from '../src/modules/market/providers/twelveData.provider.js';
import { MarketService } from '../src/modules/market/market.service.js';
import { candlesQuerySchema, quotesQuerySchema } from '../src/modules/market/market.schemas.js';
import type { MarketDataProvider, MarketSymbol, NormalizedCandle, NormalizedQuote } from '../src/modules/market/market.types.js';

const originalFetch = globalThis.fetch;
const fetchedQuote = {
  symbol: 'EUR/USD',
  close: '1.0842',
  change: '0.003',
  percent_change: '0.28',
  currency: 'USD',
  datetime: new Date().toISOString(),
};
const fetchedCandles = {
  meta: { symbol: 'EUR/USD', interval: '1h' },
  values: [{ datetime: '2025-01-02 12:00:00', open: '1', high: '2', low: '0.5', close: '1.5', volume: '10' }],
};
let rateLimitCalls = 0;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function run(): Promise<void> {
  const originalApiKey = env.TWELVE_DATA_API_KEY;
  env.TWELVE_DATA_API_KEY = 'market-data-test-key';
  let mode = 'quote';
  globalThis.fetch = async (input, init) => {
    assert.equal((input as URL).searchParams.has('apikey'), false);
    assert.ok(new Headers(init?.headers).get('authorization')?.startsWith('apikey '));
    if (mode === 'quote') return response(fetchedQuote);
    if (mode === 'candles') return response(fetchedCandles);
    if (mode === 'empty-candles') return response({ ...fetchedCandles, values: [] });
    if (mode === 'missing-data') return response({ code: 404, message: 'No data available' });
    if (mode === 'invalid') return response({ symbol: 'EUR/USD', close: 'not-a-number' });
    if (mode === 'invalid-price') return response({ ...fetchedQuote, close: '0' });
    if (mode === 'stale') return response({ ...fetchedQuote, datetime: '2020-01-01T00:00:00Z' });
    if (mode === 'future') return response({ ...fetchedQuote, datetime: new Date(Date.now() + 60_000).toISOString() });
    if (mode === 'missing-timestamp') {
      const { datetime: _datetime, ...withoutDatetime } = fetchedQuote;
      return response(withoutDatetime);
    }
    if (mode === 'rate-limit') {
      rateLimitCalls += 1;
      return response({ code: 429, message: 'Too many requests' }, 429);
    }
    throw new DOMException('The operation was aborted', 'AbortError');
  };

  const provider = new TwelveDataProvider();
  const quote = await provider.getQuote('EUR/USD');
  assert.equal(quote.price, 1.0842);
  assert.equal(quote.source, 'Twelve Data');

  mode = 'candles';
  const candles = await provider.getCandles('EUR/USD', '1h', 100);
  assert.deepEqual(candles[0], {
    symbol: 'EUR/USD',
    interval: '1h',
    timestamp: '2025-01-02T12:00:00.000Z',
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: 10,
  });
  mode = 'empty-candles';
  await assert.rejects(() => provider.getCandles('EUR/USD', '1h', 100), /no candles/i);
  mode = 'missing-data';
  assert.equal((await provider.getQuote('EUR/USD')).status, 'unavailable');

  mode = 'invalid';
  assert.equal((await provider.getQuote('EUR/USD')).status, 'unavailable');
  assert.equal((await provider.getQuote('EUR/USD')).price, null);
  mode = 'invalid-price';
  assert.equal((await provider.getQuote('EUR/USD')).status, 'unavailable');
  mode = 'stale';
  const staleProviderQuote = await provider.getQuote('EUR/USD');
  assert.equal(staleProviderQuote.status, 'stale');
  assert.equal(staleProviderQuote.price, null);
  mode = 'future';
  assert.equal((await provider.getQuote('EUR/USD')).status, 'stale');
  mode = 'missing-timestamp';
  assert.equal((await provider.getQuote('EUR/USD')).status, 'stale');
  mode = 'rate-limit';
  assert.equal((await provider.getQuote('EUR/USD')).error, 'rate_limited');
  assert.equal(rateLimitCalls, 1);
  mode = 'timeout';
  assert.equal((await provider.getQuote('EUR/USD')).status, 'unavailable');

  assert.deepEqual(candlesQuerySchema.parse({ symbol: 'XAU/USD', interval: '1h', outputsize: '100' }).outputsize, 100);
  assert.throws(() => candlesQuerySchema.parse({ symbol: 'AUD/USD' }));
  assert.throws(() => quotesQuerySchema.parse({ symbols: 'EUR/USD,AUD/USD' }));

  const liveQuote: NormalizedQuote = {
    symbol: 'EUR/USD', price: 1.1, changePercent: 1, source: 'test',
    observedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(), status: 'live',
  };
  let quoteCalls = 0;
  const cachedProvider: MarketDataProvider = {
    name: 'Twelve Data',
    async getQuote(_symbol: MarketSymbol) {
      quoteCalls += 1;
      return quoteCalls === 1 ? liveQuote : { ...liveQuote, price: null, status: 'unavailable', error: 'provider_error' };
    },
    async getCandles(): Promise<NormalizedCandle[]> { return []; },
    async validateSymbol() { return { supported: true }; },
    async getStatus() { return { provider: 'Twelve Data', connected: true, lastSuccessfulUpdate: null, availableSymbols: ['EUR/USD'], lastError: null }; },
  };
  const service = new MarketService(cachedProvider);
  assert.equal((await service.getQuotes(['EUR/USD']))[0].price, 1.1);
  assert.equal((await service.getQuotes(['EUR/USD']))[0].price, 1.1);
  assert.equal(quoteCalls, 1);
  const originalNow = Date.now;
  Date.now = () => originalNow() + 31_000;
  const stale = await service.getQuotes(['EUR/USD']);
  assert.equal(stale[0].status, 'stale');
  assert.equal(stale[0].price, null);
  Date.now = originalNow;

  assert.equal((await service.getQuotes(['EUR/USD', 'GBP/USD'])).length, 2);
  const configuredKey = originalApiKey;
  const configuredProvider = env.MARKET_DATA_PROVIDER;
  env.MARKET_DATA_PROVIDER = 'twelve_data';
  const configuredService = new MarketService();
  env.TWELVE_DATA_API_KEY = undefined;
  await assert.rejects(() => configuredService.getQuotes(['EUR/USD']), /provider is not configured/i);
  env.TWELVE_DATA_API_KEY = configuredKey;
  env.MARKET_DATA_PROVIDER = configuredProvider;

  globalThis.fetch = originalFetch;
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  const unauthorized = await fetch(`http://127.0.0.1:${(address as { port: number }).port}/api/market/quotes`);
  assert.equal(unauthorized.status, 401);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  console.log('Market data tests passed');
}

run().finally(() => {
  globalThis.fetch = originalFetch;
}).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
