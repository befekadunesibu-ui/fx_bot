import { Router } from 'express';
import { requireTelegramAuth } from '../../middleware/telegramAuth.js';
import { userRateLimit } from '../../middleware/rateLimit.js';
import { candlesQuerySchema } from '../market/market.schemas.js';
import { analyzeMarket } from './analysis.service.js';

export const analysisRouter = Router();
analysisRouter.use(requireTelegramAuth);
analysisRouter.use(userRateLimit(30, 60_000));
analysisRouter.get('/', async (request, response, next) => {
  try {
    const query = candlesQuerySchema.parse(request.query);
    response.json({ analysis: await analyzeMarket(query.symbol, query.interval) });
  } catch (error) {
    next(error);
  }
});
