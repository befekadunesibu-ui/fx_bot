import { Router } from 'express';
import { env } from '../../config/env.js';

type TelegramUpdate = {
  message?: {
    chat?: { id?: number };
    from?: { id?: number };
    text?: string;
  };
};

type TelegramApiErrorResponse = {
  description?: string;
};

async function sendTelegramMessage(chatId: number, text: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: {
        inline_keyboard: [[{ text: 'Open FD Forex AI', web_app: { url: env.TELEGRAM_MINI_APP_URL } }]],
      },
    }),
  });

  if (!response.ok) {
    let description = '';
    try {
      const body = await response.json() as TelegramApiErrorResponse;
      description = body.description ? `: ${body.description}` : '';
    } catch {
      description = '';
    }
    throw new Error(`Telegram sendMessage failed with HTTP ${response.status}${description}`);
  }
}

export const telegramRouter = Router();

telegramRouter.post('/webhook', async (request, response, next) => {
  if (
    env.TELEGRAM_WEBHOOK_SECRET &&
    request.get('x-telegram-bot-api-secret-token') !== env.TELEGRAM_WEBHOOK_SECRET
  ) {
    response.status(401).json({ error: 'Invalid webhook secret' });
    return;
  }

  const update = request.body as TelegramUpdate;
  const message = update.message;
  const userId = message?.from?.id;
  const chatId = message?.chat?.id;

  if (
    /^\/start(?:@\w+)?(?:\s|$)/i.test(message?.text?.trim() ?? '') &&
    typeof userId === 'number' &&
    typeof chatId === 'number' &&
    env.TELEGRAM_ALLOWED_USER_IDS.includes(String(userId))
  ) {
    try {
      await sendTelegramMessage(chatId, 'Welcome to FD Forex AI. Open the demo research workspace below.');
    } catch (error) {
      next(error);
      return;
    }
  }

  response.sendStatus(200);
});
