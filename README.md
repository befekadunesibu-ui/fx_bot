# FD Forex AI

FD Forex AI is a private Telegram Mini App foundation for Forex market research, AI-assisted analysis, backtesting, and paper trading. Production market data is served by the backend through Twelve Data. It does not provide broker execution, real-money trading, or profit guarantees.

## Project structure

```text
FD_Forex_AI/
├── backend/
│   ├── src/
│   │   ├── config/                 # Environment and MongoDB modules
│   │   ├── middleware/             # Error handling and Telegram auth boundary
│   │   ├── modules/health/          # Health-check route
│   │   ├── modules/market/          # Protected Twelve Data quotes and candles
│   │   ├── app.ts
│   │   └── server.ts
│   ├── .env.example
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── src/
│   │   ├── App.tsx                 # Responsive shell and initial screens
│   │   ├── main.tsx
│   │   └── styles.css
│   ├── .env.example
│   ├── index.html
│   ├── package.json
│   └── ...
├── netlify.toml
├── .gitignore
└── package.json
```

## Requirements

- Node.js 20+
- MongoDB 7+ (local or hosted)
- npm

## Installation

From the project root:

```bash
npm install --prefix frontend
npm install --prefix backend
copy frontend\.env.example frontend\.env
copy backend\.env.example backend\.env
```

Set `MONGODB_URI`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`, and any environment-specific values in `backend/.env`. `TELEGRAM_ALLOWED_USER_IDS` must contain your Telegram numeric ID and your brother's numeric ID, separated by a comma. If it is missing or empty, all Telegram users are denied. The bot token remains server-side and must never be placed in the frontend environment.

Market Watch uses the Twelve Data API from the backend. Set `TWELVE_DATA_API_KEY` in `backend/.env` for development and in the backend hosting environment for production. Keep it server-side; never use a `VITE_` variable or expose it to the browser. `TWELVE_DATA_BASE_URL`, `MARKET_DATA_TIMEOUT_MS`, and `MARKET_DATA_CACHE_TTL_SECONDS` default to `https://api.twelvedata.com`, `10000`, and `30`. Missing, invalid, stale, timed-out, and rate-limited data are reported as unavailable/stale; the app does not substitute generated prices.

The MT5 provider and Python bridge remain legacy local-development tooling only. Production configuration rejects `MARKET_DATA_PROVIDER=mt5` and requires `MARKET_DATA_PROVIDER=twelve_data` plus `TWELVE_DATA_API_KEY`; the production backend never connects to localhost or 127.0.0.1 for MT5. Do not configure Railway with MT5 bridge variables or expose the bridge publicly.

Gemini explanations and independent assessments are optional and never control simulated trades. The default `GEMINI_TIMEOUT_MS` is 30000; the API distinguishes unavailable credentials, unsupported models, rate limits, timeouts, and provider failures while deterministic analysis remains authoritative.

Optional local MT5 development requires a Windows host with the terminal running and Market Watch symbols enabled; it is not supported on serverless hosts. Cloudflare Quick Tunnels are temporary development tunnels, not permanent production hosting; do not expose the MT5 bridge publicly.

## Development

Run the API and frontend in separate terminals:

```bash
npm run dev:backend
npm run dev:frontend
```

- Frontend: http://localhost:5173
- Health check: http://localhost:4000/api/health
- Telegram webhook endpoint: http://localhost:4000/api/telegram/webhook

The backend connects to MongoDB during startup. Telegram Mini App requests must send the raw `initData` in `Authorization: tma <initData>` (or `X-Telegram-Init-Data`). The backend verifies Telegram's HMAC-SHA256 signature, rejects stale data, and enforces `TELEGRAM_ALLOWED_USER_IDS`; frontend-submitted identity is not trusted. The protected identity endpoint is `GET /api/auth/me`.

Protected Market Watch endpoints are `GET /api/market/quotes?symbols=XAU/USD,EUR/USD,GBP/USD,USD/JPY`, `GET /api/market/candles?symbol=XAU/USD&interval=1h&outputsize=100`, `GET /api/market/capabilities`, and `GET /api/market/status`. They require the same verified Telegram `initData`. Responses include provider attribution, timestamps, status, and unavailable/stale states. Twelve Data plan access for commodities such as XAU/USD is account-dependent; the application reports provider restrictions and never substitutes a fabricated price.

Protected paper-simulation endpoints under `/api/paper` cover the virtual account, positions, trades, signals, strategy state, automation, position marking, and daily summaries. Each authenticated Telegram user is provisioned with the persisted **FD Smart Scalp Strategy v1** defaults, with its paper engine initially stopped. The Mini App's Customize Strategy form saves user-specific settings through `PATCH /api/paper/strategy`; `POST /api/paper/engine/start` validates the saved strategy and fresh configured-provider data before enabling that user's existing backend scheduler cycle, and `POST /api/paper/engine/stop` stops new entries without deleting open positions or user settings. Strategy versions and their defaults are controlled by backend releases; increment `FD_SMART_STRATEGY_VERSION` with a reviewed configuration change to migrate saved user settings. Each user's portfolio, settings, engine state, and decisions remain scoped to their verified Telegram ID.

FD Smart Scalp Strategy v1 defaults to SCALP, completed 15-minute candles, XAU/USD and GBP/USD, and all supported deterministic analysis methods. Users can select trading style, a supported timeframe, instruments, analysis methods, a minimum heuristic score (85-100), up to three open positions, and simulated risk of 0.1%-0.5% per position. The score is a heuristic, not a calibrated probability. A simulated entry requires a stop-loss and take-profit with at least 1:2 reward-to-risk, no duplicate instrument position, and no breach of the 2% daily simulated loss limit. The backend reserves each entry's risk budget atomically to prevent concurrent scheduler runs from exceeding the daily cap. It returns WAIT for conflicting/unclear evidence, stale or invalid quotes, unavailable analysis, the weekend market closure, or the global emergency pause.

Paper simulations use fresh provider-sourced prices. Twelve Data's price-only quote is used as the market reference and the paper engine applies only its configured simulated spread/slippage; no broker orders are sent. MT5 quotes, when used in local development, must still have a valid bid/ask book. The strategy also requires fresh completed candles and verified timestamped economic-news/fundamental evidence. A reliable news/fundamentals provider is not currently implemented, so automated evaluations fail closed with WAIT and will not open entries until that input is configured; missing news is never treated as clear conditions. Gemini receives verified market data, calculated indicators, and any verified news evidence to explain support, contradictions, and uncertainty; its assessment never authorizes or sizes an entry. Manual simulated entries continue to pass the saved deterministic strategy and risk checks.

Set `GEMINI_API_KEY` and optionally `GEMINI_MODEL` only in `backend/.env` to enable optional explanations and independent assessments. The application is paper-trading only: it does not place broker orders, control accounts, access broker credentials, or claim profitability.

Phase 2.1 starts the existing paper scheduler after MongoDB connects. It checks every five minutes by default, scans only users whose persisted `AutomationSettings.engineStatus` is `RUNNING`, and uses a MongoDB lease so only one backend instance runs a cycle. A failure for one user is logged and isolated from other users; an infrastructure-level cycle failure persistently pauses the scheduler and requires operator intervention. The Mini App exposes only per-user start/stop controls; it cannot pause or resume the global scheduler. The authenticated scheduler status endpoint is `GET /api/paper-scheduler/status`. Configure `PAPER_SCHEDULER_INTERVAL_MS` and `PAPER_SCHEDULER_LEASE_MS` in `backend/.env` when needed. This scheduler places no broker or real-money orders.

The bot's `/start` command is handled by `POST /api/telegram/webhook` and replies to allowlisted users with an **Open FD Forex AI** button using `TELEGRAM_MINI_APP_URL`. Telegram cannot deliver updates to localhost, and the Mini App button URL must also be publicly reachable over HTTPS. Set `TELEGRAM_MINI_APP_URL` to the public HTTPS frontend URL (not `http://localhost:5173`) when testing through Telegram. Set `TELEGRAM_WEBHOOK_BASE_URL` to a public HTTPS backend base URL, set a random `TELEGRAM_WEBHOOK_SECRET` of at least 16 characters, and register it explicitly with `npm run telegram:webhook --prefix backend -- register`. The script registers `${TELEGRAM_WEBHOOK_BASE_URL}/api/telegram/webhook`. Diagnose the current Telegram-side registration with `npm run telegram:webhook --prefix backend -- diagnose`. Never commit `backend/.env` or frontend `.env` files.

## Production builds

```bash
npm run build
```

This runs the TypeScript/backend build and the Vite/frontend production build. Use `npm run start --prefix backend` to start the compiled API.

For production, run the backend on a persistent host with MongoDB reachability; the scheduler starts only after the database connection succeeds and shuts down cleanly on `SIGINT`/`SIGTERM`. Verify `GET /api/health` reports `status: ok` and `database: connected`. Run `npm run telegram:webhook --prefix backend -- diagnose` after registering the webhook. A Twelve Data timeout should be investigated as network, quota, credentials, or provider status from the sanitized error code; Gemini errors are returned as `explanationError` while deterministic analysis remains available. Do not treat Cloudflare Quick Tunnels as permanent hosting.

## Netlify and Railway deployment

The repository includes a Netlify SPA configuration. Configure Railway's backend build, start, and health-check settings in the Railway service UI; this avoids the deprecated Railway config-as-code format. Deploy the services separately and do not commit environment values.

### Railway backend

1. Create a Railway service from this repository and set its **Root Directory** to `/backend`. In the service settings, set the build command to `npm run build`, the start command to `npm start`, and the health-check path to `/api/health`. Railway should install dependencies from `backend/package-lock.json`; the backend scripts build `dist/` and start `dist/server.js`.
2. Create a MongoDB Atlas cluster and a database user with only the required application database permissions. Add Railway's outbound address(es) to Atlas Network Access (use a restricted/static egress address where available; do not make the database publicly accessible without an IP restriction). Set `MONGODB_URI` on the Railway API service to the Atlas connection string. The backend refuses to start in production with a loopback MongoDB URI.
3. Configure these Railway variables by name:
   - `NODE_ENV`
   - `MONGODB_URI`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_ALLOWED_USER_IDS`
   - `FRONTEND_ORIGIN`
   - `TELEGRAM_MINI_APP_URL`
   - `TELEGRAM_WEBHOOK_SECRET`
   - `TELEGRAM_WEBHOOK_BASE_URL` when registering the Telegram webhook
   - `MARKET_DATA_PROVIDER` (must be `twelve_data`)
   - `TWELVE_DATA_API_KEY`
   - `GEMINI_API_KEY` and optionally `GEMINI_MODEL` when Gemini explanations are wanted
4. Set `NODE_ENV` to `production`. `FRONTEND_ORIGIN` must be the exact Netlify HTTPS origin, with no path or trailing slash. `TELEGRAM_MINI_APP_URL` must be the public Netlify HTTPS URL. `TELEGRAM_WEBHOOK_BASE_URL` is the public Railway HTTPS origin, with no path or trailing slash; set it before registering the webhook. `TELEGRAM_WEBHOOK_SECRET` must be a private random value of at least 16 characters. The production server validates these requirements, including the Twelve Data key, a non-empty Telegram user allowlist, and a remote MongoDB URI.
5. Railway provides `PORT`; the API listens on it. Do not set MT5 bridge variables in Railway. The app uses Twelve Data for quotes and candles; unavailable or stale provider data will not be substituted with generated prices. Paper trading remains simulation-only and is gated by fresh quotes/candles, strategy checks, risk limits, and verified news evidence. No real broker orders are supported.

### Netlify frontend

1. Create a Netlify site from this repository and use the included `netlify.toml`; it builds `frontend` and publishes its Vite `dist` output. The rewrite preserves React Router routes.
2. Set the Netlify environment variable `VITE_API_BASE_URL` to the Railway public HTTPS API base, including `/api` and with no trailing slash. Production frontend builds reject missing, non-HTTPS, loopback, or incorrectly suffixed values. This value is compiled into the frontend at build time; trigger a new deploy after setting or changing it. Do not put backend secrets in Netlify or any `VITE_` variable.
3. Confirm the Netlify origin exactly matches Railway's `FRONTEND_ORIGIN`, and set the Railway Mini App URL to the Netlify URL.

### Post-deployment verification

1. Open the Railway health URL ending in `/api/health`. It must return HTTP 200 with `status: ok` and `database: connected`; HTTP 503 or startup failure indicates MongoDB/configuration is not ready.
2. Open the Netlify site, then launch it from Telegram. Confirm the authenticated dashboard loads; direct browser access outside Telegram should not bypass Telegram HMAC validation or the user allowlist.
3. From the Telegram Mini App, check the protected market/provider status and confirm the provider is Twelve Data. Confirm a fresh API quote appears when the API key/account supports the symbol; unsupported symbols, quota limits, and stale responses must report errors/status rather than a synthetic live price.
4. Once the public Railway URL and webhook secret are configured, register the webhook explicitly with `npm run telegram:webhook --prefix backend -- register`, then verify it with `npm run telegram:webhook --prefix backend -- diagnose`. Registration is a manual post-deployment action; deployment itself does not change Telegram's webhook. Configure the Mini App domain in Telegram/BotFather to match the Netlify hostname.

Automated paper entries will remain WAIT until a reliable, timestamped economic-news/fundamentals provider is implemented and configured. This is an intentional fail-closed behavior, not a deployment failure. Existing paper accounts, risk controls, and user isolation remain backend/MongoDB-managed. Do not enable broker integrations or real-money order execution.