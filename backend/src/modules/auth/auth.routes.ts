import { Router } from 'express';
import { requireTelegramAuth } from '../../middleware/telegramAuth.js';
import { getSettings } from '../paper/paper.service.js';

export const authRouter = Router();

authRouter.get('/me', requireTelegramAuth, async (request, response, next) => {
  try {
    await getSettings(request.telegramUser!.id);
    response.json({ user: request.telegramUser });
  } catch (error) {
    next(error);
  }
});
