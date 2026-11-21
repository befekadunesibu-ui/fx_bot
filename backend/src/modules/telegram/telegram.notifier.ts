import { env } from '../../config/env.js';
import { TelegramNotificationModel } from '../paper/models.js';

export async function notifyTelegramUser(userId: string, text: string, dedupeKey?: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ALLOWED_USER_IDS.includes(userId)) return;
  if (dedupeKey) {
    try {
      await TelegramNotificationModel.create({ dedupeKey, userId, text });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 11000) return;
      console.error('[telegram-notification] dedupe record failed');
      return;
    }
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: Number(userId), text }),
    });
    if (!response.ok) console.error('[telegram-notification] provider rejected notification');
  } catch {
    console.error('[telegram-notification] provider request failed');
  }
}
