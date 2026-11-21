import { z } from 'zod';
import { env } from '../../../config/env.js';
import { MARKET_SYMBOLS, type MarketDataProvider, type MarketInterval, type MarketProviderStatus, type MarketSymbol, type NormalizedCandle, type NormalizedQuote } from '../market.types.js';

const quoteResponseSchema = z.object({
  symbol: z.string(),
  close: z.union([z.string(), z.number()]),
  change: z.union([z.string(), z.number()]).nullish(),
  percent_change: z.union([z.string(), z.number()]).nullish(),
  currency: z.string().nullish(),
  datetime: z.string().nullish(),
  timestamp: z.union([z.string(), z.number()]).nullish(),
  status: z.string().nullish(),
});

const timeSeriesResponseSchema = z.object({
  meta: z.object({ symbol: z.string(), interval: z.string() }).passthrough(),
  values: z.array(z.object({
    datetime: z.string(),
    open: z.union([z.string(), z.number()]),
    high: z.union([z.string(), z.number()]),
    low: z.union([z.string(), z.number()]),
    close: z.union([z.string(), z.number()]),
    volume: z.union([z.string(), z.number()]).nullish(),
  }).passthrough()),
  status: z.string().optional(),
});

const symbolResponseSchema = z.object({
  data: z.array(z.object({ symbol: z.string() }).passthrough()).optional(),
  status: z.string().optional(),
});

class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: 'unsupported' | 'rate_limited' | 'timeout' | 'provider_error' | 'stale',
    readonly status?: number,
  ) {
    super(message);
  }
}

function toNumber(value: string | number | null | undefined, field: string): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ProviderError(`Invalid Twelve Data ${field}`, 'provider_error');
  return parsed;
}

function requiredNumber(value: string | number | null | undefined, field: string): number {
  const parsed = toNumber(value, field);
  if (parsed === undefined) throw new ProviderError(`Twelve Data candle has no ${field}`, 'provider_error');
  return parsed;
}

function observedAt(datetime?: string | null, timestamp?: string | number | null): string | null {
  if (timestamp !== null && timestamp !== undefined) {
    const milliseconds = Number(timestamp) * 1000;
    if (Number.isFinite(milliseconds) && Number.isFinite(new Date(milliseconds).getTime())) {
      return new Date(milliseconds).toISOString();
    }
  }
  if (datetime) {
    const isoDatetime = datetime.includes('T') ? datetime : datetime.replace(' ', 'T');
    const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(isoDatetime);
    const parsed = new Date(`${isoDatetime}${hasTimezone ? '' : 'Z'}`);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

export class TwelveDataProvider implements MarketDataProvider {
  readonly name = 'Twelve Data' as const;
  private readonly baseUrl = env.TWELVE_DATA_BASE_URL.replace(/\/+$/, '');
  private lastSuccessfulUpdate: string | null = null;
  private lastError: string | null = null;

  private async request(path: string, params: Record<string, string>): Promise<unknown> {
    if (!env.TWELVE_DATA_API_KEY) {
      throw new ProviderError('Twelve Data API key is not configured', 'provider_error');
    }
    const url = new URL(`${this.baseUrl}/${path}`);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), env.MARKET_DATA_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          headers: { Authorization: `apikey ${env.TWELVE_DATA_API_KEY}` },
          signal: controller.signal,
        });
        const body = await response.json() as { code?: number; message?: string; status?: string };
        if (response.status === 429 || body.code === 429) {
          throw new ProviderError('Twelve Data rate limit reached', 'rate_limited', response.status);
        }
        if (!response.ok || body.status === 'error' || body.code) {
          const message = body.message ?? `Twelve Data returned HTTP ${response.status}`;
          const transient = response.status >= 500;
          if (transient && attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
            continue;
          }
          throw new ProviderError(message, /symbol|access|plan|permission|not found|apikey|api key|unauthorized/i.test(message) ? 'unsupported' : 'provider_error', response.status);
        }
        return body;
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (error instanceof DOMException && error.name === 'AbortError') {
          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
            continue;
          }
          throw new ProviderError('Twelve Data request timed out', 'timeout');
        }
        throw new ProviderError('Twelve Data request failed', 'provider_error');
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new ProviderError('Twelve Data request failed', 'provider_error');
  }

  async getQuote(symbol: MarketSymbol): Promise<NormalizedQuote> {
    const fetchedAt = new Date().toISOString();
    try {
      const raw = quoteResponseSchema.parse(await this.request('quote', { symbol }));
      const price = toNumber(raw.close, 'close');
      if (price === undefined || price <= 0) throw new ProviderError('Twelve Data quote has no valid price', 'provider_error');
      const observed = observedAt(raw.datetime, raw.timestamp);
      const age = observed ? Date.now() - Date.parse(observed) : Number.NaN;
      if (!Number.isFinite(age) || age < -5_000 || age > 15 * 60 * 1000) {
        throw new ProviderError('Twelve Data quote timestamp is missing, invalid, future-dated, or stale', 'stale');
      }
      const result: NormalizedQuote = {
        symbol,
        price,
        bid: null,
        ask: null,
        spread: null,
        change: toNumber(raw.change, 'change'),
        changePercent: toNumber(raw.percent_change, 'percent_change'),
        currency: raw.currency ?? undefined,
        source: 'Twelve Data',
        observedAt: observed,
        fetchedAt,
        status: age > 30_000 ? 'delayed' : 'live',
      };
      this.lastSuccessfulUpdate = fetchedAt;
      this.lastError = null;
      return result;
    } catch (error) {
      return this.unavailableQuote(symbol, fetchedAt, error);
    }
  }

  async getCandles(symbol: MarketSymbol, interval: MarketInterval, outputsize: number): Promise<NormalizedCandle[]> {
    const raw = timeSeriesResponseSchema.parse(await this.request('time_series', {
      symbol,
      interval,
      outputsize: String(outputsize),
      order: 'asc',
      timezone: 'UTC',
    }));
    if (raw.values.length === 0) throw new ProviderError('Twelve Data returned no candles', 'provider_error');
    return raw.values.map((candle) => {
      const candleTime = observedAt(candle.datetime);
      const open = requiredNumber(candle.open, 'open');
      const high = requiredNumber(candle.high, 'high');
      const low = requiredNumber(candle.low, 'low');
      const close = requiredNumber(candle.close, 'close');
      const volume = toNumber(candle.volume, 'volume');
      if (!candleTime || Date.parse(candleTime) > Date.now() + 5_000
        || [open, high, low, close].some((value) => value <= 0)
        || high < Math.max(open, low, close) || low > Math.min(open, high, close)
        || (volume !== undefined && volume < 0)) {
        throw new ProviderError('Twelve Data returned an invalid candle', 'provider_error');
      }
      return { symbol, interval, timestamp: candleTime, open, high, low, close, volume };
    });
  }

  async validateSymbol(symbol: MarketSymbol): Promise<{ supported: boolean; reason?: string }> {
    try {
      const raw = symbolResponseSchema.parse(await this.request('symbol_search', { symbol }));
      const supported = Boolean(raw.data?.some((item) => item.symbol.toUpperCase() === symbol));
      return supported ? { supported: true } : { supported: false, reason: 'Symbol is not available for this Twelve Data account' };
    } catch (error) {
      return { supported: false, reason: error instanceof Error ? error.message : 'Symbol capability check failed' };
    }
  }

  async getStatus(): Promise<MarketProviderStatus> {
    return {
      provider: this.name,
      connected: Boolean(env.TWELVE_DATA_API_KEY),
      lastSuccessfulUpdate: this.lastSuccessfulUpdate,
      availableSymbols: MARKET_SYMBOLS,
      lastError: this.lastError,
    };
  }

  private unavailableQuote(symbol: string, fetchedAt: string, error: unknown): NormalizedQuote {
    const providerError = error instanceof ProviderError ? error : undefined;
    this.lastError = providerError?.message ?? 'Twelve Data request failed';
    return {
      symbol,
      price: null,
      bid: null,
      ask: null,
      spread: null,
      source: 'Twelve Data',
      observedAt: null,
      fetchedAt,
      status: providerError?.kind === 'stale' ? 'stale' : 'unavailable',
      error: providerError?.kind ?? 'provider_error',
    };
  }
}
