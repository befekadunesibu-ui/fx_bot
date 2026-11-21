import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { env } from '../config/env.js';

export type TelegramUser = {
  id: string;
  first_name?: string;
  last_name?: string;
  username?: string;
};

declare global {
  namespace Express {
    interface Request {
      telegramUser?: TelegramUser;
    }
  }
}

class TelegramAuthError extends Error {
  status = 401;
}

function verifyTelegramInitData(initData: string): TelegramUser {
  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  const userValue = params.get('user');

  if (!receivedHash || !Number.isInteger(authDate) || !userValue) {
    throw new TelegramAuthError('Invalid Telegram authentication data');
  }

  if (Math.abs(Date.now() / 1000 - authDate) > 86400) {
    throw new TelegramAuthError('Expired Telegram authentication data');
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(env.TELEGRAM_BOT_TOKEN).digest();
  const expectedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const receivedHashBuffer = Buffer.from(receivedHash, 'hex');
  const expectedHashBuffer = Buffer.from(expectedHash, 'hex');

  if (
    receivedHashBuffer.length !== expectedHashBuffer.length ||
    !timingSafeEqual(receivedHashBuffer, expectedHashBuffer)
  ) {
    throw new TelegramAuthError('Invalid Telegram authentication data');
  }

  let user: TelegramUser;
  try {
    user = JSON.parse(userValue) as TelegramUser;
  } catch {
    throw new TelegramAuthError('Invalid Telegram user data');
  }

  if (!user || typeof user.id !== 'number' && typeof user.id !== 'string') {
    throw new TelegramAuthError('Invalid Telegram user data');
  }

  const userId = String(user.id);
  if (!env.TELEGRAM_ALLOWED_USER_IDS.includes(userId)) {
    throw new TelegramAuthError('Telegram user is not authorized');
  }

  return { ...user, id: userId };
}

export const requireTelegramAuth: RequestHandler = (request, _response, next) => {
  const authorization = request.get('authorization');
  const initData = authorization?.startsWith('tma ')
    ? authorization.slice(4)
    : request.get('x-telegram-init-data');

  if (!initData) {
    next(new TelegramAuthError('Telegram authentication is required'));
    return;
  }

  try {
    request.telegramUser = verifyTelegramInitData(initData);
    next();
  } catch (error) {
    next(error);
  }
};
