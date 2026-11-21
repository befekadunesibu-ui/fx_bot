import { Router } from 'express';
import { z } from 'zod';
import { requireTelegramAuth } from '../../middleware/telegramAuth.js';
import { userRateLimit } from '../../middleware/rateLimit.js';
import { MARKET_SYMBOLS } from '../market/market.types.js';
import { closeManualPosition, getAccountSummary, getOrCreateAccount, getSettings, getStrategyDashboard, markPositions, openManualPosition, runAutomation, saveStrategyConfig, startPaperEngine, stopPaperEngine } from './paper.service.js';
import { PaperPositionModel, PaperTradeModel, SignalModel } from './models.js';
import { notifyTelegramUser } from '../telegram/telegram.notifier.js';

export const paperRouter = Router();
paperRouter.use(requireTelegramAuth);
paperRouter.use(userRateLimit(60, 60_000));
const owner = (request: Parameters<typeof requireTelegramAuth>[0]) => request.telegramUser!.id;

paperRouter.get('/account', async (request, response, next) => {
  try {   response.json({ account: await getAccountSummary(owner(request)) }); } catch (error) { next(error); }
});
paperRouter.get('/positions', async (request, response, next) => {
  try { response.json({ positions: await PaperPositionModel.find({ userId: owner(request), status: 'open' }).lean() }); } catch (error) { next(error); }
});
paperRouter.post('/positions', async (request, response, next) => {
  try {
    const body = z.object({
      symbol: z.enum(MARKET_SYMBOLS),
      side: z.enum(['long', 'short']),
      quantity: z.number().finite().positive().max(1_000_000),
    }).parse(request.body);
    response.status(201).json({ position: await openManualPosition(owner(request), body.symbol, body.side, body.quantity) });
  } catch (error) { next(error); }
});
paperRouter.post('/positions/:id/close', async (request, response, next) => {
  try {
    z.string().min(1).parse(request.params.id);
    response.json({ position: await closeManualPosition(owner(request), request.params.id) });
  } catch (error) { next(error); }
});
paperRouter.get('/trades', async (request, response, next) => {
  try { response.json({ trades: await PaperTradeModel.find({ userId: owner(request) }).sort({ closedAt: -1 }).limit(100).lean() }); } catch (error) { next(error); }
});
paperRouter.get('/signals', async (request, response, next) => {
  try { response.json({ signals: await SignalModel.find({ userId: owner(request) }).sort({ createdAt: -1 }).limit(100).lean() }); } catch (error) { next(error); }
});
paperRouter.get('/automation', async (request, response, next) => {
  try { response.json({ settings: await getSettings(owner(request)) }); } catch (error) { next(error); }
});
paperRouter.get('/strategy', async (request, response, next) => {
  try { response.json(await getStrategyDashboard(owner(request))); } catch (error) { next(error); }
});
paperRouter.patch('/strategy', async (request, response, next) => {
  try { response.json({ settings: await saveStrategyConfig(owner(request), request.body) }); } catch (error) { next(error); }
});
paperRouter.post('/engine/start', async (request, response, next) => {
  try { response.json({ settings: await startPaperEngine(owner(request)) }); } catch (error) { next(error); }
});
paperRouter.post('/engine/stop', async (request, response, next) => {
  try { response.json({ settings: await stopPaperEngine(owner(request)) }); } catch (error) { next(error); }
});
paperRouter.patch('/automation', async (request, response, next) => {
  try {
    const body = z.object({ enabled: z.boolean() }).strict().parse(request.body);
    if (body.enabled) {
      response.status(400).json({ error: 'Use START BOT to validate market data before enabling automation' });
      return;
    }
    response.json({ settings: await stopPaperEngine(owner(request)) });
  } catch (error) { next(error); }
});
paperRouter.post('/automation/run', async (request, response, next) => {
  try { response.json(await runAutomation(owner(request), MARKET_SYMBOLS)); } catch (error) { next(error); }
});
paperRouter.post('/positions/mark', async (request, response, next) => {
  try { await markPositions(owner(request)); response.json({ ok: true }); } catch (error) { next(error); }
});
paperRouter.post('/summary/notify', async (request, response, next) => {
  try {
    const userId = owner(request);
    const account = await getOrCreateAccount(userId);
    const positions = await PaperPositionModel.countDocuments({ userId, status: 'open' });
    await notifyTelegramUser(userId, `Daily simulated paper summary: balance ${account?.balance.toFixed(2)}, realized P/L ${account?.realizedPnl.toFixed(2)}, open positions ${positions}.`);
    response.json({ ok: true });
  } catch (error) { next(error); }
});
