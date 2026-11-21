import 'dotenv/config';
import { z } from 'zod';

const config = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_WEBHOOK_BASE_URL: z.string().url().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16).optional(),
}).parse(process.env);

const apiUrl = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`;
const webhookPath = '/api/telegram/webhook';

type TelegramApiResponse = {
  ok: boolean;
  description?: string;
  result?: {
    url?: string;
    has_custom_certificate?: boolean;
    pending_update_count?: number;
    last_error_message?: string;
    last_error_date?: number;
  };
};

async function telegramApi(method: string, body?: Record<string, string>): Promise<TelegramApiResponse> {
  const response = await fetch(`${apiUrl}/${method}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json() as TelegramApiResponse;
  if (!response.ok || !result.ok) {
    throw new Error(result.description ?? `Telegram API returned HTTP ${response.status}`);
  }
  return result;
}

async function diagnose(): Promise<void> {
  const result = await telegramApi('getWebhookInfo');
  const info = result.result ?? {};
  console.log(JSON.stringify({
    apiReachable: result.ok,
    webhookUrlConfigured: Boolean(info.url),
    webhookUrl: info.url || null,
    pendingUpdateCount: info.pending_update_count ?? 0,
    lastError: info.last_error_message ?? null,
  }, null, 2));
}

async function register(): Promise<void> {
  if (!config.TELEGRAM_WEBHOOK_BASE_URL) {
    throw new Error('TELEGRAM_WEBHOOK_BASE_URL is required for registration');
  }
  const url = new URL(config.TELEGRAM_WEBHOOK_BASE_URL);
  if (url.protocol !== 'https:') {
    throw new Error('TELEGRAM_WEBHOOK_BASE_URL must use HTTPS; Telegram cannot reach localhost');
  }
  if (!config.TELEGRAM_WEBHOOK_SECRET) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET is required for webhook registration');
  }
  const webhookUrl = `${config.TELEGRAM_WEBHOOK_BASE_URL.replace(/\/+$/, '')}${webhookPath}`;

  const result = await telegramApi('setWebhook', {
    url: webhookUrl,
    secret_token: config.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: JSON.stringify(['message']),
  });
  console.log(JSON.stringify({ registered: result.ok, webhookUrl }, null, 2));
}

const command = process.argv[2] ?? 'diagnose';
if (command !== 'diagnose' && command !== 'register') {
  console.error('Usage: npm run telegram:webhook -- diagnose|register');
  process.exitCode = 2;
} else {
  (command === 'diagnose' ? diagnose() : register()).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Telegram webhook operation failed');
    process.exitCode = 1;
  });
}
