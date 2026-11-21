import { z } from 'zod';
import { env } from '../../../config/env.js';
import { MARKET_SYMBOLS, type MarketDataProvider, type MarketInterval, type MarketProviderStatus, type MarketSymbol, type NormalizedCandle, type NormalizedQuote } from '../market.types.js';

const bridgeQuoteSchema = z.object({
  symbol: z.string(),
  bid: z.number().finite(),
  ask: z.number().finite(),
  time: z.string().nullable().optional(),
  fetchedAt: z.string().optional(),
});
const bridgeCandleSchema = z.object({
  time: z.string(),
  open: z.number().finite(),
  high: z.number().finite(),
  low: z.number().finite(),
  close: z.number().finite(),
  volume: z.number().finite().optional(),
});
const bridgeHealthSchema = z.object({
  connected: z.boolean(),
  symbols: z.array(z.string()).optional(),
  lastError: z.string().nullable().optional(),
});

const symbolMap: Record<MarketSymbol, string> = {
  'XAU/USD': env.MT5_SYMBOL_XAUUSD,
  'EUR/USD': env.MT5_SYMBOL_EURUSD,
  'GBP/USD': env.MT5_SYMBOL_GBPUSD,
  'USD/JPY': env.MT5_SYMBOL_USDJPY,
};
const timeframeMap: Record<MarketInterval, string> = {
  '1min': 'M1', '5min': 'M5', '15min': 'M15', '30min': 'M30', '1h': 'H1', '2h': 'H2',
  '4h': 'H4', '8h': 'H8', '1day': 'D1', '1week': 'W1', '1month': 'MN1',
};

export class Mt5Provider implements MarketDataProvider {
  readonly name = 'MetaTrader 5' as const;
  private lastSuccessfulUpdate: string | null = null;
  private lastError: string | null = null;

  async getQuote(symbol: MarketSymbol): Promise<NormalizedQuote> {
    const fetchedAt = new Date().toISOString();
    try {
      const raw = bridgeQuoteSchema.parse(await this.request('/quote', { symbol: symbolMap[symbol] }));
      const observedAt = raw.time ? new Date(raw.time).toISOString() : null;
      if (!Number.isFinite(raw.bid) || !Number.isFinite(raw.ask) || raw.bid <= 0 || raw.ask <= 0 || raw.ask < raw.bid) {
        throw new Error('MT5 bridge returned an invalid bid/ask quote');
      }
      const price = (raw.bid + raw.ask) / 2;
      const observedMilliseconds = observedAt ? Date.parse(observedAt) : Number.NaN;
      if (!observedAt || !Number.isFinite(observedMilliseconds) || observedMilliseconds > Date.now() + 5_000 || Date.now() - observedMilliseconds > env.MARKET_DATA_CACHE_TTL_SECONDS * 1000) {
        const ageSeconds = Number.isFinite(observedMilliseconds) ? Math.round((Date.now() - observedMilliseconds) / 1000) : null;
        this.lastError = `MT5 quote is stale for ${symbol} (ageSeconds=${ageSeconds ?? 'unknown'})`;
        console.warn(JSON.stringify({ event: 'market_quote_rejected', provider: this.name, symbol, reason: 'stale_timestamp', ageSeconds }));
        return { symbol, price: null, bid: raw.bid, ask: raw.ask, spread: raw.ask - raw.bid, source: this.name, observedAt, fetchedAt, status: 'stale', error: 'stale' };
      }
      this.lastSuccessfulUpdate = fetchedAt;
      this.lastError = null;
      return { symbol, price, bid: raw.bid, ask: raw.ask, spread: raw.ask - raw.bid, source: this.name, observedAt, fetchedAt, status: 'live' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'MT5 bridge request failed';
      this.lastError = message;
      console.warn(JSON.stringify({ event: 'market_quote_unavailable', provider: this.name, symbol, reason: message }));
      return { symbol, price: null, source: this.name, observedAt: null, fetchedAt, status: 'unavailable', error: 'bridge_unavailable' };
    }
  }

  async getCandles(symbol: MarketSymbol, interval: MarketInterval, outputsize: number): Promise<NormalizedCandle[]> {
    try {
      const raw = z.object({ candles: z.array(bridgeCandleSchema) }).parse(await this.request('/candles', {
        symbol: symbolMap[symbol], timeframe: timeframeMap[interval], count: String(outputsize),
      }));
      const candles = raw.candles.map((candle) => ({
        symbol, interval, timestamp: new Date(candle.time).toISOString(), open: candle.open,
        high: candle.high, low: candle.low, close: candle.close, volume: candle.volume,
      }));
      if (candles.some((candle) => Number.isNaN(Date.parse(candle.timestamp)))) {
        throw new Error('MT5 bridge returned an invalid candle timestamp');
      }
      return candles;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'MT5 candle request failed';
      this.lastError = message;
      console.warn(JSON.stringify({ event: 'market_candles_unavailable', provider: this.name, symbol, interval, reason: message }));
      throw error;
    }
  }

  async validateSymbol(symbol: MarketSymbol): Promise<{ supported: boolean; reason?: string }> {
    const status = await this.getStatus();
    return status.connected && (status.availableSymbols.includes(symbol) || status.availableSymbols.length === 0)
      ? { supported: true }
      : { supported: false, reason: status.lastError ?? `MT5 symbol ${symbolMap[symbol]} is unavailable` };
  }

  async getStatus(): Promise<MarketProviderStatus> {
    try {
      const health = bridgeHealthSchema.parse(await this.request('/health', {}));
      const availableSymbols = MARKET_SYMBOLS.filter((symbol) => !health.symbols || health.symbols.includes(symbolMap[symbol]));
      return { provider: this.name, connected: health.connected, lastSuccessfulUpdate: this.lastSuccessfulUpdate, availableSymbols, lastError: health.lastError ?? this.lastError };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'MT5 bridge unavailable';
      return { provider: this.name, connected: false, lastSuccessfulUpdate: this.lastSuccessfulUpdate, availableSymbols: [], lastError: this.lastError };
    }
  }

  private async request(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(path, `${env.MT5_BRIDGE_URL.replace(/\/+$/, '')}/`);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.MT5_TIMEOUT_MS);
    try {
      let response: Response;
      try {
        response = await fetch(url, { signal: controller.signal });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new Error(`MT5 bridge request timed out for ${path} after ${env.MT5_TIMEOUT_MS}ms`);
        }
        const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
        throw new Error(`MT5 bridge request failed for ${path}${cause}`);
      }
      const body = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(`MT5 bridge returned HTTP ${response.status}`);
      return body;
    } finally {
      clearTimeout(timer);
    }
  }
}
