export const MARKET_SYMBOLS = ['XAU/USD', 'EUR/USD', 'GBP/USD', 'USD/JPY'] as const;
export type MarketSymbol = (typeof MARKET_SYMBOLS)[number];

export const MARKET_INTERVALS = ['1min', '5min', '15min', '30min', '1h', '2h', '4h', '8h', '1day', '1week', '1month'] as const;
export type MarketInterval = (typeof MARKET_INTERVALS)[number];
export type MarketDataStatus = 'live' | 'delayed' | 'stale' | 'unavailable';

export type NormalizedQuote = {
  symbol: string;
  price: number | null;
  bid?: number | null;
  ask?: number | null;
  spread?: number | null;
  change?: number;
  changePercent?: number;
  currency?: string;
  source: string;
  observedAt: string | null;
  fetchedAt: string;
  status: MarketDataStatus;
  error?: 'provider_not_configured' | 'unsupported' | 'rate_limited' | 'timeout' | 'provider_error' | 'stale' | 'bridge_unavailable';
};

export type NormalizedCandle = {
  symbol: string;
  interval: string;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type MarketDataProvider = {
  readonly name: 'Twelve Data' | 'MetaTrader 5';
  getQuote(symbol: MarketSymbol): Promise<NormalizedQuote>;
  getCandles(symbol: MarketSymbol, interval: MarketInterval, outputsize: number): Promise<NormalizedCandle[]>;
  validateSymbol(symbol: MarketSymbol): Promise<{ supported: boolean; reason?: string }>;
  getStatus(): Promise<MarketProviderStatus>;
};

export type MarketProviderStatus = {
  provider: string;
  connected: boolean;
  lastSuccessfulUpdate: string | null;
  availableSymbols: readonly MarketSymbol[];
  lastError: string | null;
};
