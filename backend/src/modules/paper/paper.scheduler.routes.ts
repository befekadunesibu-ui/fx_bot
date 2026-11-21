import { Router } from 'express';
import { requireTelegramAuth } from '../../middleware/telegramAuth.js';
import { paperScheduler } from './paper.scheduler.js';

export const paperSchedulerRouter = Router();
paperSchedulerRouter.use(requireTelegramAuth);

paperSchedulerRouter.get('/status', async (_request, response, next) => {
  try { response.json({ scheduler: await paperScheduler.status() }); } catch (error) { next(error); }
});
