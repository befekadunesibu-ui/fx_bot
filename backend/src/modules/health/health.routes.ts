import { Router } from 'express';
import mongoose from 'mongoose';

export const healthRouter = Router();

healthRouter.get('/', (_request, response) => {
  const databaseConnected = mongoose.connection.readyState === 1;
  response.status(databaseConnected ? 200 : 503).json({
    status: databaseConnected ? 'ok' : 'degraded',
    database: databaseConnected ? 'connected' : 'disconnected',
    service: 'fd-forex-ai-api',
    timestamp: new Date().toISOString(),
  });
});
