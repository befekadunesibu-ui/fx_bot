import { z } from 'zod';
import { marketService } from '../market/market.service.js';
import type { MarketInterval, MarketSymbol, NormalizedCandle } from '../market/market.types.js';
import { calculateIndicators, type TechnicalIndicators } from './indicators.js';

export const analysisSchema = z.object({
  symbol: z.string(),
  interval: z.string(),
  indicators: z.object({
    ema20: z.number(), ema50: z.number(), rsi14: z.number(), macd: z.number(),
    macdSignal: z.number(), atr14: z.number(), support: z.number(), resistance: z.number(),
  }),
  trend: z.enum(['bullish', 'bearish', 'neutral']),
  marketCondition: z.enum(['trending', 'ranging', 'volatile', 'unclear']),
  marketStructure: z.enum(['bullish', 'bearish', 'neutral']),
  candleConfirmation: z.enum(['bullish', 'bearish', 'neutral']),
  setup: z.enum(['long-watch', 'short-watch', 'no-clear-setup']),
  supportingReasons: z.array(z.string()),
  contradictingReasons: z.array(z.string()),
  timestamp: z.string(),
  candleTimestamp: z.string(),
  dataFetchedAt: z.string(),
  source: z.string(),
  freshness: z.enum(['live', 'delayed', 'stale']),
});
export type MarketAnalysis = z.infer<typeof analysisSchema>;

export function buildAnalysis(symbol: MarketSymbol, interval: MarketInterval, candles: NormalizedCandle[], fetchedAt: string, freshness: 'live' | 'stale', source = 'Twelve Data'): MarketAnalysis {
  const indicators: TechnicalIndicators = calculateIndicators(candles);
  const latest = candles.at(-1)?.close ?? 0;
  const bullish = indicators.ema20 > indicators.ema50 && indicators.macd > indicators.macdSignal;
  const bearish = indicators.ema20 < indicators.ema50 && indicators.macd < indicators.macdSignal;
  const trend = bullish ? 'bullish' : bearish ? 'bearish' : 'neutral';
  const recent = candles.slice(-10);
  const prior = candles.slice(-20, -10);
  const recentHigh = Math.max(...recent.map((candle) => candle.high));
  const recentLow = Math.min(...recent.map((candle) => candle.low));
  const priorHigh = Math.max(...prior.map((candle) => candle.high));
  const priorLow = Math.min(...prior.map((candle) => candle.low));
  const marketStructure = recentHigh > priorHigh && recentLow > priorLow
    ? 'bullish' : recentHigh < priorHigh && recentLow < priorLow ? 'bearish' : 'neutral';
  const last = candles.at(-1)!;
  const previous = candles.at(-2)!;
  const candleRange = last.high - last.low;
  const bullishEngulfing = last.close > last.open && previous.close < previous.open
    && last.open <= previous.close && last.close >= previous.open;
  const bearishEngulfing = last.close < last.open && previous.close > previous.open
    && last.open >= previous.close && last.close <= previous.open;
  const bullishImpulse = candleRange > 0 && last.close > last.open
    && (last.close - last.low) / candleRange >= 0.75
    && (last.close - last.open) / candleRange >= 0.6;
  const bearishImpulse = candleRange > 0 && last.close < last.open
    && (last.high - last.close) / candleRange >= 0.75
    && (last.open - last.close) / candleRange >= 0.6;
  const candleConfirmation = bullishEngulfing || bullishImpulse
    ? 'bullish' : bearishEngulfing || bearishImpulse ? 'bearish' : 'neutral';
  const condition = indicators.atr14 / latest > 0.01 ? 'volatile' : Math.abs(indicators.ema20 - indicators.ema50) / latest > 0.002 ? 'trending' : 'ranging';
  const supportingReasons = [
    bullish ? 'EMA 20 is above EMA 50' : bearish ? 'EMA 20 is below EMA 50' : 'EMA relationship is mixed',
    bullish ? 'MACD is above its signal' : bearish ? 'MACD is below its signal' : 'MACD is near its signal',
  ];
  const contradictingReasons = [
    indicators.rsi14 > 70 ? 'RSI indicates overbought conditions' : indicators.rsi14 < 30 ? 'RSI indicates oversold conditions' : 'RSI is not at an extreme',
    condition === 'volatile' ? 'Volatility is elevated; setup risk is higher' : 'No exceptional volatility filter was triggered',
  ];
  return analysisSchema.parse({
    symbol, interval, indicators, trend, marketCondition: condition, marketStructure, candleConfirmation,
    setup: bullish && indicators.rsi14 < 70 ? 'long-watch' : bearish && indicators.rsi14 > 30 ? 'short-watch' : 'no-clear-setup',
    supportingReasons, contradictingReasons, timestamp: new Date().toISOString(),
    candleTimestamp: candles.at(-1)?.timestamp ?? '',
    dataFetchedAt: fetchedAt,
    source, freshness,
  });
}

export async function analyzeMarket(symbol: MarketSymbol, interval: MarketInterval): Promise<MarketAnalysis> {
  const result = await marketService.getCandles(symbol, interval, 150);
  if (result.status === 'stale') throw new Error('Stale market data cannot be analyzed');
  const provider = (await marketService.getStatus()).provider;
  return buildAnalysis(symbol, interval, result.candles, result.fetchedAt, result.status, provider);
}
