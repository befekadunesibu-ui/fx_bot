import { env } from '../../config/env.js';
import { MARKET_SYMBOLS, type MarketDataProvider, type MarketInterval, type MarketSymbol, type NormalizedCandle, type NormalizedQuote } from './market.types.js';
import { TwelveDataProvider } from './providers/twelveData.provider.js';
import { Mt5Provider } from './providers/mt5.provider.js';

type CachedQuote = { value: NormalizedQuote; cachedAt: number };
type CachedCandles = { value: NormalizedCandle[]; fetchedAt: string; cachedAt: number };

export class MarketServiceError extends Error {
  constructor(readonly code: 'provider_not_configured' | 'provider_error', readonly status = 503) {
    super(code === 'provider_not_configured' ? 'Market data provider is not configured' : 'Market data is currently unavailable');
  }
}

export class MarketService {
  private readonly quoteCache = new Map<string, CachedQuote>();
  private readonly candleCache = new Map<string, CachedCandles>();
  private readonly quoteRequests = new Map<string, Promise<NormalizedQuote>>();
  private readonly candleRequests = new Map<string, Promise<NormalizedCandle[]>>();

  private readonly requiresTwelveDataKey: boolean;

  constructor(provider?: MarketDataProvider) {
    this.provider = provider ?? (env.MARKET_DATA_PROVIDER === 'mt5' ? new Mt5Provider() : new TwelveDataProvider());
    this.requiresTwelveDataKey = !provider && env.MARKET_DATA_PROVIDER === 'twelve_data';
  }

  private readonly provider: MarketDataProvider;

  async getStatus() {
    return this.provider.getStatus();
  }

  async getQuotes(symbols: readonly MarketSymbol[]): Promise<NormalizedQuote[]> {
    if (this.requiresTwelveDataKey && !env.TWELVE_DATA_API_KEY) throw new MarketServiceError('provider_not_configured');
    return Promise.all(symbols.map((symbol) => this.getQuote(symbol)));
  }

  async getCandles(symbol: MarketSymbol, interval: MarketInterval, outputsize: number): Promise<{
    candles: NormalizedCandle[];
    fetchedAt: string;
    status: 'live' | 'stale';
  }> {
    if (this.requiresTwelveDataKey && !env.TWELVE_DATA_API_KEY) throw new MarketServiceError('provider_not_configured');
    const key = `${symbol}:${interval}:${outputsize}`;
    const cached = this.candleCache.get(key);
    if (cached && Date.now() - cached.cachedAt < env.MARKET_DATA_CACHE_TTL_SECONDS * 1000) {
      return { candles: cached.value, fetchedAt: cached.fetchedAt, status: 'live' };
    }

    const request = this.candleRequests.get(key) ?? this.fetchCandles(symbol, interval, outputsize);
    this.candleRequests.set(key, request);
    try {
      const candles = await request;
      const fetchedAt = new Date().toISOString();
      this.candleCache.set(key, { value: candles, fetchedAt, cachedAt: Date.now() });
      return { candles, fetchedAt, status: 'live' };
    } catch (error) {
      if (cached) return { candles: cached.value, fetchedAt: cached.fetchedAt, status: 'stale' };
      throw error;
    } finally {
      this.candleRequests.delete(key);
    }
  }

  async getCapabilities(): Promise<Record<MarketSymbol, { supported: boolean; reason?: string }>> {
    if (this.requiresTwelveDataKey && !env.TWELVE_DATA_API_KEY) throw new MarketServiceError('provider_not_configured');
    const entries = await Promise.all(MARKET_SYMBOLS.map(async (symbol) => [symbol, await this.provider.validateSymbol(symbol)] as const));
    return Object.fromEntries(entries) as Record<MarketSymbol, { supported: boolean; reason?: string }>;
  }

  private async getQuote(symbol: MarketSymbol): Promise<NormalizedQuote> {
    const cached = this.quoteCache.get(symbol);
    if (cached && Date.now() - cached.cachedAt < env.MARKET_DATA_CACHE_TTL_SECONDS * 1000) {
      const observedAt = Date.parse(cached.value.observedAt ?? '');
      const quoteAge = Date.now() - observedAt;
      if (cached.value.status !== 'live' || Number.isFinite(quoteAge) && quoteAge >= -5_000 && quoteAge <= 30_000) {
        return cached.value;
      }
    }

    const request = this.quoteRequests.get(symbol) ?? this.provider.getQuote(symbol);
    this.quoteRequests.set(symbol, request);
    try {
      const quote = await request;
      if (quote.status === 'live' || quote.status === 'delayed') {
        this.quoteCache.set(symbol, { value: quote, cachedAt: Date.now() });
      }
      if (quote.status === 'unavailable' && cached) {
        return { ...cached.value, price: null, status: 'stale', error: quote.error };
      }
      if (quote.status === 'stale' && cached) {
        return { ...cached.value, price: null, status: 'stale', error: 'stale' };
      }
      return quote;
    } finally {
      this.quoteRequests.delete(symbol);
    }
  }

  private fetchCandles(symbol: MarketSymbol, interval: MarketInterval, outputsize: number): Promise<NormalizedCandle[]> {
    return this.provider.getCandles(symbol, interval, outputsize);
  }
}

export const marketService = new MarketService();
