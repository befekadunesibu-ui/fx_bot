import type { Timeframe } from './marketData';
import { getTelegramInitData, TelegramAuthenticationError } from './telegram';

export type AnalysisResult = {
  symbol: string;
  interval: string;
  indicators: { ema20: number; ema50: number; rsi14: number; macd: number; macdSignal: number; atr14: number; support: number; resistance: number };
  trend: 'bullish' | 'bearish' | 'neutral';
  marketCondition: 'trending' | 'ranging' | 'volatile' | 'unclear';
  marketStructure: 'bullish' | 'bearish' | 'neutral';
  candleConfirmation: 'bullish' | 'bearish' | 'neutral';
  setup: 'long-watch' | 'short-watch' | 'no-clear-setup';
  supportingReasons: string[];
  contradictingReasons: string[];
  timestamp: string;
  source: string;
  freshness: 'live' | 'stale';
};

const intervalByTimeframe: Record<Timeframe, string> = { '1H': '1h', '4H': '4h', '1D': '1day', '1W': '1week' };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const baseUrl = import.meta.env.VITE_API_BASE_URL;
  if (!baseUrl) throw new Error('VITE_API_BASE_URL is not configured');
  const initData = await getTelegramInitData();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(initData ? { Authorization: `tma ${initData}` } : {}), ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
    if (response.status === 401) throw new TelegramAuthenticationError(body?.error ?? 'Telegram authentication was rejected.');
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export function getAnalysis(symbol: string, timeframe: Timeframe) {
  return request<{ analysis: AnalysisResult; explanation: string | null; explanationError: string | null; educationalOnly: boolean }>(`/ai/analyze?symbol=${encodeURIComponent(symbol)}&interval=${intervalByTimeframe[timeframe]}`);
}

export type PaperAccount = { balance: number; realizedPnl: number; unrealizedPnl: number; equity: number };
export type PaperPosition = { _id: string; symbol: string; side: 'long' | 'short'; quantity: number; entryPrice: number; currentPrice: number; stopLoss: number; takeProfit: number };
export type PaperSettings = {
  enabled: boolean;
  riskPerTrade: number;
  maxOpenPositions: number;
  strategyVersion: string;
  engineStatus: 'RUNNING' | 'PAUSED' | 'STOPPED';
  strategyConfig: StrategyConfig;
};
export type StrategyConfig = {
  name: string;
  version: string;
  strategyVersion: string;
  tradingStyle: 'SCALP' | 'DAY' | 'SWING';
  instruments: string[];
  analysisTimeframe: string;
  entryTimeframe: string;
  analysisMethods: {
    rsi: boolean;
    macd: boolean;
    movingAverages: boolean;
    supportResistance: boolean;
    candlestickPatterns: boolean;
  };
  minimumConfidence: number;
  maxOpenPositions: number;
  riskPerPosition: number;
  maxDailyLoss: number;
  minimumRewardToRisk: number;
  confidenceIsHeuristic: boolean;
};
export type PaperEngine = { status: 'RUNNING' | 'PAUSED' | 'STOPPED'; message: string | null; updatedAt: string };
export type StrategyDecisionRecord = {
  decision: 'BUY SIMULATION' | 'SELL SIMULATION' | 'WAIT';
  confidence: number;
  reason: string;
  geminiAssessment: string | null;
  supportingEvidence: string[];
  contradictoryEvidence: string[];
  dataStatus: 'live' | 'stale' | 'unavailable' | 'market-closed';
  quoteFreshness: string;
  quoteObservedAt: string | null;
  quoteFetchedAt: string | null;
  marketAvailability: string;
  newsAvailability: string;
  indicators: AnalysisResult['indicators'] | null;
  riskControlStatus: { openPositions: number; maxOpenPositions: number; dailyLossLimitPercent: number; emergencyPaused: boolean } | null;
  createdAt: string;
  symbol: string;
};
export type StrategyRiskStatus = {
  maxOpenPositions: number;
  openPositions: number;
  riskPerPosition: number;
  maxDailyLoss: number;
  dailyRiskUsedPercent: number;
  emergencyPaused: boolean;
};
export type StrategyProviderStatus = {
  provider: string;
  connected: boolean;
  availableSymbols: string[];
  lastError: string | null;
};
export function getPaperData() {
  return Promise.all([
    request<{ account: PaperAccount }>('/paper/account'),
    request<{ positions: PaperPosition[] }>('/paper/positions'),
    request<{ trades: Array<{ symbol: string; side: string; pnl: number; reason: string; closedAt: string }> }>('/paper/trades'),
    request<{ settings: PaperSettings }>('/paper/automation'),
    request<{
      strategy: StrategyConfig;
      engine: PaperEngine;
      strategyVersion: string;
      marketProvider: StrategyProviderStatus;
      riskControlStatus: StrategyRiskStatus;
      latestDecision: StrategyDecisionRecord | null;
    }>('/paper/strategy'),
  ]).then(([account, positions, trades, automation, strategy]) => ({ ...account, ...positions, ...trades, ...automation, ...strategy }));
}

export function openPaperPosition(symbol: string, side: 'long' | 'short', quantity: number) {
  return request<{ position: PaperPosition }>('/paper/positions', {
    method: 'POST',
    body: JSON.stringify({ symbol, side, quantity }),
  });
}

export function closePaperPosition(id: string) {
  return request<{ position: PaperPosition & { pnl: number } }>(`/paper/positions/${encodeURIComponent(id)}/close`, { method: 'POST' });
}

export function updateStrategyConfig(config: StrategyConfig) {
  return request<{ settings: PaperSettings }>('/paper/strategy', { method: 'PATCH', body: JSON.stringify(config) });
}

export function startPaperEngine() {
  return request<{ settings: PaperSettings }>('/paper/engine/start', { method: 'POST' });
}

export function stopPaperEngine() {
  return request<{ settings: PaperSettings }>('/paper/engine/stop', { method: 'POST' });
}
