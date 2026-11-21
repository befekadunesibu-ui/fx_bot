import assert from 'node:assert/strict';

process.env.MONGODB_URI = 'mongodb://test.invalid/fd-forex-ai';
process.env.TELEGRAM_BOT_TOKEN = 'local-test-token';
process.env.TELEGRAM_ALLOWED_USER_IDS = '111';
process.env.TELEGRAM_WEBHOOK_SECRET = 'local-test-webhook-secret';
process.env.TELEGRAM_MINI_APP_URL = 'https://mini-app.example.test';
process.env.FRONTEND_ORIGIN = 'http://localhost:5173';

const nativeFetch = globalThis.fetch;
let outboundShouldFail = false;
let outboundCalls = 0;
globalThis.fetch = async (input, init) => {
  if (typeof input === 'string' && input.includes('api.telegram.org')) {
    outboundCalls += 1;
    if (outboundShouldFail) {
      return new Response(JSON.stringify({ ok: false, description: 'BUTTON_URL_INVALID' }), { status: 400 });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }
  return nativeFetch(input, init);
};

const { app } = await import('../src/app.js');
const server = app.listen(0);
try {
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const update = {
    message: { from: { id: 111 }, chat: { id: 111 }, text: '/start@fd_forex_ai_bot' },
  };
  const request = (secret: string) => nativeFetch(`${baseUrl}/api/telegram/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
    body: JSON.stringify(update),
  });

  const rejected = await request('wrong-secret');
  assert.equal(rejected.status, 401);

  const accepted = await request('local-test-webhook-secret');
  assert.equal(accepted.status, 200);
  assert.equal(outboundCalls, 1);

  outboundShouldFail = true;
  const failed = await request('local-test-webhook-secret');
  assert.equal(failed.status, 500);
  assert.equal(outboundCalls, 2);
  console.log('Telegram webhook tests passed');
} finally {
  server.close();
}
