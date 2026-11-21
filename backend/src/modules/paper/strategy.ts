import { z } from 'zod';
import type { MarketSymbol, NormalizedQuote } from '../market/market.types.js';
import type { MarketAnalysis } from '../analysis/analysis.service.js';

export const FD_SMART_STRATEGY_VERSION = 'fd-smart-scalp-v1';
export const STRATEGY_TIMEFRAME = '15min' as const;
export const STRATEGY_TIMEFRAMES = ['5min', '15min', '30min', '1h', '4h'] as const;
export const STRATEGY_MAX_QUOTE_AGE_MS = 30_000;
export const STRATEGY_MAX_CANDLE_AGE_MS = 30 * 60_000;
export const STRATEGY_MAX_NEWS_AGE_MS = 6 * 60 * 60_000;

export const strategyConfigSchema = z.object({
  name: z.literal('FD Smart Scalp Strategy v1'),
  version: z.literal('1'),
  strategyVersion: z.literal(FD_SMART_STRATEGY_VERSION),
  tradingStyle: z.enum(['SCALP', 'DAY', 'SWING']),
  instruments: z.array(z.enum(['XAU/USD', 'GBP/USD'])).min(1).max(2).refine((items) => new Set(items).size === items.length, 'Instruments must be unique'),
  analysisTimeframe: z.enum(STRATEGY_TIMEFRAMES),
  entryTimeframe: z.enum(STRATEGY_TIMEFRAMES),
  analysisMethods: z.object({
    rsi: z.boolean(),
    macd: z.boolean(),
    movingAverages: z.boolean(),
    supportResistance: z.boolean(),
    candlestickPatterns: z.boolean(),
  }).strict(),
  minimumConfidence: z.number().int().min(85).max(100),
  maxOpenPositions: z.number().int().min(1).max(3),
  riskPerPosition: z.number().min(0.001).max(0.005),
  maxDailyLoss: z.number().min(0.005).max(0.02),
  minimumRewardToRisk: z.number().min(2).max(5),
  confidenceIsHeuristic: z.literal(true),
}).strict().refine((config) => config.riskPerPosition <= config.maxDailyLoss, {
  message: 'Risk per position cannot exceed the daily simulated loss limit',
  path: ['riskPerPosition'],
});
export type StrategyConfig = z.infer<typeof strategyConfigSchema>;

export const DEFAULT_STRATEGY: StrategyConfig = {
  name: 'FD Smart Scalp Strategy v1',
  version: '1',
  strategyVersion: FD_SMART_STRATEGY_VERSION,
  tradingStyle: 'SCALP',
  instruments: ['XAU/USD', 'GBP/USD'],
  analysisTimeframe: STRATEGY_TIMEFRAME,
  entryTimeframe: STRATEGY_TIMEFRAME,
  analysisMethods: {
    rsi: true,
    macd: true,
    movingAverages: true,
    supportResistance: true,
    candlestickPatterns: true,
  },
  minimumConfidence: 85,
  maxOpenPositions: 3,
  riskPerPosition: 0.005,
  maxDailyLoss: 0.02,
  minimumRewardToRisk: 2,
  confidenceIsHeuristic: true,
};

export type StrategyDecision = 'BUY SIMULATION' | 'SELL SIMULATION' | 'WAIT';
export type StrategyEvaluation = {
  decision: StrategyDecision;
  confidence: number;
  reason: string;
  supportingEvidence: string[];
  contradictoryEvidence: string[];
  stopLoss: number | null;
  takeProfit: number | null;
  dataStatus: 'live' | 'stale' | 'unavailable' | 'market-closed';
};

export type VerifiedNewsFundamentals = {
  status: 'verified';
  source: string;
  observedAt: string;
  eventWindowClear: boolean;
  evidence: string[];
};

export type StrategyEvaluationInput = {
  symbol: MarketSymbol;
  quote: NormalizedQuote;
  executionPrice?: number;
  analysis: MarketAnalysis;
  higherTimeframeAnalysis?: MarketAnalysis;
  config?: StrategyConfig;
  newsFundamentals: VerifiedNewsFundamentals | null;
  now?: Date;
  openPositionCount: number;
  hasOpenPosition: boolean;
  dailyLossPercent: number;
  emergencyPaused?: boolean;
};

export function isForexMarketOpen(date: Date): boolean {
  const day = date.getUTCDay();
  const hour = date.getUTCHours();
  return !(day === 6 || day === 0 && hour < 22 || day === 5 && hour >= 22);
}

export function hasValidStopAndTarget(
  side: 'long' | 'short',
  entryPrice: number,
  stopLoss: number | null | undefined,
  takeProfit: number | null | undefined,
  minimumRewardToRisk = DEFAULT_STRATEGY.minimumRewardToRisk,
): boolean {
  if (stopLoss === null || stopLoss === undefined || takeProfit === null || takeProfit === undefined
    || ![entryPrice, stopLoss, takeProfit, minimumRewardToRisk].every(Number.isFinite)
    || entryPrice <= 0 || minimumRewardToRisk <= 0) return false;
  const validDirection = side === 'long'
    ? stopLoss < entryPrice && takeProfit > entryPrice
    : takeProfit < entryPrice && stopLoss > entryPrice;
  if (!validDirection) return false;
  const risk = Math.abs(entryPrice - stopLoss);
  const reward = Math.abs(takeProfit - entryPrice);
  return risk > 0 && reward / risk >= minimumRewardToRisk;
}

export function createSignalDedupeKey(
  userId: string,
  symbol: MarketSymbol,
  candleBucket: number,
  timeframe: string = STRATEGY_TIMEFRAME,
): string {
  return `${userId}:${symbol}:${timeframe}:${FD_SMART_STRATEGY_VERSION}:${candleBucket}`;
}

export function evaluateStrategy(input: StrategyEvaluationInput): StrategyEvaluation {
  const config = input.config ?? DEFAULT_STRATEGY;
  const wait = (
    reason: string,
    dataStatus: StrategyEvaluation['dataStatus'] = 'unavailable',
    confidence = 0,
    supportingEvidence: string[] = [],
    contradictoryEvidence: string[] = [],
  ): StrategyEvaluation => ({
    decision: 'WAIT', confidence, reason, supportingEvidence, contradictoryEvidence,
    stopLoss: null, takeProfit: null, dataStatus,
  });
  const now = input.now ?? new Date();
  const { quote, analysis } = input;

  if (input.emergencyPaused) return wait('The global emergency pause is active.');
  if (!isForexMarketOpen(now)) return wait('The FX market is closed; new simulated entries are paused.', 'market-closed');
  if (!config.instruments.some((instrument) => instrument === input.symbol)) return wait('This instrument is not enabled for this strategy.');
  if (quote.symbol !== input.symbol || !['Twelve Data', 'MetaTrader 5'].includes(quote.source) || quote.status !== 'live'
    || quote.price === null || !Number.isFinite(quote.price) || quote.price <= 0
    || quote.source === 'MetaTrader 5' && (
      quote.bid === null || quote.bid === undefined || quote.ask === null || quote.ask === undefined
      || !Number.isFinite(quote.bid) || !Number.isFinite(quote.ask)
      || quote.bid <= 0 || quote.ask < quote.bid
      || Math.abs((quote.bid + quote.ask) / 2 - quote.price) > Math.max(quote.price * 0.00001, 1e-8)
    )) {
    return wait('A valid, live quote from the configured market-data provider is unavailable.');
  }
  const fetchedAt = Date.parse(quote.fetchedAt);
  const observedAt = quote.observedAt ? Date.parse(quote.observedAt) : Number.NaN;
  if (!Number.isFinite(fetchedAt) || !Number.isFinite(observedAt)
    || now.getTime() - fetchedAt < -5_000 || now.getTime() - fetchedAt > STRATEGY_MAX_QUOTE_AGE_MS
    || now.getTime() - observedAt < -5_000 || now.getTime() - observedAt > STRATEGY_MAX_QUOTE_AGE_MS) {
    return wait('The market-data quote is stale or has a future/invalid timestamp.', 'stale');
  }
  if (analysis.symbol !== input.symbol || analysis.interval !== config.entryTimeframe
    || analysis.source !== quote.source || analysis.freshness !== 'live') {
    return wait(`Fresh completed ${config.entryTimeframe} candles from the quote provider are required.`);
  }
  const candleTime = Date.parse(analysis.candleTimestamp);
  const candleFetchedAt = Date.parse(analysis.dataFetchedAt);
  const entryTimeframeMs = timeframeMilliseconds(config.entryTimeframe);
  if (!Number.isFinite(candleTime) || !Number.isFinite(candleFetchedAt)
    || candleTime + entryTimeframeMs > now.getTime()
    || now.getTime() - candleTime > Math.max(STRATEGY_MAX_CANDLE_AGE_MS, entryTimeframeMs * 2)
    || candleFetchedAt > now.getTime() + 5_000
    || now.getTime() - candleFetchedAt > STRATEGY_MAX_QUOTE_AGE_MS) {
    return wait(`The latest ${config.entryTimeframe} candle is incomplete, stale, or has an invalid timestamp.`, 'stale');
  }
  if (input.higherTimeframeAnalysis) {
    const higher = input.higherTimeframeAnalysis;
    const higherCandleTime = Date.parse(higher.candleTimestamp);
    const higherFetchedAt = Date.parse(higher.dataFetchedAt);
    const higherTimeframeMs = timeframeMilliseconds(config.analysisTimeframe);
    if (higher.symbol !== input.symbol || higher.interval !== config.analysisTimeframe
      || higher.source !== quote.source || higher.freshness !== 'live'
      || !Number.isFinite(higherCandleTime) || !Number.isFinite(higherFetchedAt)
      || higherCandleTime + higherTimeframeMs > now.getTime()
      || now.getTime() - higherCandleTime > Math.max(STRATEGY_MAX_CANDLE_AGE_MS, higherTimeframeMs * 2)
      || higherFetchedAt > now.getTime() + 5_000 || now.getTime() - higherFetchedAt > STRATEGY_MAX_QUOTE_AGE_MS) {
      return wait('Higher-timeframe analysis is incomplete, stale, or invalid.', 'stale');
    }
    if (higher.trend === 'neutral' || higher.trend !== analysis.trend) {
      return wait(
        'The higher- and entry-timeframe trends conflict or are unclear.',
        'live',
        0,
        [],
        [`Higher timeframe: ${higher.trend}; entry timeframe: ${analysis.trend}.`],
      );
    }
  }
  if (!input.newsFundamentals || input.newsFundamentals.status !== 'verified'
    || !input.newsFundamentals.source.trim() || !input.newsFundamentals.evidence.length
    || !Number.isFinite(Date.parse(input.newsFundamentals.observedAt))
    || Date.parse(input.newsFundamentals.observedAt) > now.getTime() + 5_000
    || now.getTime() - Date.parse(input.newsFundamentals.observedAt) > STRATEGY_MAX_NEWS_AGE_MS) {
    return wait('Verified, timestamped economic news/fundamental data is unavailable; no news is inferred.');
  }
  if (!input.newsFundamentals.eventWindowClear) {
    return wait(
      'Verified news/fundamental evidence flags a relevant event; new entries are paused.',
      'live',
      0,
      [],
      input.newsFundamentals.evidence,
    );
  }
  if (input.openPositionCount >= config.maxOpenPositions) return wait(`The maximum of ${config.maxOpenPositions} simulated open positions has been reached.`, 'live');
  if (input.hasOpenPosition) return wait('A simulated position is already open for this instrument.', 'live');
  if (!Number.isFinite(input.dailyLossPercent) || input.dailyLossPercent >= config.maxDailyLoss * 100) {
    return wait(`The ${config.maxDailyLoss * 100}% daily simulated loss limit has been reached or cannot be verified.`, 'live');
  }

  const indicators = analysis.indicators;
  const indicatorValues = Object.values(indicators);
  if (indicatorValues.some((value) => !Number.isFinite(value))
    || indicators.ema20 <= 0 || indicators.ema50 <= 0 || indicators.atr14 <= 0
    || indicators.rsi14 < 0 || indicators.rsi14 > 100
    || indicators.support <= 0 || indicators.resistance <= indicators.support) {
    return wait(`${config.entryTimeframe} indicator values are invalid.`, 'unavailable');
  }
  const emaDirection = indicators.ema20 > indicators.ema50
    ? 'bullish' : indicators.ema20 < indicators.ema50 ? 'bearish' : 'neutral';
  const macdDirection = indicators.macd > indicators.macdSignal
    ? 'bullish' : indicators.macd < indicators.macdSignal ? 'bearish' : 'neutral';
  const direction = emaDirection === 'bullish' && analysis.trend === 'bullish'
    ? 'long'
    : emaDirection === 'bearish' && analysis.trend === 'bearish' ? 'short' : null;
  if (!direction) {
    return wait(
      `${config.entryTimeframe} trend and moving averages are unclear or contradictory.`,
      'live',
      0,
      [],
      [`Trend: ${analysis.trend}; moving averages: ${emaDirection}; MACD: ${macdDirection}.`],
    );
  }

  const isLong = direction === 'long';
  const price = quote.price;
  const executionPrice = input.executionPrice ?? price;
  if (!Number.isFinite(executionPrice) || executionPrice <= 0) return wait('The simulated execution price is invalid.');
  const stopDistance = Math.max(indicators.atr14 * 1.5, executionPrice * 0.0001);
  const stopLoss = isLong ? executionPrice - stopDistance : executionPrice + stopDistance;
  const takeProfit = isLong
    ? executionPrice + stopDistance * config.minimumRewardToRisk
    : executionPrice - stopDistance * config.minimumRewardToRisk;
  if (!hasValidStopAndTarget(direction, executionPrice, stopLoss, takeProfit, config.minimumRewardToRisk)) {
    return wait('A valid stop-loss and take-profit with minimum 1:2 reward-to-risk could not be calculated.', 'live');
  }
  const correctRsi = !config.analysisMethods.rsi || (isLong
    ? indicators.rsi14 >= 50 && indicators.rsi14 < 70
    : indicators.rsi14 <= 50 && indicators.rsi14 > 30);
  const roomToTarget = !config.analysisMethods.supportResistance || (isLong
    ? indicators.resistance >= takeProfit
    : indicators.support <= takeProfit);
  const candleAgrees = !config.analysisMethods.candlestickPatterns
    || analysis.candleConfirmation === directionToTrend(direction);
  const movingAverageAgrees = !config.analysisMethods.movingAverages
    || (isLong ? indicators.ema20 > indicators.ema50 : indicators.ema20 < indicators.ema50);
  const macdAgrees = !config.analysisMethods.macd
    || (isLong ? indicators.macd > indicators.macdSignal : indicators.macd < indicators.macdSignal);
  const evidence: string[] = [];
  const contradictions: string[] = [];
  let confidence = 0;
  const record = (passes: boolean, points: number, fact: string, contradiction: string) => {
    if (passes) {
      confidence += points;
      evidence.push(fact);
    } else {
      contradictions.push(contradiction);
    }
  };
  record(true, 20, `${config.entryTimeframe} trend direction is ${direction}.`, 'Entry-timeframe trend does not match the setup.');
  if (config.analysisMethods.movingAverages) record(movingAverageAgrees, 15, `EMA 20 is ${isLong ? 'above' : 'below'} EMA 50.`, 'Moving averages conflict with the setup.');
  if (config.analysisMethods.macd) record(macdAgrees, 15, `MACD is ${isLong ? 'above' : 'below'} its signal.`, 'MACD conflicts with the setup.');
  if (config.analysisMethods.rsi) record(correctRsi, 15, `RSI (${indicators.rsi14.toFixed(1)}) supports ${direction}.`, 'RSI is outside the permitted directional range.');
  if (config.analysisMethods.supportResistance) record(roomToTarget, 15, 'Support/resistance leaves room for configured reward-to-risk.', 'Nearby support/resistance blocks the configured target.');
  if (config.analysisMethods.candlestickPatterns) record(candleAgrees, 10, `The completed ${config.entryTimeframe} candlestick pattern confirms ${direction}.`, 'The completed candlestick pattern conflicts with the setup.');
  record(true, 10, `Verified news/fundamentals from ${input.newsFundamentals.source} were checked.`, 'News/fundamental evidence is unavailable or conflicts.');

  if (!candleAgrees || !roomToTarget || !movingAverageAgrees || !macdAgrees || contradictions.length > 0) {
    return wait('Indicator, candle, or support/resistance evidence conflicts with the proposed entry.', 'live', confidence, evidence, contradictions);
  }
  if (confidence < config.minimumConfidence) {
    return wait(
      `The heuristic strategy score is ${confidence}; the minimum is ${config.minimumConfidence}. This score is not a calibrated probability.`,
      'live',
      confidence,
      evidence,
      contradictions,
    );
  }
  return {
    decision: isLong ? 'BUY SIMULATION' : 'SELL SIMULATION',
    confidence,
    reason: `${config.entryTimeframe} deterministic checks passed with a heuristic score of ${confidence}/${config.minimumConfidence} minimum; this is not a probability.`,
    supportingEvidence: evidence,
    contradictoryEvidence: contradictions,
    stopLoss,
    takeProfit,
    dataStatus: 'live',
  };
}

export function timeframeMilliseconds(timeframe: string): number {
  const intervals: Record<string, number> = {
    '5min': 5 * 60_000,
    '15min': 15 * 60_000,
    '30min': 30 * 60_000,
    '1h': 60 * 60_000,
    '4h': 4 * 60 * 60_000,
  };
  const milliseconds = intervals[timeframe];
  if (!milliseconds) throw new Error(`Unsupported strategy timeframe: ${timeframe}`);
  return milliseconds;
}

function directionToTrend(direction: 'long' | 'short'): 'bullish' | 'bearish' {
  return direction === 'long' ? 'bullish' : 'bearish';
}
