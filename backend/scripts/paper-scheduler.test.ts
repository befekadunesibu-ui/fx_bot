import assert from 'node:assert/strict';
import { PaperScheduler } from '../src/modules/paper/paper.scheduler.js';

type State = { emergencyPaused: boolean; running: boolean; cycleCount: number; leaseOwner?: string | null; lastError?: string | null };
function store(initial: Partial<State> = {}) {
  let state: State = { emergencyPaused: false, running: false, cycleCount: 0, ...initial };
  let locked = false;
  return {
    read: async () => ({ ...state }),
    acquire: async () => { if (locked) return false; locked = true; state.running = true; return true; },
    complete: async (_owner: string, values: Partial<State>) => { state = { ...state, ...values, running: false }; locked = false; },
    pause: async (reason: string) => { state = { ...state, emergencyPaused: true, running: false, lastError: reason }; locked = false; },
    resume: async () => { state = { ...state, emergencyPaused: false, lastError: null }; },
    state: () => state,
  };
}

const first = store();
let runs = 0;
const scheduler = new PaperScheduler(first, 60_000, 30_000, async () => { runs += 1; return { processedUsers: 4 }; });
await scheduler.runCycle();
assert.equal(runs, 1);
assert.equal(first.state().cycleCount, 1);
await scheduler.emergencyPause('test pause');
await scheduler.runCycle();
assert.equal(runs, 1);
await scheduler.resume();
await scheduler.runCycle();
assert.equal(runs, 2);

let release!: () => void;
const gate = new Promise<void>((resolve) => { release = resolve; });
let overlapRuns = 0;
const overlapping = new PaperScheduler(store(), 60_000, 30_000, async () => {
  overlapRuns += 1;
  await gate;
  return { processedUsers: 1 };
});
const firstRun = overlapping.runCycle();
const secondRun = overlapping.runCycle();
release();
await Promise.all([firstRun, secondRun]);
assert.equal(overlapRuns, 1);

const locked = store();
let failureRuns = 0;
const failing = new PaperScheduler(locked, 60_000, 30_000, async () => {
  failureRuns += 1;
  throw new Error('provider unavailable');
});
await failing.runCycle();
assert.equal(failureRuns, 1);
assert.equal(locked.state().emergencyPaused, true);
await failing.runCycle();
assert.equal(failureRuns, 1);
await failing.resume();
await failing.runCycle();
assert.equal(failureRuns, 2);

const started = new PaperScheduler(store(), 60_000, 30_000, async () => ({ processedUsers: 0 }));
started.start();
started.start();
started.stop();
console.log('Paper scheduler tests passed');
