import { z } from 'zod';
import { MARKET_INTERVALS, MARKET_SYMBOLS } from './market.types.js';

export const quotesQuerySchema = z.object({
  symbols: z.string().optional().default(MARKET_SYMBOLS.join(',')),
}).transform(({ symbols }) => {
  const parsed = symbols.split(',').map((symbol) => symbol.trim()).filter(Boolean);
  return { symbols: [...new Set(parsed)] };
}).superRefine(({ symbols }, context) => {
  if (symbols.length === 0 || symbols.length > MARKET_SYMBOLS.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide between 1 and 4 symbols' });
  }
  for (const symbol of symbols) {
    if (!MARKET_SYMBOLS.includes(symbol as (typeof MARKET_SYMBOLS)[number])) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Unsupported symbol: ${symbol}` });
    }
  }
});

export const candlesQuerySchema = z.object({
  symbol: z.enum(MARKET_SYMBOLS),
  interval: z.enum(MARKET_INTERVALS).default('1h'),
  outputsize: z.coerce.number().int().min(1).max(500).default(100),
});
