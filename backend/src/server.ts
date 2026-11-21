import { app } from './app.js';
import { connectDatabase } from './config/database.js';
import { env } from './config/env.js';
import { paperScheduler } from './modules/paper/paper.scheduler.js';
import { initializeStrategyDefaults } from './modules/paper/paper.service.js';
import { disconnectDatabase } from './config/database.js';

async function startServer(): Promise<void> {
  await connectDatabase();
  await initializeStrategyDefaults();
  const server = app.listen(env.PORT, () => {
    console.log(`FD Forex AI API listening on port ${env.PORT}`);
    paperScheduler.start();
  });
  const shutdown = async () => {
    paperScheduler.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectDatabase();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

startServer().catch((error: unknown) => {
  console.error('Unable to start server', error);
  process.exitCode = 1;
});
