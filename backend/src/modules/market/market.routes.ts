import { Router } from 'express';
import { requireTelegramAuth } from '../../middleware/telegramAuth.js';
import { candlesQuerySchema, quotesQuerySchema } from './market.schemas.js';
import { marketService, MarketServiceError } from './market.service.js';
import { MARKET_SYMBOLS, type MarketInterval, type MarketSymbol } from './market.types.js';

export const marketRouter = Router();
marketRouter.use(requireTelegramAuth);

marketRouter.get('/quotes', async (request, response, next) => {
  try {
    const query = quotesQuerySchema.parse(request.query);
    const quotes = await marketService.getQuotes(query.symbols as MarketSymbol[]);
    response.json({ source: (await marketService.getStatus()).provider, fetchedAt: new Date().toISOString(), quotes });
  } catch (error) {
    next(error);
  }
});

marketRouter.get('/candles', async (request, response, next) => {
  try {
    const query = candlesQuerySchema.parse(request.query);
    const result = await marketService.getCandles(query.symbol, query.interval, query.outputsize);
    response.json({ source: (await marketService.getStatus()).provider, ...result });
  } catch (error) {
    next(error);
  }
});

marketRouter.get('/capabilities', async (_request, response, next) => {
  try {
    response.json({ source: (await marketService.getStatus()).provider, symbols: MARKET_SYMBOLS, capabilities: await marketService.getCapabilities() });
  } catch (error) {
    next(error);
  }
});

marketRouter.get('/status', async (_request, response, next) => {
  try { response.json(await marketService.getStatus()); } catch (error) { next(error); }
});
