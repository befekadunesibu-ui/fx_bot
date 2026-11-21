import { Router } from 'express';
import { requireTelegramAuth } from '../../middleware/telegramAuth.js';
import { userRateLimit } from '../../middleware/rateLimit.js';
import { candlesQuerySchema } from '../market/market.schemas.js';
import { analyzeMarket } from '../analysis/analysis.service.js';
import { explainAnalysis, GeminiServiceError } from './gemini.service.js';

export const aiRouter = Router();
aiRouter.use(requireTelegramAuth);
aiRouter.use(userRateLimit(10, 60_000));
aiRouter.get('/analyze', async (request, response, next) => {
  try {
    const query = candlesQuerySchema.parse(request.query);
    const analysis = await analyzeMarket(query.symbol, query.interval);
    try {
      response.json({ analysis, explanation: await explainAnalysis(analysis), explanationError: null, educationalOnly: true });
    } catch (error) {
      if (!(error instanceof GeminiServiceError)) throw error;
      console.error(JSON.stringify({ event: 'gemini_explanation_unavailable', code: error.code, status: error.status }));
      response.json({ analysis, explanation: null, explanationError: error.code, educationalOnly: true });
    }
  } catch (error) { next(error); }
});
