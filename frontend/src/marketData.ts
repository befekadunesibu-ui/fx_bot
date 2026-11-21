export type Timeframe = '1H' | '4H' | '1D' | '1W';
export type MarketStatus = 'live' | 'delayed' | 'stale' | 'unavailable';

export type MarketInstrument = {
  symbol: string;
  name: string;
  numericPrice: number | null;
  price: string;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  change: number | null;
  status: MarketStatus;
  currency: string;
  source: string;
  observedAt: string | null;
  fetchedAt: string;
  series: Partial<Record<Timeframe, number[]>>;
  error?: string;
};

export type MarketSeries = {
  values: number[];
  status: MarketStatus;
  fetchedAt: string;
};
export type MarketProviderStatus = {
  provider: string;
  connected: boolean;
  lastSuccessfulUpdate: string | null;
  availableSymbols: string[];
  lastError: string | null;
};

type QuoteResponse = {
  quotes: Array<{
    symbol: string;
    price: number | null;
    bid?: number | null;
    ask?: number | null;
    spread?: number | null;
    changePercent?: number;
    currency?: string;
    source: string;
    observedAt: string | null;
    fetchedAt: string;
    status: MarketStatus;
    error?: string;
  }>;
};

const instrumentNames: Record<string, string> = {
  'XAU/USD': 'Gold / US Dollar',
  'EUR/USD': 'Euro / US Dollar',
  'GBP/USD': 'British Pound / US Dollar',
  'USD/JPY': 'US Dollar / Japanese Yen',
};

const intervalByTimeframe: Record<Timeframe, string> = {
  '1H': '1h',
  '4H': '4h',
  '1D': '1day',
  '1W': '1week',
};

function apiUrl(path: string): string {
  const baseUrl = import.meta.env.VITE_API_BASE_URL;
  if (!baseUrl) throw new Error('VITE_API_BASE_URL is not configured');
  return `${baseUrl}${path}`;
}

async function authHeaders(): Promise<HeadersInit> {
  const initData = await getTelegramInitData();
  return { Authorization: `tma ${initData}` };
}

async function request<T>(path: string): Promise<T> {
  const response = await fetch(apiUrl(path), { headers: await authHeaders() });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
    if (response.status === 401) throw new TelegramAuthenticationError(body?.error ?? 'Telegram authentication was rejected.');
    throw new Error(body?.error ?? `Market data request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export interface MarketDataProvider {
  getInstruments(): Promise<MarketInstrument[]>;
  getSeries(symbol: string, timeframe: Timeframe): Promise<MarketSeries>;
}

export async function getMarketProviderStatus(): Promise<MarketProviderStatus> {
  return request<MarketProviderStatus>('/market/status');
}

export const apiMarketDataProvider: MarketDataProvider = {
  async getInstruments() {
    const body = await request<QuoteResponse>('/market/quotes');
    return body.quotes.map((quote) => ({
      symbol: quote.symbol,
      name: instrumentNames[quote.symbol] ?? quote.symbol,
      numericPrice: quote.price,
      price: quote.price === null ? 'Unavailable' : quote.price.toLocaleString(undefined, { maximumFractionDigits: 6 }),
      bid: quote.bid ?? null,
      ask: quote.ask ?? null,
      spread: quote.spread ?? null,
      change: quote.changePercent ?? null,
      status: quote.status,
      currency: quote.currency ?? 'USD',
      source: quote.source,
      observedAt: quote.observedAt,
      fetchedAt: quote.fetchedAt,
      series: {},
      error: quote.error,
    }));
  },

  async getSeries(symbol, timeframe) {
    const body = await request<{ candles: Array<{ close: number }>; status: 'live' | 'stale'; fetchedAt: string }>(
      `/market/candles?symbol=${encodeURIComponent(symbol)}&interval=${intervalByTimeframe[timeframe]}&outputsize=100`,
    );
    return { values: body.candles.map((candle) => candle.close), status: body.status, fetchedAt: body.fetchedAt };
  },
};
import { getTelegramInitData, TelegramAuthenticationError } from './telegram';
