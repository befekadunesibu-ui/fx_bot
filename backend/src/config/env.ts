import 'dotenv/config';
import { z } from 'zod';

const trimmedUrl = (fallback?: string) => z.preprocess(
  (value) => value === undefined && fallback !== undefined ? fallback : typeof value === 'string' && value.trim() === '' ? fallback : typeof value === 'string' ? value.trim() : value,
  z.string().url(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGODB_URI: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  FRONTEND_ORIGIN: trimmedUrl('http://localhost:5173'),
  TELEGRAM_MINI_APP_URL: trimmedUrl('http://localhost:5173'),
  TELEGRAM_WEBHOOK_BASE_URL: trimmedUrl().optional(),
  TELEGRAM_ALLOWED_USER_IDS: z.string().default('').transform((value) =>
    value.split(',').map((id) => id.trim()).filter(Boolean),
  ),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16).optional(),
  TWELVE_DATA_API_KEY: z.preprocess((value) => value === '' ? undefined : value, z.string().min(1).optional()),
  TWELVE_DATA_BASE_URL: z.string().url().default('https://api.twelvedata.com'),
  MARKET_DATA_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  MARKET_DATA_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(30),
  MARKET_DATA_PROVIDER: z.enum(['twelve_data', 'mt5']).default('twelve_data'),
  MT5_BRIDGE_URL: trimmedUrl('http://127.0.0.1:8765'),
  MT5_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  MT5_SYMBOL_XAUUSD: z.string().min(1).default('XAUUSD'),
  MT5_SYMBOL_EURUSD: z.string().min(1).default('EURUSD'),
  MT5_SYMBOL_GBPUSD: z.string().min(1).default('GBPUSD'),
  MT5_SYMBOL_USDJPY: z.string().min(1).default('USDJPY'),
  GEMINI_API_KEY: z.preprocess((value) => value === '' ? undefined : value, z.string().min(1).optional()),
  GEMINI_MODEL: z.string().min(1).default('gemini-2.0-flash'),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  AI_ANALYSIS_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  PAPER_STARTING_BALANCE: z.coerce.number().positive().default(10000),
  PAPER_SCHEDULER_INTERVAL_MS: z.coerce.number().int().positive().default(300000),
  PAPER_SCHEDULER_LEASE_MS: z.coerce.number().int().positive().default(240000),
}).superRefine((config, context) => {
  if (config.NODE_ENV !== 'production') return;

  if (config.MARKET_DATA_PROVIDER !== 'twelve_data') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MARKET_DATA_PROVIDER'],
      message: 'MARKET_DATA_PROVIDER must be twelve_data in production',
    });
  }
  if (!config.TWELVE_DATA_API_KEY) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['TWELVE_DATA_API_KEY'],
      message: 'TWELVE_DATA_API_KEY is required in production',
    });
  }
  if (!config.TELEGRAM_WEBHOOK_SECRET) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['TELEGRAM_WEBHOOK_SECRET'],
      message: 'TELEGRAM_WEBHOOK_SECRET is required in production',
    });
  }
  if (config.TELEGRAM_ALLOWED_USER_IDS.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['TELEGRAM_ALLOWED_USER_IDS'],
      message: 'At least one Telegram user ID is required in production',
    });
  }

  const frontendOrigin = new URL(config.FRONTEND_ORIGIN);
  if (frontendOrigin.protocol !== 'https:' || frontendOrigin.origin !== config.FRONTEND_ORIGIN) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['FRONTEND_ORIGIN'],
      message: 'FRONTEND_ORIGIN must be an HTTPS origin without a path or trailing slash',
    });
  }

  const miniAppUrl = new URL(config.TELEGRAM_MINI_APP_URL);
  if (miniAppUrl.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(miniAppUrl.hostname)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['TELEGRAM_MINI_APP_URL'],
      message: 'TELEGRAM_MINI_APP_URL must be a public HTTPS URL in production',
    });
  }

  if (config.TELEGRAM_WEBHOOK_BASE_URL) {
    const webhookBaseUrl = new URL(config.TELEGRAM_WEBHOOK_BASE_URL);
    if (webhookBaseUrl.protocol !== 'https:' || webhookBaseUrl.origin !== config.TELEGRAM_WEBHOOK_BASE_URL) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TELEGRAM_WEBHOOK_BASE_URL'],
        message: 'TELEGRAM_WEBHOOK_BASE_URL must be an HTTPS origin without a path or trailing slash',
      });
    }
  }

  let mongoHost: string | null = null;
  try {
    const mongoUrl = new URL(config.MONGODB_URI);
    if (mongoUrl.protocol === 'mongodb:' || mongoUrl.protocol === 'mongodb+srv:') {
      mongoHost = mongoUrl.hostname.toLowerCase();
    }
  } catch {
    mongoHost = null;
  }
  if (!mongoHost || ['localhost', '127.0.0.1', '[::1]'].includes(mongoHost)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MONGODB_URI'],
      message: 'MONGODB_URI must use a remote MongoDB connection in production',
    });
  }
});

export const env = envSchema.parse(process.env);
