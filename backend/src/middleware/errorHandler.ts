import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

function redactSensitiveValues(value: string): string {
  return value
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[REDACTED]')
    .replace(/(token|secret|authorization|x-telegram-bot-api-secret-token)(\s*[:=]\s*)\S+/gi, '$1$2[REDACTED]');
}

export const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  const stack = error instanceof Error ? error.stack : undefined;
  console.error('[api-error]', redactSensitiveValues(message));
  if (stack) {
    console.error(redactSensitiveValues(stack));
  }
  const status = error instanceof ZodError ? 400 : typeof error?.status === 'number' ? error.status : 500;
  response.status(status).json({
    error: status === 500 ? 'Internal server error' : error.message,
  });
};
