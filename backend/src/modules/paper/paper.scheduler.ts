import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { MARKET_SYMBOLS } from '../market/market.types.js';
import { notifyTelegramUser } from '../telegram/telegram.notifier.js';
import {
  AutomationSettingsModel, SchedulerStateModel,
} from './models.js';
import { markPositions, runAutomation } from './paper.service.js';

type SchedulerState = {
  emergencyPaused: boolean;
  pauseReason?: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: Date | null;
  running: boolean;
  lastRunAt?: Date | null;
  nextRunAt?: Date | null;
  lastError?: string | null;
  lastErrorAt?: Date | null;
  cycleCount: number;
};

type LeaseStore = {
  read(): Promise<SchedulerState>;
  acquire(owner: string, now: Date, expiresAt: Date): Promise<boolean>;
  complete(owner: string, values: Partial<SchedulerState>): Promise<void>;
  pause(reason: string): Promise<void>;
  resume(): Promise<void>;
};
type CycleResult = { processedUsers: number; errors?: string[] };
type CycleRunner = () => Promise<CycleResult>;

const globalId = 'global';
const instanceId = `${process.pid}-${randomUUID()}`;

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[REDACTED]').slice(0, 500);
  return 'Paper scheduler cycle failed';
}

const mongoLeaseStore: LeaseStore = {
  async read() {
    const state = await SchedulerStateModel.findById(globalId).lean();
    return (state ?? { emergencyPaused: false, running: false, cycleCount: 0 }) as SchedulerState;
  },
  async acquire(owner, now, expiresAt) {
    try {
      const state = await SchedulerStateModel.findOneAndUpdate(
        {
          _id: globalId,
          emergencyPaused: { $ne: true },
          $or: [{ leaseOwner: null }, { leaseExpiresAt: { $lte: now } }, { leaseOwner: owner }],
        },
        { $set: { leaseOwner: owner, leaseExpiresAt: expiresAt, running: true, updatedAt: now } },
        { upsert: true, new: true },
      ).lean();
      return state?.leaseOwner === owner;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 11000) return false;
      throw error;
    }
  },
  async complete(owner, values) {
    await SchedulerStateModel.updateOne({ _id: globalId, leaseOwner: owner }, {
      $set: { ...values, leaseOwner: null, leaseExpiresAt: null, running: false, updatedAt: new Date() },
    });
  },
  async pause(reason) {
    await SchedulerStateModel.findByIdAndUpdate(globalId, {
      $set: { emergencyPaused: true, pauseReason: reason, running: false, leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() },
    }, { upsert: true });
  },
  async resume() {
    await SchedulerStateModel.findByIdAndUpdate(globalId, {
      $set: { emergencyPaused: false, pauseReason: null, lastError: null, lastErrorAt: null, updatedAt: new Date() },
    }, { upsert: true });
  },
};

export class PaperScheduler {
  private timer: NodeJS.Timeout | undefined;
  private cycleInProcess = false;

  constructor(
    private readonly store: LeaseStore = mongoLeaseStore,
    private readonly intervalMs = env.PAPER_SCHEDULER_INTERVAL_MS,
    private readonly leaseMs = env.PAPER_SCHEDULER_LEASE_MS,
    private readonly cycleRunner: CycleRunner = runEnabledUsers,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.runCycle();
    this.timer = setInterval(() => void this.runCycle(), this.intervalMs);
    this.timer.unref();
    console.log(JSON.stringify({ event: 'paper_scheduler_started', intervalMs: this.intervalMs }));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    console.log(JSON.stringify({ event: 'paper_scheduler_stopped' }));
  }

  async status(): Promise<SchedulerState> {
    return this.store.read();
  }

  async emergencyPause(reason = 'Manual emergency pause'): Promise<void> {
    await this.store.pause(reason);
    console.log(JSON.stringify({ event: 'paper_scheduler_paused', reason }));
  }

  async resume(): Promise<void> {
    await this.store.resume();
    console.log(JSON.stringify({ event: 'paper_scheduler_resumed' }));
  }

  async runCycle(): Promise<void> {
    if (this.cycleInProcess) {
      console.log(JSON.stringify({ event: 'paper_scheduler_overlap_skipped' }));
      return;
    }
    this.cycleInProcess = true;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.leaseMs);
    try {
      const state = await this.store.read();
      if (state.emergencyPaused) return;
      if (!await this.store.acquire(instanceId, now, expiresAt)) return;
      const { processedUsers, errors = [] } = await this.cycleRunner();
      const nextRunAt = new Date(Date.now() + this.intervalMs);
      await this.store.complete(instanceId, {
        lastRunAt: now,
        nextRunAt,
        lastError: errors.length > 0 ? `${errors.length} user automation cycle(s) failed` : null,
        lastErrorAt: errors.length > 0 ? new Date() : null,
        cycleCount: (state.cycleCount ?? 0) + 1,
      });
      console.log(JSON.stringify({ event: 'paper_scheduler_cycle_completed', processedUsers, lastRunAt: now.toISOString(), nextRunAt: nextRunAt.toISOString() }));
    } catch (error) {
      const message = safeErrorMessage(error);
      console.error(JSON.stringify({ event: 'paper_scheduler_cycle_error', error: message }));
      await this.store.pause(message);
      console.log(JSON.stringify({ event: 'paper_scheduler_intervention_required' }));
    } finally {
      this.cycleInProcess = false;
    }
  }
}

export const paperScheduler = new PaperScheduler();

async function runEnabledUsers(): Promise<CycleResult> {
  const users = await AutomationSettingsModel.find({ engineStatus: 'RUNNING' }).select({ userId: 1 }).lean();
  let processedUsers = 0;
  const errors: string[] = [];
  for (const user of users) {
    try {
      await markPositions(user.userId);
      await runAutomation(user.userId, MARKET_SYMBOLS);
      processedUsers += 1;
    } catch (error) {
      const message = safeErrorMessage(error);
      errors.push(message);
      console.error(JSON.stringify({ event: 'paper_scheduler_user_error', userId: user.userId, error: message }));
      void notifyTelegramUser(user.userId, `Paper automation cycle failed for this user: ${message}. Other users continue.`, `scheduler-error:${user.userId}:${Math.floor(Date.now() / 300000)}`);
    }
  }
  return { processedUsers, errors };
}
