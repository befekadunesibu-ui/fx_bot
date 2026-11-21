import { z } from 'zod';
import { env } from '../../config/env.js';
import type { MarketAnalysis } from '../analysis/analysis.service.js';
import type { StrategyEvaluation, VerifiedNewsFundamentals } from '../paper/strategy.js';
import type { NormalizedQuote } from '../market/market.types.js';

const assessmentSchema = z.object({
  assessment: z.enum(['supports', 'conflicts', 'uncertain']),
  supportingEvidence: z.array(z.string().max(300)).max(8),
  contradictoryEvidence: z.array(z.string().max(300)).max(8),
  uncertainty: z.enum([
    'none', 'timeframe_conflict', 'indicator_conflict', 'market_data_limitation',
    'risk_rule_not_met', 'news_unavailable', 'market_closed', 'stale_quote',
  ]),
}).strict();
export class GeminiServiceError extends Error {
  constructor(readonly code: 'not_configured' | 'rate_limited' | 'timeout' | 'unsupported_model' | 'invalid_credentials' | 'provider_error', readonly status?: number, message?: string) {
    super(message ?? 'AI explanation is currently unavailable');
  }
}

const cache = new Map<string, { expiresAt: number; text: string }>();

export async function reviewStrategyDecision(input: {
  symbol: string;
  quote: NormalizedQuote;
  analysis: MarketAnalysis;
  newsFundamentals: VerifiedNewsFundamentals | null;
  decision: StrategyEvaluation;
}): Promise<string | null> {
  if (!env.GEMINI_API_KEY) return null;
  const allowedSupport = input.decision.supportingEvidence;
  const allowedContradictions = input.decision.contradictoryEvidence;
  const prompt = {
    instruction: [
      'Return only a JSON object with fields assessment, supportingEvidence, contradictoryEvidence, uncertainty.',
      'assessment must be supports, conflicts, or uncertain. Use the closest allowed uncertainty code when needed.',
      'Select evidence strings only verbatim from the matching supplied evidence list; do not write new text or add facts, values, prices, indicators, candles, market conditions, news, or probabilities.',
      'This assessment is educational only. Gemini does not authorize or execute simulated entries.',
    ].join(' '),
    verifiedInput: {
      symbol: input.symbol,
      quote: {
        symbol: input.quote.symbol,
        price: input.quote.price,
        bid: input.quote.bid,
        ask: input.quote.ask,
        source: input.quote.source,
        observedAt: input.quote.observedAt,
        fetchedAt: input.quote.fetchedAt,
        status: input.quote.status,
      },
      analysis: input.analysis,
      verifiedNewsFundamentals: input.newsFundamentals,
      deterministicDecision: input.decision.decision,
      deterministicReason: input.decision.reason,
      allowedSupportingEvidence: allowedSupport,
      allowedContradictoryEvidence: allowedContradictions,
    },
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.GEMINI_TIMEOUT_MS);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: JSON.stringify(prompt) }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    });
    const body = await response.json() as { error?: { message?: string; status?: string }; candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    if (response.status === 429) throw new GeminiServiceError('rate_limited', response.status);
    if (response.status === 401 || response.status === 403) throw new GeminiServiceError('invalid_credentials', response.status);
    if (response.status === 404 || body.error?.status === 'NOT_FOUND') throw new GeminiServiceError('unsupported_model', response.status);
    if (!response.ok) throw new GeminiServiceError('provider_error', response.status);
    const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
    let decoded: unknown;
    try {
      decoded = JSON.parse(text ?? '');
    } catch {
      throw new GeminiServiceError('provider_error', undefined, 'AI assessment is unavailable: Gemini returned invalid structured content');
    }
    const assessment = assessmentSchema.parse(decoded);
    if (assessment.supportingEvidence.some((item) => !allowedSupport.includes(item))
      || assessment.contradictoryEvidence.some((item) => !allowedContradictions.includes(item))) {
      throw new GeminiServiceError('provider_error', undefined, 'AI assessment is unavailable: Gemini returned evidence not present in the verified analysis');
    }
    return [
      `Independent assessment: ${assessment.assessment}.`,
      `Supporting evidence: ${assessment.supportingEvidence.join('; ') || 'None selected.'}`,
      `Contradictory evidence: ${assessment.contradictoryEvidence.join('; ') || 'None selected.'}`,
      `Uncertainty: ${assessment.uncertainty.replaceAll('_', ' ')}.`,
    ].join(' ');
  } catch (error) {
    if (error instanceof GeminiServiceError) throw error;
    if (error instanceof z.ZodError) throw new GeminiServiceError('provider_error', undefined, 'AI assessment is unavailable: Gemini returned no usable assessment');
    if (error instanceof DOMException && error.name === 'AbortError') throw new GeminiServiceError('timeout', undefined, 'AI assessment is unavailable: Gemini request timed out');
    throw new GeminiServiceError('provider_error', undefined, 'AI assessment is unavailable: Gemini request failed');
  } finally {
    clearTimeout(timer);
  }
}

export async function explainAnalysis(analysis: MarketAnalysis): Promise<string | null> {
  if (!env.GEMINI_API_KEY) return null;
  const cacheKey = `${analysis.symbol}:${analysis.interval}:${analysis.timestamp.slice(0, 15)}:${analysis.trend}:${analysis.setup}:${JSON.stringify(analysis)}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.text;
  const prompt = {
    instruction: [
      'Return only a JSON object with fields assessment, supportingEvidence, contradictoryEvidence, uncertainty.',
      'assessment must be supports, conflicts, or uncertain. Use the closest allowed uncertainty code when needed.',
      'Select evidence strings only verbatim from the matching supplied evidence list; do not write new text or add facts, prices, indicators, market conditions, news, or probabilities.',
    ].join(' '),
    verifiedAnalysis: {
      symbol: analysis.symbol,
      interval: analysis.interval,
      indicators: analysis.indicators,
      trend: analysis.trend,
      marketCondition: analysis.marketCondition,
      marketStructure: analysis.marketStructure,
      candleConfirmation: analysis.candleConfirmation,
      allowedSupportingEvidence: analysis.supportingReasons,
      allowedContradictoryEvidence: analysis.contradictingReasons,
      freshness: analysis.freshness,
    },
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.GEMINI_TIMEOUT_MS);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: JSON.stringify(prompt) }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    });
    const body = await response.json() as { error?: { message?: string; status?: string; code?: number }; candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    if (response.status === 429) throw new GeminiServiceError('rate_limited', response.status, 'AI explanation unavailable: Gemini quota or rate limit reached');
    if (response.status === 401 || response.status === 403) throw new GeminiServiceError('invalid_credentials', response.status, 'AI explanation unavailable: Gemini credentials were rejected');
    if (response.status === 404 || body.error?.status === 'NOT_FOUND') throw new GeminiServiceError('unsupported_model', response.status, `AI explanation unavailable: Gemini model "${env.GEMINI_MODEL}" was not found or is unavailable`);
    if (!response.ok) throw new GeminiServiceError('provider_error', response.status, `AI explanation unavailable: ${body.error?.message?.slice(0, 300) ?? 'Gemini provider returned an error'}`);
    const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
    let decoded: unknown;
    try {
      decoded = JSON.parse(text ?? '');
    } catch {
      throw new GeminiServiceError('provider_error', undefined, 'AI explanation is unavailable: Gemini returned invalid structured content');
    }
    const assessment = assessmentSchema.parse(decoded);
    if (assessment.supportingEvidence.some((item) => !analysis.supportingReasons.includes(item))
      || assessment.contradictoryEvidence.some((item) => !analysis.contradictingReasons.includes(item))) {
      throw new GeminiServiceError('provider_error', undefined, 'AI explanation is unavailable: Gemini returned evidence not present in the verified analysis');
    }
    const result = [
      `Assessment: ${assessment.assessment}.`,
      `Supporting evidence: ${assessment.supportingEvidence.join('; ') || 'None selected.'}`,
      `Contradictory evidence: ${assessment.contradictoryEvidence.join('; ') || 'None selected.'}`,
      `Uncertainty: ${assessment.uncertainty.replaceAll('_', ' ')}.`,
    ].join(' ');
    cache.set(cacheKey, { text: result, expiresAt: Date.now() + env.AI_ANALYSIS_CACHE_TTL_SECONDS * 1000 });
    return result;
  } catch (error) {
    if (error instanceof GeminiServiceError) throw error;
    if (error instanceof z.ZodError) throw new GeminiServiceError('provider_error', undefined, 'AI explanation is unavailable: Gemini returned no usable explanation');
    if (error instanceof DOMException && error.name === 'AbortError') throw new GeminiServiceError('timeout', undefined, 'AI explanation is unavailable: Gemini request timed out');
    throw new GeminiServiceError('provider_error', undefined, 'AI explanation is unavailable: Gemini request failed');
  } finally {
    clearTimeout(timer);
  }
}
