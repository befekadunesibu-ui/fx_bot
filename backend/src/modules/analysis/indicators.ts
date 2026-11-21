import type { NormalizedCandle } from '../market/market.types.js';

export type TechnicalIndicators = {
  ema20: number;
  ema50: number;
  rsi14: number;
  macd: number;
  macdSignal: number;
  atr14: number;
  support: number;
  resistance: number;
};

function assertCandles(candles: NormalizedCandle[], minimum = 55): void {
  if (candles.length < minimum) throw new Error(`At least ${minimum} valid candles are required`);
  if (candles.some((candle) => ![candle.open, candle.high, candle.low, candle.close].every(Number.isFinite))) {
    throw new Error('Candle data contains invalid numeric values');
  }
  if (candles.some((candle) => candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0
    || candle.high < candle.low || candle.high < candle.open || candle.high < candle.close
    || candle.low > candle.open || candle.low > candle.close
    || !Number.isFinite(Date.parse(candle.timestamp)))) {
    throw new Error('Candle data contains invalid prices, ranges, or timestamps');
  }
  if (candles.some((candle, index) => index > 0 && Date.parse(candle.timestamp) <= Date.parse(candles[index - 1].timestamp))) {
    throw new Error('Candle timestamps must be strictly increasing');
  }
}

export function ema(values: number[], period: number): number {
  if (values.length < period) throw new Error(`At least ${period} values are required`);
  const multiplier = 2 / (period + 1);
  let result = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (const value of values.slice(period)) result = (value - result) * multiplier + result;
  return result;
}

export function rsi(values: number[], period = 14): number {
  if (values.length <= period) throw new Error(`At least ${period + 1} values are required`);
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (averageLoss === 0) return 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

export function atr(candles: NormalizedCandle[], period = 14): number {
  if (candles.length <= period) throw new Error(`At least ${period + 1} candles are required`);
  const ranges = candles.slice(1).map((candle, index) => Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - candles[index].close),
    Math.abs(candle.low - candles[index].close),
  ));
  return ranges.slice(-period).reduce((sum, value) => sum + value, 0) / period;
}

export function calculateIndicators(candles: NormalizedCandle[]): TechnicalIndicators {
  assertCandles(candles);
  const closes = candles.map((candle) => candle.close);
  const fast = closes.map((_, index) => index >= 25 ? ema(closes.slice(0, index + 1), 12) : 0).filter(Boolean);
  const slow = closes.map((_, index) => index >= 50 ? ema(closes.slice(0, index + 1), 26) : 0).filter(Boolean);
  const macdValues = fast.slice(-slow.length).map((value, index) => value - slow[index]);
  return {
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    rsi14: rsi(closes),
    macd: macdValues.at(-1) ?? 0,
    macdSignal: ema(macdValues, Math.min(9, macdValues.length)),
    atr14: atr(candles),
    support: Math.min(...candles.slice(-20).map((candle) => candle.low)),
    resistance: Math.max(...candles.slice(-20).map((candle) => candle.high)),
  };
}
