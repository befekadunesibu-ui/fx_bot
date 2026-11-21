import assert from 'node:assert/strict';
import { calculateIndicators } from '../src/modules/analysis/indicators.js';
import { buildAnalysis } from '../src/modules/analysis/analysis.service.js';
import { calculatePnl, calculatePositionSize, exitReason, simulatedEntryPrice, simulatedExitPrice } from '../src/modules/paper/paper.rules.js';
import type { NormalizedCandle } from '../src/modules/market/market.types.js';

const candles: NormalizedCandle[] = Array.from({ length: 80 }, (_, index) => {
  const close = 100 + index * 0.2 + Math.sin(index / 4);
  return { symbol: 'EUR/USD', interval: '1h', timestamp: new Date(2025, 0, index + 1).toISOString(), open: close - 0.1, high: close + 0.3, low: close - 0.3, close };
});

assert.ok(Number.isFinite(calculateIndicators(candles).ema20));
assert.ok(Number.isFinite(calculateIndicators(candles).rsi14));
assert.ok(Number.isFinite(calculateIndicators(candles).macd));
assert.ok(Number.isFinite(calculateIndicators(candles).atr14));
assert.throws(() => calculateIndicators(candles.slice(0, 20)), /At least 55/);
assert.throws(() => calculateIndicators([{ ...candles[0], close: Number.NaN }, ...candles.slice(1)]), /invalid numeric/i);

const analysis = buildAnalysis('EUR/USD', '1h', candles, new Date().toISOString(), 'live');
assert.equal(analysis.source, 'Twelve Data');
assert.ok(['bullish', 'bearish', 'neutral'].includes(analysis.trend));
assert.ok(analysis.supportingReasons.length > 0);
assert.equal(calculatePositionSize(10_000, 0.01, 100, 0.5), 200);
assert.equal(calculatePnl('long', 100, 101, 2), 2);
assert.equal(calculatePnl('short', 100, 99, 2), 2);
assert.equal(exitReason('long', 99, 99, 102), 'stop-loss');
assert.equal(exitReason('short', 98, 99, 98), 'take-profit');
assert.equal(exitReason('long', 100, 99, 102), null);
assert.ok(simulatedEntryPrice(100, 'long', 2, 1) > 100);
assert.ok(simulatedExitPrice(100, 'long', 2, 1) < 100);
assert.ok(simulatedEntryPrice(100, 'short', 2, 1) < 100);
assert.ok(simulatedExitPrice(100, 'short', 2, 1) > 100);

process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/fd-forex-ai-test';
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_ALLOWED_USER_IDS = '';
process.env.GEMINI_API_KEY = 'test-key';
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 42 }] } }] }), { status: 200 });
const { explainAnalysis, reviewStrategyDecision } = await import('../src/modules/ai/gemini.service.js');
await assert.rejects(() => explainAnalysis(analysis), /unavailable/i);
const makeAssessmentResponse = (assessment: unknown) => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ text: JSON.stringify(assessment) }] } }],
}), { status: 200 });
globalThis.fetch = async () => makeAssessmentResponse({
  assessment: 'supports',
  supportingEvidence: [analysis.supportingReasons[0]],
  contradictoryEvidence: [analysis.contradictingReasons[0]],
  uncertainty: 'none',
});
const verifiedExplanation = await explainAnalysis(analysis);
assert.ok(verifiedExplanation?.includes(analysis.supportingReasons[0]));
const alteredAnalysis = { ...analysis, timestamp: new Date(Date.now() + 60_000).toISOString() };
globalThis.fetch = async () => makeAssessmentResponse({
  assessment: 'supports',
  supportingEvidence: ['Invented price is 999'],
  contradictoryEvidence: [],
  uncertainty: 'none',
});
await assert.rejects(() => explainAnalysis(alteredAnalysis), /unavailable/i);
globalThis.fetch = async () => makeAssessmentResponse({
  assessment: 'supports',
  supportingEvidence: ['Invented quote: 999'],
  contradictoryEvidence: [],
  uncertainty: 'none',
});
await assert.rejects(() => reviewStrategyDecision({
  symbol: 'EUR/USD',
  quote: {
    symbol: 'EUR/USD', price: 1.1, bid: 1.0999, ask: 1.1001,
    source: 'Twelve Data', observedAt: new Date().toISOString(),
    fetchedAt: new Date().toISOString(), status: 'live',
  },
  analysis,
  newsFundamentals: null,
  decision: {
    decision: 'WAIT', confidence: 0, reason: 'Unclear.',
    supportingEvidence: analysis.supportingReasons,
    contradictoryEvidence: analysis.contradictingReasons,
    stopLoss: null, takeProfit: null,
    dataStatus: 'unavailable',
  },
}), /unavailable/i);
globalThis.fetch = async () => new Response('{}', { status: 429 });
await assert.rejects(() => explainAnalysis({
  ...analysis,
  timestamp: new Date(Date.now() + 120_000).toISOString(),
}), /unavailable/i);
globalThis.fetch = originalFetch;
console.log('Phase 2 analysis and Gemini tests passed');
