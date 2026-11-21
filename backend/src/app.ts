import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { errorHandler } from './middleware/errorHandler.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { healthRouter } from './modules/health/health.routes.js';
import { telegramRouter } from './modules/telegram/telegram.routes.js';
import { marketRouter } from './modules/market/market.routes.js';
import { analysisRouter } from './modules/analysis/analysis.routes.js';
import { aiRouter } from './modules/ai/ai.routes.js';
import { paperRouter } from './modules/paper/paper.routes.js';
import { paperSchedulerRouter } from './modules/paper/paper.scheduler.routes.js';

export const app = express();

app.use(helmet());
const allowedOrigins = new Set([
  env.FRONTEND_ORIGIN,
  ...(env.NODE_ENV === 'production' ? [] : ['http://localhost:5173']),
]);
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('CORS origin is not allowed'));
  },
}));
app.use(express.json({ limit: '100kb' }));
app.use('/api/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/telegram', telegramRouter);
app.use('/api/market', marketRouter);
app.use('/api/analysis', analysisRouter);
app.use('/api/ai', aiRouter);
app.use('/api/paper', paperRouter);
app.use('/api/paper-scheduler', paperSchedulerRouter);
app.use(errorHandler);
