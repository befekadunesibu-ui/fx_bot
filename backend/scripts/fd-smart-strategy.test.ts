import assert from 'node:assert/strict';
import type { MarketAnalysis } from '../src/modules/analysis/analysis.service.js';
import type { MarketSymbol, NormalizedQuote } from '../src/modules/market/market.types.js';
import {
  DEFAULT_STRATEGY, createSignalDedupeKey, evaluateStrategy, hasValidStopAndTarget, strategyConfigSchema,
} from '../src/modules/paper/strategy.js';

const now = new Date('2025-01-06T12:00:00.000Z');
const quote: NormalizedQuote = {
  symbol: 'XAU/USD',
  price: 100,
  bid: 99.99,
  ask: 100.01,
  source: 'MetaTrader 5',
  observedAt: now.toISOString(),
  fetchedAt: now.toISOString(),
  status: 'live',
};

function analysis(direction: 'bullish' | 'bearish' = 'bullish'): MarketAnalysis {
  const isBullish = direction === 'bullish';
  return {
    symbol: 'XAU/USD',
    interval: '15min',
    indicators: {
      ema20: isBullish ? 101 : 99,
      ema50: 100,
      rsi14: isBullish ? 60 : 40,
      macd: isBullish ? 2 : -2,
      macdSignal: isBullish ? 1 : -1,
      atr14: 0.5,
      support: 98,
      resistance: 104,
    },
    trend: direction,
    marketCondition: 'trending',
    marketStructure: direction,
    candleConfirmation: direction,
    setup: isBullish ? 'long-watch' : 'short-watch',
    supportingReasons: [],
    contradictingReasons: [],
    timestamp: now.toISOString(),
    candleTimestamp: '2025-01-06T11:45:00.000Z',
    dataFetchedAt: now.toISOString(),
    source: 'MetaTrader 5',
    freshness: 'live',
  };
}

const verifiedNews = {
  status: 'verified' as const,
  source: 'test provider',
  observedAt: now.toISOString(),
  eventWindowClear: true,
  evidence: ['No high-impact event in the configured event window.'],
};

function evaluate(overrides: Partial<Parameters<typeof evaluateStrategy>[0]> = {}) {
  return evaluateStrategy({
    symbol: 'XAU/USD',
    quote,
    analysis: analysis(),
    newsFundamentals: verifiedNews,
    now,
    openPositionCount: 0,
    hasOpenPosition: false,
    dailyLossPercent: 0,
    ...overrides,
  });
}

assert.equal(DEFAULT_STRATEGY.name, 'FD Smart Scalp Strategy v1');
assert.equal(DEFAULT_STRATEGY.version, '1');
assert.equal(DEFAULT_STRATEGY.tradingStyle, 'SCALP');
assert.equal(DEFAULT_STRATEGY.entryTimeframe, '15min');
assert.equal(DEFAULT_STRATEGY.analysisTimeframe, '15min');
assert.deepEqual(DEFAULT_STRATEGY.instruments, ['XAU/USD', 'GBP/USD']);
assert.equal(DEFAULT_STRATEGY.minimumConfidence, 85);
assert.equal(DEFAULT_STRATEGY.maxOpenPositions, 3);
assert.equal(DEFAULT_STRATEGY.confidenceIsHeuristic, true);
assert.equal(strategyConfigSchema.safeParse({
  ...DEFAULT_STRATEGY,
  tradingStyle: 'DAY',
  instruments: ['GBP/USD'],
  entryTimeframe: '30min',
  analysisTimeframe: '30min',
  minimumConfidence: 90,
  maxOpenPositions: 2,
  riskPerPosition: 0.002,
}).success, true);
assert.equal(strategyConfigSchema.safeParse({
  ...DEFAULT_STRATEGY,
  instruments: ['EUR/USD'],
}).success, false);
assert.equal(strategyConfigSchema.safeParse({
  ...DEFAULT_STRATEGY,
  riskPerPosition: 0.01,
}).success, false);

const validLong = evaluate();
assert.equal(validLong.decision, 'BUY SIMULATION');
assert.equal(validLong.confidence, 100);
assert.ok(validLong.stopLoss !== null && validLong.takeProfit !== null);
assert.equal(hasValidStopAndTarget('long', 100, validLong.stopLoss, validLong.takeProfit), true);

const validShort = evaluate({
  symbol: 'GBP/USD',
  quote: { ...quote, symbol: 'GBP/USD' },
  analysis: { ...analysis('bearish'), symbol: 'GBP/USD' },
});
assert.equal(validShort.decision, 'SELL SIMULATION');
assert.equal(hasValidStopAndTarget('short', 100, validShort.stopLoss, validShort.takeProfit), true);

const twelveDataDecision = evaluate({
  quote: {
    symbol: 'XAU/USD',
    price: 100,
    source: 'Twelve Data',
    observedAt: now.toISOString(),
    fetchedAt: now.toISOString(),
    status: 'live',
  },
  analysis: { ...analysis(), source: 'Twelve Data' },
});
assert.equal(twelveDataDecision.decision, 'BUY SIMULATION');

const belowThreshold = evaluate({
  analysis: {
    ...analysis(),
    indicators: { ...analysis().indicators, rsi14: 75, resistance: 100.5 },
  },
});
assert.ok(belowThreshold.confidence < DEFAULT_STRATEGY.minimumConfidence);
assert.equal(belowThreshold.decision, 'WAIT');

assert.equal(evaluate({ analysis: { ...analysis(), trend: 'bearish' } }).decision, 'WAIT');
assert.equal(evaluate({
  analysis: { ...analysis(), candleConfirmation: 'neutral' },
}).decision, 'WAIT');
assert.equal(evaluate({ newsFundamentals: null }).decision, 'WAIT');
assert.equal(evaluate({
  newsFundamentals: { ...verifiedNews, eventWindowClear: false },
}).decision, 'WAIT');
assert.equal(evaluate({
  newsFundamentals: { ...verifiedNews, observedAt: '2025-01-06T05:00:00.000Z' },
}).decision, 'WAIT');

assert.equal(evaluate({
  quote: { ...quote, status: 'unavailable', price: null },
}).decision, 'WAIT');
assert.equal(evaluate({
  quote: { ...quote, source: 'Twelve Data' },
}).decision, 'WAIT');
assert.equal(evaluate({
  quote: { ...quote, fetchedAt: '2025-01-06T11:58:00.000Z', observedAt: '2025-01-06T11:58:00.000Z' },
}).decision, 'WAIT');
assert.equal(evaluate({
  quote: { ...quote, observedAt: '2025-01-06T12:07:00.000Z' },
}).decision, 'WAIT');
assert.equal(evaluate({
  analysis: { ...analysis(), candleTimestamp: '2025-01-06T12:00:00.000Z' },
}).decision, 'WAIT');
assert.equal(evaluate({
  analysis: { ...analysis(), candleTimestamp: '2025-01-06T10:45:00.000Z' },
}).decision, 'WAIT');

const closedMarket = evaluate({ now: new Date('2025-01-04T12:00:00.000Z') });
assert.equal(closedMarket.decision, 'WAIT');
assert.match(closedMarket.reason, /market is closed/i);

assert.equal(evaluate({ symbol: 'EUR/USD' as MarketSymbol }).decision, 'WAIT');
assert.equal(evaluate({
  symbol: 'GBP/USD',
  quote: { ...quote, symbol: 'GBP/USD' },
  analysis: { ...analysis(), symbol: 'GBP/USD' },
  config: { ...DEFAULT_STRATEGY, instruments: ['XAU/USD'] },
}).decision, 'WAIT');
assert.equal(evaluate({ hasOpenPosition: true }).decision, 'WAIT');
assert.equal(evaluate({ openPositionCount: DEFAULT_STRATEGY.maxOpenPositions }).decision, 'WAIT');
assert.equal(evaluate({ dailyLossPercent: 2 }).decision, 'WAIT');
assert.equal(evaluate({ emergencyPaused: true }).decision, 'WAIT');

assert.equal(hasValidStopAndTarget('long', 100, null, 102), false);
assert.equal(hasValidStopAndTarget('short', 100, 102, undefined), false);
assert.equal(hasValidStopAndTarget('long', 100, 101, 102), false);
assert.equal(hasValidStopAndTarget('short', 100, 98, 99), false);
assert.equal(hasValidStopAndTarget('long', 100, 99, 101), false);

const key = createSignalDedupeKey('user-a', 'XAU/USD', 12);
assert.equal(key, createSignalDedupeKey('user-a', 'XAU/USD', 12));
assert.notEqual(key, createSignalDedupeKey('user-b', 'XAU/USD', 12));
assert.notEqual(key, createSignalDedupeKey('user-a', 'GBP/USD', 12));

console.log('FD Smart Scalp Strategy tests passed');
