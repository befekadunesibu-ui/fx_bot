import { env } from '../../config/env.js';
import { marketService, MarketServiceError } from '../market/market.service.js';
import type { MarketInterval, MarketSymbol, NormalizedQuote } from '../market/market.types.js';
import { buildAnalysis, type MarketAnalysis } from '../analysis/analysis.service.js';
import { reviewStrategyDecision } from '../ai/gemini.service.js';
import { notifyTelegramUser } from '../telegram/telegram.notifier.js';
import {
  AutomationSettingsModel, MarketAnalysisModel, PaperAccountModel, PaperPositionModel,
  PaperTradeModel, SchedulerStateModel, SignalModel,
} from './models.js';
import type { AutomationSettingsDocument } from './models.js';
import { calculatePnl, calculatePositionSize, exitReason, simulatedEntryPrice, simulatedExitPrice } from './paper.rules.js';
import {
  DEFAULT_STRATEGY, evaluateStrategy, FD_SMART_STRATEGY_VERSION, hasValidStopAndTarget,
  isForexMarketOpen, STRATEGY_MAX_CANDLE_AGE_MS, STRATEGY_MAX_QUOTE_AGE_MS,
  createSignalDedupeKey, strategyConfigSchema, timeframeMilliseconds,
  type StrategyConfig, type StrategyEvaluation,
} from './strategy.js';

type UserPaperSettings = Omit<AutomationSettingsDocument, 'strategyConfig'> & {
  strategyConfig: StrategyConfig;
};

export class PaperMarketDataUnavailableError extends Error {
  readonly status = 503;
  constructor(message: string) {
    super(message);
    this.name = 'PaperMarketDataUnavailableError';
  }
}

class PaperEngineConflictError extends Error {
  readonly status = 409;
}

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 11000);
}

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strategySettings() {
  return {
    enabled: false,
    engineStatus: 'STOPPED' as const,
    engineMessage: 'Ready to start simulated paper trading.',
    engineStatusUpdatedAt: new Date(),
    riskPerTrade: DEFAULT_STRATEGY.riskPerPosition,
    maxOpenPositions: DEFAULT_STRATEGY.maxOpenPositions,
    openPositionCount: 0,
    spreadBps: 2,
    slippageBps: 1,
    strategyVersion: FD_SMART_STRATEGY_VERSION,
    strategyConfig: DEFAULT_STRATEGY,
    dailyRiskDate: new Date().toISOString().slice(0, 10),
    dailyRiskReservedPercent: 0,
  };
}

async function applyStrategyDefaults(userId: string, previousVersion?: string) {
  const existing = await AutomationSettingsModel.findOne({ userId }).lean();
  const defaults = strategySettings();
  if (!existing) {
    const openPositionCount = await PaperPositionModel.countDocuments({ userId, status: 'open' });
    try {
      return await AutomationSettingsModel.findOneAndUpdate(
        { userId },
        { $setOnInsert: { userId, ...defaults, openPositionCount } },
        { new: true, upsert: true },
      ).lean();
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      return AutomationSettingsModel.findOne({ userId }).lean();
    }
  }

  const version = previousVersion ?? existing.strategyVersion;
  if (version !== FD_SMART_STRATEGY_VERSION) {
    const updatedDefaults = {
      ...defaults,
      enabled: existing.enabled,
      engineStatus: existing.engineStatus ?? (existing.enabled ? 'RUNNING' : 'STOPPED'),
      engineMessage: existing.engineMessage ?? null,
      openPositionCount: await PaperPositionModel.countDocuments({ userId, status: 'open' }),
      updatedAt: new Date(),
    };
    await AutomationSettingsModel.updateOne({ userId, strategyVersion: version }, { $set: updatedDefaults });
    return AutomationSettingsModel.findOne({ userId }).lean();
  }
  const parsedConfig = strategyConfigSchema.safeParse(existing.strategyConfig);
  if (!parsedConfig.success || !existing.engineStatus || !existing.dailyRiskDate
    || !Number.isFinite(existing.dailyRiskReservedPercent)) {
    await AutomationSettingsModel.updateOne({ userId }, {
      $set: {
        strategyConfig: parsedConfig.success ? parsedConfig.data : DEFAULT_STRATEGY,
        engineStatus: existing.engineStatus ?? (existing.enabled ? 'RUNNING' : 'STOPPED'),
        engineStatusUpdatedAt: existing.engineStatusUpdatedAt ?? new Date(),
        engineMessage: existing.engineMessage ?? 'Strategy settings migrated to the current validated configuration.',
        dailyRiskDate: new Date().toISOString().slice(0, 10),
        dailyRiskReservedPercent: Number.isFinite(existing.dailyRiskReservedPercent) ? existing.dailyRiskReservedPercent : 0,
        riskPerTrade: parsedConfig.success ? parsedConfig.data.riskPerPosition : DEFAULT_STRATEGY.riskPerPosition,
        maxOpenPositions: parsedConfig.success ? parsedConfig.data.maxOpenPositions : DEFAULT_STRATEGY.maxOpenPositions,
      },
    });
    return AutomationSettingsModel.findOne({ userId }).lean();
  }
  return existing;
}

export async function initializeStrategyDefaults(): Promise<void> {
  const existingSettings = await AutomationSettingsModel.find({}).lean();
  for (const setting of existingSettings) {
    await applyStrategyDefaults(setting.userId, setting.strategyVersion);
    const openPositionCount = await PaperPositionModel.countDocuments({ userId: setting.userId, status: 'open' });
    await AutomationSettingsModel.updateOne({ userId: setting.userId }, { $set: { openPositionCount } });
  }
}

export async function getOrCreateAccount(userId: string) {
  return PaperAccountModel.findOneAndUpdate(
    { userId }, { $setOnInsert: { userId, balance: env.PAPER_STARTING_BALANCE } },
    { new: true, upsert: true },
  ).lean();
}

export async function getAccountSummary(userId: string) {
  const account = await getOrCreateAccount(userId);
  const settings = await getSettings(userId);
  const positions = await PaperPositionModel.find({ userId, status: 'open' }).lean();
  let unrealizedPnl = 0;
  for (const position of positions) {
    const quote = (await marketService.getQuotes([position.symbol as MarketSymbol]))[0];
    if (quote?.price !== null && quote?.price !== undefined && quote.status === 'live') {
      const exitPrice = simulatedExitPrice(quote.price, position.side, settings.spreadBps, settings.slippageBps);
      unrealizedPnl += calculatePnl(position.side, position.entryPrice, exitPrice, position.quantity);
    }
  }
  return { ...account, unrealizedPnl, equity: account.balance + unrealizedPnl };
}

export async function getSettings(userId: string) {
  let settings = await applyStrategyDefaults(userId);
  if (!settings) throw new Error('Paper strategy settings unavailable');
  const today = new Date().toISOString().slice(0, 10);
  if (settings.dailyRiskDate !== today) {
    await AutomationSettingsModel.updateOne(
      { userId, dailyRiskDate: { $ne: today } },
      { $set: { dailyRiskDate: today, dailyRiskReservedPercent: 0 } },
    );
    settings = await AutomationSettingsModel.findOne({ userId }).lean();
    if (!settings) throw new Error('Paper strategy settings unavailable');
  }
  const strategyConfig = strategyConfigSchema.parse(settings.strategyConfig);
  return {
    ...settings,
    enabled: settings.engineStatus === 'RUNNING',
    riskPerTrade: strategyConfig.riskPerPosition,
    maxOpenPositions: strategyConfig.maxOpenPositions,
    strategyVersion: FD_SMART_STRATEGY_VERSION,
    strategyConfig,
  };
}

export async function saveStrategyConfig(userId: string, value: unknown) {
  const config = strategyConfigSchema.parse(value);
  await getSettings(userId);
  const openPositionCount = await PaperPositionModel.countDocuments({ userId, status: 'open' });
  if (config.maxOpenPositions < openPositionCount) {
    throw new PaperEngineConflictError('Maximum simulated positions cannot be set below the number currently open');
  }
  const settings = await AutomationSettingsModel.findOneAndUpdate(
    { userId, engineStatus: { $in: ['STOPPED', 'PAUSED'] } },
    {
      $set: {
        strategyConfig: config,
        riskPerTrade: config.riskPerPosition,
        maxOpenPositions: config.maxOpenPositions,
        updatedAt: new Date(),
      },
    },
    { new: true },
  ).lean();
  if (!settings) throw new PaperEngineConflictError('Stop or pause simulated trading before editing strategy settings');
  return getSettings(userId);
}

async function validateEngineMarketData(userId: string): Promise<void> {
  const settings = await getSettings(userId);
  const config = settings.strategyConfig;
  const providerStatus = await marketService.getStatus();
  if (!providerStatus.connected) {
    throw new PaperMarketDataUnavailableError('The configured market-data provider is unavailable. The paper engine was not started.');
  }
  for (const symbol of config.instruments) {
    if (!providerStatus.availableSymbols.includes(symbol)) {
      throw new PaperMarketDataUnavailableError(`The market-data provider does not currently provide ${symbol}. The paper engine was not started.`);
    }
    await getFreshQuote(symbol);
    await getStrategyAnalysis(symbol, config.entryTimeframe);
    if (config.analysisTimeframe !== config.entryTimeframe) {
      await getStrategyAnalysis(symbol, config.analysisTimeframe);
    }
  }
}

async function setEngineStatus(
  userId: string,
  status: 'RUNNING' | 'PAUSED' | 'STOPPED',
  message: string,
  allowedCurrent?: Array<'RUNNING' | 'PAUSED' | 'STOPPED'>,
) {
  const filter = allowedCurrent
    ? { userId, engineStatus: { $in: allowedCurrent } }
    : { userId };
  const updated = await AutomationSettingsModel.findOneAndUpdate(filter, {
    $set: {
      engineStatus: status,
      enabled: status === 'RUNNING',
      engineMessage: message,
      engineStatusUpdatedAt: new Date(),
      updatedAt: new Date(),
    },
  }, { new: true }).lean();
  if (!updated) throw new PaperEngineConflictError('Paper engine status changed; refresh and try again');
  return getSettings(userId);
}

export async function startPaperEngine(userId: string) {
  const settings = await getSettings(userId);
  if (await isEmergencyPaused()) throw new PaperEngineConflictError('The global emergency pause is active. Resume it before starting this user engine.');
  await validateEngineMarketData(userId);
  if (settings.engineStatus === 'RUNNING') return settings;
  return setEngineStatus(
    userId,
    'RUNNING',
    'Running paper-only analysis. New entries require all configured safety checks and verified news data.',
    ['STOPPED', 'PAUSED'],
  );
}

export async function pausePaperEngine(userId: string) {
  const settings = await getSettings(userId);
  if (settings.engineStatus !== 'RUNNING') return settings;
  return setEngineStatus(userId, 'PAUSED', 'Paused by user. Existing simulated positions remain under paper management.', ['RUNNING']);
}

export async function resumePaperEngine(userId: string) {
  const settings = await getSettings(userId);
  if (settings.engineStatus === 'RUNNING') return settings;
  if (settings.engineStatus !== 'PAUSED') throw new Error('Use START to begin a stopped paper engine');
  if (await isEmergencyPaused()) throw new PaperEngineConflictError('The global emergency pause is active. Resume it before resuming this user engine.');
  await validateEngineMarketData(userId);
  return setEngineStatus(
    userId,
    'RUNNING',
    'Resumed paper-only analysis. New entries require all configured safety checks and verified news data.',
    ['PAUSED'],
  );
}

export async function stopPaperEngine(userId: string) {
  await getSettings(userId);
  return setEngineStatus(userId, 'STOPPED', 'Stopped by user. Open simulated positions remain visible and can be closed manually.');
}

export async function getStrategyDashboard(userId: string) {
  const settings = await getSettings(userId);
  const latest = await SignalModel.findOne({ userId, strategyVersion: FD_SMART_STRATEGY_VERSION })
    .sort({ createdAt: -1 }).lean();
  const [marketProvider, openPositions, emergencyPaused] = await Promise.all([
    marketService.getStatus(),
    PaperPositionModel.countDocuments({ userId, status: 'open' }),
    isEmergencyPaused(),
  ]);
  return {
    strategy: settings.strategyConfig,
    strategyVersion: settings.strategyVersion,
    engine: {
      status: settings.engineStatus,
      message: settings.engineMessage,
      updatedAt: settings.engineStatusUpdatedAt,
    },
    marketProvider,
    riskControlStatus: {
      maxOpenPositions: settings.strategyConfig.maxOpenPositions,
      openPositions,
      riskPerPosition: settings.strategyConfig.riskPerPosition,
      maxDailyLoss: settings.strategyConfig.maxDailyLoss,
      dailyRiskUsedPercent: settings.dailyRiskReservedPercent,
      emergencyPaused,
    },
    latestDecision: latest ? {
      ...latest,
      supportingEvidence: latest.analysis?.supportingEvidence ?? [],
      contradictoryEvidence: latest.analysis?.contradictoryEvidence ?? [],
      quoteFreshness: latest.analysis?.quoteFreshness ?? 'unavailable',
      quoteObservedAt: latest.analysis?.quoteObservedAt ?? null,
      quoteFetchedAt: latest.analysis?.quoteFetchedAt ?? null,
      marketAvailability: latest.analysis?.marketAvailability ?? 'unavailable',
      riskControlStatus: latest.analysis?.riskControlStatus ?? null,
      newsAvailability: latest.analysis?.newsFundamentals
        ? 'Verified timestamped source available'
        : 'Unavailable: no verified news/fundamentals provider is configured',
      indicators: asObjectRecord(asObjectRecord(latest.analysis?.analysis)?.indicators),
    } : null,
  };
}

async function getFreshQuote(symbol: MarketSymbol): Promise<Omit<NormalizedQuote, 'price'> & { price: number }> {
  let quote: NormalizedQuote | undefined;
  try {
    quote = (await marketService.getQuotes([symbol]))[0];
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Market provider request failed';
    console.warn(JSON.stringify({ event: 'paper_quote_unavailable', symbol, reason: message }));
    throw new PaperMarketDataUnavailableError(`Fresh market data is unavailable for ${symbol}. Try again when the provider is connected.`);
  }
  const price = quote?.price;
  const now = Date.now();
  const fetchedAt = Date.parse(quote?.fetchedAt ?? '');
  const observedAt = Date.parse(quote?.observedAt ?? '');
  const invalidProvider = !quote || !['Twelve Data', 'MetaTrader 5'].includes(quote.source);
  const invalidBook = quote?.source === 'MetaTrader 5'
    && (quote.bid === null || quote.bid === undefined || quote.ask === null || quote.ask === undefined
      || !Number.isFinite(quote.bid) || !Number.isFinite(quote.ask)
      || quote.bid <= 0 || quote.ask < quote.bid
      || price === null || price === undefined
      || Math.abs((quote.bid + quote.ask) / 2 - price) > Math.max(price * 0.00001, 1e-8));
  const maxAge = Math.min(env.MARKET_DATA_CACHE_TTL_SECONDS * 1000, STRATEGY_MAX_QUOTE_AGE_MS);
  if (!quote || quote.status !== 'live' || price === null || price === undefined || !Number.isFinite(price) || price <= 0
    || invalidProvider || invalidBook || !Number.isFinite(fetchedAt) || !Number.isFinite(observedAt)
    || now - fetchedAt < -5_000 || now - fetchedAt > maxAge
    || now - observedAt < -5_000 || now - observedAt > maxAge) {
    const reason = !quote ? 'missing_quote' : quote.status !== 'live' ? `${quote.status}_quote` : 'invalid_or_stale_quote';
    console.warn(JSON.stringify({ event: 'paper_quote_rejected', symbol, reason, providerStatus: quote?.status ?? 'missing', observedAt: quote?.observedAt ?? null, fetchedAt: quote?.fetchedAt ?? null }));
    throw new PaperMarketDataUnavailableError(`Fresh market data is unavailable for ${symbol}; the quote is invalid, stale, or not live.`);
  }
  return { ...quote, price };
}

async function getDailyLossState(userId: string, knownQuotes: Map<string, NormalizedQuote> = new Map()) {
  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [account, closedTrades, positions] = await Promise.all([
    getOrCreateAccount(userId),
    PaperTradeModel.find({ userId, closedAt: { $gte: startOfDay } }).select({ pnl: 1 }).lean(),
    PaperPositionModel.find({ userId, status: 'open' }).lean(),
  ]);
  if (!account) throw new Error('Paper account unavailable');
  const realizedToday = closedTrades.reduce((total, trade) => total + (Number.isFinite(trade.pnl) ? trade.pnl : 0), 0);
  let unrealized = 0;
  for (const position of positions) {
    let quote = knownQuotes.get(position.symbol);
    if (!quote) quote = await getFreshQuote(position.symbol as MarketSymbol);
    if (quote.status !== 'live' || quote.price === null || quote.price === undefined) {
      throw new PaperMarketDataUnavailableError(`Daily loss cannot be verified because the ${position.symbol} quote is unavailable.`);
    }
    const settings = await getSettings(userId);
    const exitPrice = simulatedExitPrice(quote.price, position.side, settings.spreadBps, settings.slippageBps);
    unrealized += calculatePnl(position.side, position.entryPrice, exitPrice, position.quantity);
  }
  const dailyPnl = realizedToday + unrealized;
  const startingBalance = Math.max(0.01, account.balance - realizedToday);
  const dailyLossPercent = Math.max(0, -dailyPnl) / startingBalance * 100;
  return { dailyPnl, dailyLossPercent, equity: account.balance + unrealized };
}

async function getStrategyAnalysis(symbol: MarketSymbol, timeframe: MarketInterval): Promise<MarketAnalysis> {
  try {
    const now = Date.now();
    const providerStatus = await marketService.getStatus();
    if (!providerStatus.connected
      || !providerStatus.availableSymbols.includes(symbol)) {
      throw new PaperMarketDataUnavailableError(`The market-data provider is unavailable or does not provide ${symbol}.`);
    }
    const result = await marketService.getCandles(symbol, timeframe, 150);
    const fetchedAt = Date.parse(result.fetchedAt);
    if (result.status !== 'live' || !Number.isFinite(fetchedAt)
      || fetchedAt > now + 5_000 || now - fetchedAt > STRATEGY_MAX_QUOTE_AGE_MS) {
      throw new PaperMarketDataUnavailableError(`Fresh ${timeframe} candles are unavailable from the market-data provider.`);
    }
    const intervalMilliseconds = timeframeMilliseconds(timeframe);
    const completedCandles = result.candles.filter((candle) => {
      const candleStart = Date.parse(candle.timestamp);
      return candle.symbol === symbol && candle.interval === timeframe
        && Number.isFinite(candleStart) && candleStart + intervalMilliseconds <= now;
    });
    const latestCandleAt = Date.parse(completedCandles.at(-1)?.timestamp ?? '');
    if (!Number.isFinite(latestCandleAt) || latestCandleAt > now
      || now - latestCandleAt > Math.max(STRATEGY_MAX_CANDLE_AGE_MS, intervalMilliseconds * 2)) {
      throw new PaperMarketDataUnavailableError(`No fresh, completed ${timeframe} candle is available.`);
    }
    return buildAnalysis(symbol, timeframe, completedCandles, result.fetchedAt, 'live', providerStatus.provider);
  } catch (error) {
    if (error instanceof MarketServiceError || error instanceof PaperMarketDataUnavailableError) throw error;
    throw new PaperMarketDataUnavailableError(`Fresh, valid completed ${timeframe} MT5 analysis data are unavailable.`);
  }
}

async function isEmergencyPaused(): Promise<boolean> {
  const state = await SchedulerStateModel.findById('global').select({ emergencyPaused: 1 }).lean();
  return state?.emergencyPaused === true;
}

async function reservePositionSlot(userId: string, config: StrategyConfig, requireRunning = false) {
  const settings = await getSettings(userId);
  const reserved = await AutomationSettingsModel.findOneAndUpdate(
    {
      userId,
      openPositionCount: { $lt: config.maxOpenPositions },
      ...(requireRunning ? { engineStatus: 'RUNNING' } : {}),
    },
    { $inc: { openPositionCount: 1 } },
    { new: true },
  ).lean();
  if (!reserved) {
    if (requireRunning && await getSettings(userId).then((current) => !current.enabled)) {
      throw new Error('The paper engine stopped before the simulated entry could be reserved');
    }
    throw new Error(`Maximum of ${config.maxOpenPositions} simulated open positions reached`);
  }
  return settings;
}

async function reserveDailyRiskBudget(userId: string, config: StrategyConfig): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);
  await AutomationSettingsModel.updateOne(
    { userId, dailyRiskDate: { $ne: today } },
    { $set: { dailyRiskDate: today, dailyRiskReservedPercent: 0 } },
  );
  const reserved = await AutomationSettingsModel.findOneAndUpdate(
    {
      userId,
      dailyRiskDate: today,
      dailyRiskReservedPercent: { $lte: config.maxDailyLoss * 100 - config.riskPerPosition * 100 },
    },
    { $inc: { dailyRiskReservedPercent: config.riskPerPosition * 100 } },
    { new: true },
  ).lean();
  return reserved !== null;
}

async function releaseDailyRiskBudget(userId: string, config: StrategyConfig): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await AutomationSettingsModel.updateOne(
    {
      userId,
      dailyRiskDate: today,
      dailyRiskReservedPercent: { $gte: config.riskPerPosition * 100 },
    },
    { $inc: { dailyRiskReservedPercent: -(config.riskPerPosition * 100) } },
  );
}

async function releasePositionSlot(userId: string): Promise<void> {
  await AutomationSettingsModel.updateOne({ userId, openPositionCount: { $gt: 0 } }, { $inc: { openPositionCount: -1 } });
}

async function createPosition(
  userId: string,
  symbol: MarketSymbol,
  side: 'long' | 'short',
  quantity: number,
  quotePrice: number,
  stopLoss: number,
  takeProfit: number,
  equity: number,
  settings: UserPaperSettings,
  requireRunning = false,
) {
  const entryPrice = simulatedEntryPrice(quotePrice, side, settings.spreadBps, settings.slippageBps);
  const stopDistance = Math.abs(entryPrice - stopLoss);
  const maximumQuantity = calculatePositionSize(equity, settings.strategyConfig.riskPerPosition, entryPrice, stopDistance);
  if (!hasValidStopAndTarget(side, entryPrice, stopLoss, takeProfit, settings.strategyConfig.minimumRewardToRisk)
    || ![entryPrice, quantity, equity, maximumQuantity].every(Number.isFinite)
    || quantity <= 0 || equity <= 0 || quantity > maximumQuantity) {
    throw new Error('Simulated entry requires valid position size, stop-loss, and take-profit values');
  }
  let reserved = false;
  try {
    settings = await reservePositionSlot(userId, settings.strategyConfig, requireRunning);
    reserved = true;
    const existing = await PaperPositionModel.findOne({ userId, symbol, status: 'open' });
    if (existing) throw new Error('An open simulated position already exists for this instrument');
    if (requireRunning && !(await getSettings(userId)).enabled) {
      throw new Error('The paper engine stopped before the simulated entry could be created');
    }
    const position = await PaperPositionModel.create({
      userId, symbol, side, quantity, entryPrice, currentPrice: entryPrice, stopLoss, takeProfit,
    });
    void notifyTelegramUser(userId, `Simulated paper entry: ${side} ${symbol} at ${entryPrice}. No real order was placed.`, `entry:${String(position._id)}`);
    return position.toObject();
  } catch (error) {
    if (reserved) await releasePositionSlot(userId);
    if (isDuplicateKeyError(error)) throw new Error('An open simulated position already exists for this instrument');
    throw error;
  }
}

async function saveDecision(
  userId: string,
  symbol: MarketSymbol,
  timeframe: MarketInterval,
  candleTimestamp: string | null,
  evaluation: StrategyEvaluation,
  analysis: Record<string, unknown> & { supportingEvidence?: string[]; contradictoryEvidence?: string[] },
  classification: string,
  setup: string,
  geminiAssessment: string | null = null,
) {
  const timestamp = Date.parse(candleTimestamp ?? '');
  const timeBucket = Number.isFinite(timestamp)
    ? Math.floor(timestamp / timeframeMilliseconds(timeframe))
    : Math.floor(Date.now() / timeframeMilliseconds(timeframe));
  const dedupeKey = createSignalDedupeKey(userId, symbol, timeBucket, timeframe);
  try {
    const signal = await SignalModel.create({
      userId,
      symbol,
      interval: timeframe,
      classification,
      setup,
      analysis,
      strategyVersion: FD_SMART_STRATEGY_VERSION,
      decision: evaluation.decision,
      confidence: evaluation.confidence,
      reason: evaluation.reason,
      geminiAssessment,
      dedupeKey,
    });
    return { signal: signal.toObject(), created: true };
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    return { signal: await SignalModel.findOne({ userId, dedupeKey }).lean(), created: false };
  }
}

export async function runAutomation(userId: string, symbols: readonly MarketSymbol[]) {
  let settings = await getSettings(userId);
  if (!settings.enabled) return { paused: true, signals: [] };
  const config = settings.strategyConfig;
  const results = [];
  for (const symbol of config.instruments.filter((instrument) => symbols.includes(instrument))) {
    settings = await getSettings(userId);
    if (!settings.enabled) break;
    let quote: Awaited<ReturnType<typeof getFreshQuote>> | undefined;
    let analysis: MarketAnalysis | undefined;
    let evaluation: StrategyEvaluation;
    if (!isForexMarketOpen(new Date())) {
      evaluation = {
        decision: 'WAIT', confidence: 0,
        reason: 'The FX market is closed; new simulated entries are paused.',
        supportingEvidence: [], contradictoryEvidence: [], stopLoss: null, takeProfit: null,
        dataStatus: 'market-closed',
      };
    } else {
      try {
        quote = await getFreshQuote(symbol);
        analysis = await getStrategyAnalysis(symbol, config.entryTimeframe);
        const higherTimeframeAnalysis = config.analysisTimeframe === config.entryTimeframe
          ? undefined
          : await getStrategyAnalysis(symbol, config.analysisTimeframe);
        const [openPositionCount, existingPosition, dailyLoss, emergencyPaused] = await Promise.all([
          PaperPositionModel.countDocuments({ userId, status: 'open' }),
          PaperPositionModel.exists({ userId, symbol, status: 'open' }),
          getDailyLossState(userId, new Map([[symbol, quote]])),
          isEmergencyPaused(),
        ]);
        const newsFundamentals = null;
        evaluation = evaluateStrategy({
          symbol,
          quote,
          executionPrice: analysis.trend === 'bullish'
            ? simulatedEntryPrice(quote.price, 'long', settings.spreadBps, settings.slippageBps)
            : analysis.trend === 'bearish'
              ? simulatedEntryPrice(quote.price, 'short', settings.spreadBps, settings.slippageBps)
              : quote.price,
          analysis,
          higherTimeframeAnalysis,
          config,
          newsFundamentals,
          openPositionCount,
          hasOpenPosition: Boolean(existingPosition),
          dailyLossPercent: dailyLoss.dailyLossPercent,
          emergencyPaused,
        });
      } catch (error) {
        if (!(error instanceof PaperMarketDataUnavailableError || error instanceof MarketServiceError)) throw error;
        evaluation = {
          decision: 'WAIT',
          confidence: 0,
          reason: error.message,
          supportingEvidence: [],
          contradictoryEvidence: [],
          stopLoss: null,
          takeProfit: null,
          dataStatus: 'unavailable',
        };
      }
    }

    const snapshot = {
      analysis: analysis ?? null,
      ...evaluation,
      quoteFreshness: quote?.status ?? 'unavailable',
      quoteObservedAt: quote?.observedAt ?? null,
      quoteFetchedAt: quote?.fetchedAt ?? null,
      marketAvailability: analysis ? `MT5 connected · completed ${config.entryTimeframe} candles available` : evaluation.reason,
      riskControlStatus: {
        openPositions: await PaperPositionModel.countDocuments({ userId, status: 'open' }),
        maxOpenPositions: config.maxOpenPositions,
        dailyLossLimitPercent: config.maxDailyLoss * 100,
        emergencyPaused: await isEmergencyPaused(),
      },
      newsFundamentals: null,
    };
    const saved = await saveDecision(
      userId,
      symbol,
      config.entryTimeframe,
      analysis?.candleTimestamp ?? null,
      evaluation,
      snapshot,
      analysis?.trend ?? 'unclear',
      evaluation.decision === 'BUY SIMULATION' ? 'long-watch' : evaluation.decision === 'SELL SIMULATION' ? 'short-watch' : 'no-clear-setup',
    );
    if (!saved.signal || !saved.created) continue;
    const signal = saved.signal;

    let position = null;
    const quotePrice = quote?.price;
    const stopLoss = evaluation.stopLoss;
    const takeProfit = evaluation.takeProfit;
    if (evaluation.decision !== 'WAIT' && quote && quotePrice !== null && quotePrice !== undefined
      && stopLoss !== null && takeProfit !== null) {
      let riskBudgetReserved = false;
      try {
        const currentSettings = await getSettings(userId);
        if (!currentSettings.enabled) {
          evaluation = { ...evaluation, decision: 'WAIT', reason: 'The paper engine was stopped before this simulated entry.', stopLoss: null, takeProfit: null };
        } else {
          const account = await getOrCreateAccount(userId);
          if (!account) throw new Error('Paper account unavailable');
          const riskState = await getDailyLossState(userId, new Map([[symbol, quote]]));
          if (riskState.dailyLossPercent + config.riskPerPosition * 100 > config.maxDailyLoss * 100) {
            evaluation = { ...evaluation, decision: 'WAIT', reason: `The ${config.maxDailyLoss * 100}% daily simulated loss limit has been reached.`, stopLoss: null, takeProfit: null };
          } else if (!await reserveDailyRiskBudget(userId, config)) {
            evaluation = { ...evaluation, decision: 'WAIT', reason: 'The reserved daily simulated risk budget is exhausted.', stopLoss: null, takeProfit: null };
          } else {
            riskBudgetReserved = true;
            const side = evaluation.decision === 'BUY SIMULATION' ? 'long' : 'short';
            const entryPrice = simulatedEntryPrice(quotePrice, side, currentSettings.spreadBps, currentSettings.slippageBps);
            const stopDistance = Math.abs(entryPrice - stopLoss);
            const quantity = calculatePositionSize(riskState.equity, config.riskPerPosition, entryPrice, stopDistance);
            position = await createPosition(userId, symbol, side, quantity, quotePrice, stopLoss, takeProfit, riskState.equity, currentSettings, true);
            riskBudgetReserved = false;
          }
        }
      } catch (error) {
        if (riskBudgetReserved) await releaseDailyRiskBudget(userId, config);
        if (error instanceof PaperMarketDataUnavailableError
          || error instanceof Error && /maximum|already exists|paper engine stopped/i.test(error.message)) {
          evaluation = { ...evaluation, decision: 'WAIT', reason: error.message, stopLoss: null, takeProfit: null };
        } else {
          throw error;
        }
      }
    }
    const updatedSnapshot = { ...snapshot, ...evaluation };
    if (analysis) {
      await MarketAnalysisModel.create({ userId, symbol, interval: config.entryTimeframe, payload: updatedSnapshot });
      await SignalModel.updateOne({ _id: signal._id, userId }, {
        $set: {
          analysis: updatedSnapshot,
          decision: evaluation.decision,
          confidence: evaluation.confidence,
          reason: evaluation.reason,
          classification: analysis.trend,
          setup: evaluation.decision === 'BUY SIMULATION' ? 'long-watch' : evaluation.decision === 'SELL SIMULATION' ? 'short-watch' : 'no-clear-setup',
        },
      });
    }
    let geminiAssessment: string | null = null;
    if (quote?.price !== null && quote?.price !== undefined && quote.observedAt && analysis) {
      try {
        geminiAssessment = await reviewStrategyDecision({
          symbol,
          quote,
          decision: evaluation,
          analysis,
          newsFundamentals: null,
        });
      } catch (error) {
        console.warn(JSON.stringify({ event: 'gemini_strategy_assessment_unavailable', symbol, error: error instanceof Error ? error.message : 'unknown error' }));
      }
    }
    if (geminiAssessment) await SignalModel.updateOne({ _id: signal._id, userId }, { $set: { geminiAssessment } });
    results.push({
      signal: {
        ...signal,
        analysis: updatedSnapshot,
        decision: evaluation.decision,
        confidence: evaluation.confidence,
        reason: evaluation.reason,
        geminiAssessment,
      },
      position,
      decision: evaluation,
    });
    if (evaluation.decision !== 'WAIT') {
      void notifyTelegramUser(userId, `New simulated strategy signal: ${evaluation.decision} ${symbol} (${evaluation.confidence}% deterministic confidence). No real order was placed.`, `signal:${String(signal._id)}`);
    }
  }
  return { paused: false, signals: results };
}

export async function openManualPosition(userId: string, symbol: MarketSymbol, side: 'long' | 'short', quantity: number) {
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('Position size must be greater than zero');
  const settings = await getSettings(userId);
  const config = settings.strategyConfig;
  if (!config.instruments.some((instrument) => instrument === symbol)) throw new Error('This instrument is not enabled for the saved strategy');
  if (!isForexMarketOpen(new Date())) throw new PaperMarketDataUnavailableError('The FX market is closed; simulated entries are paused.');
  if (await isEmergencyPaused()) throw new Error('The global emergency pause is active.');
  const quote = await getFreshQuote(symbol);
  const analysis = await getStrategyAnalysis(symbol, config.entryTimeframe);
  const [account, openPositionCount, existing, dailyLoss, emergencyPaused] = await Promise.all([
    getOrCreateAccount(userId),
    PaperPositionModel.countDocuments({ userId, status: 'open' }),
    PaperPositionModel.exists({ userId, symbol, status: 'open' }),
    getDailyLossState(userId, new Map([[symbol, quote]])),
    isEmergencyPaused(),
  ]);
  if (!account) throw new Error('Paper account unavailable');
  if (openPositionCount >= config.maxOpenPositions) throw new Error(`Maximum of ${config.maxOpenPositions} simulated open positions reached`);
  if (existing) throw new Error('An open simulated position already exists for this instrument');
  if (dailyLoss.dailyLossPercent + config.riskPerPosition * 100 > config.maxDailyLoss * 100) {
    throw new Error(`The ${config.maxDailyLoss * 100}% daily simulated loss limit leaves insufficient room for another simulated position`);
  }
  const evaluation = evaluateStrategy({
    higherTimeframeAnalysis: config.analysisTimeframe === config.entryTimeframe
      ? undefined
      : await getStrategyAnalysis(symbol, config.analysisTimeframe),
    symbol, quote, executionPrice: simulatedEntryPrice(quote.price, side, settings.spreadBps, settings.slippageBps),
    analysis, config, newsFundamentals: null, openPositionCount,
    hasOpenPosition: Boolean(existing), dailyLossPercent: dailyLoss.dailyLossPercent, emergencyPaused,
  });
  const expectedSide = evaluation.decision === 'BUY SIMULATION' ? 'long'
    : evaluation.decision === 'SELL SIMULATION' ? 'short' : null;
  if (expectedSide !== side || evaluation.stopLoss === null || evaluation.takeProfit === null) {
    throw new Error(`Manual simulated entry rejected by FD Smart Strategy: ${evaluation.reason}`);
  }
  const entryPrice = simulatedEntryPrice(quote.price, side, settings.spreadBps, settings.slippageBps);
  const stopDistance = Math.abs(entryPrice - evaluation.stopLoss);
  const maxQuantity = calculatePositionSize(dailyLoss.equity, config.riskPerPosition, entryPrice, stopDistance);
  if (quantity > maxQuantity) throw new Error(`Position size exceeds the ${(config.riskPerPosition * 100).toFixed(2)}% simulated risk cap; maximum is ${maxQuantity.toFixed(4)}`);
  if (!await reserveDailyRiskBudget(userId, config)) throw new Error('The reserved daily simulated risk budget is exhausted');
  try {
    return await createPosition(userId, symbol, side, quantity, quote.price, evaluation.stopLoss, evaluation.takeProfit, dailyLoss.equity, settings);
  } catch (error) {
    await releaseDailyRiskBudget(userId, config);
    throw error;
  }
}

export async function markPositions(userId: string) {
  const positions = await PaperPositionModel.find({ userId, status: 'open' }).lean();
  for (const position of positions) {
    const quote = (await marketService.getQuotes([position.symbol as MarketSymbol]))[0];
    if (!quote || quote.price === null || quote.status !== 'live') continue;
    try {
      await getFreshQuote(position.symbol as MarketSymbol);
    } catch (error) {
      if (error instanceof PaperMarketDataUnavailableError) continue;
      throw error;
    }
    const settings = await getSettings(userId);
    const exitPrice = simulatedExitPrice(quote.price, position.side, settings.spreadBps, settings.slippageBps);
    const reason = exitReason(position.side, exitPrice, position.stopLoss, position.takeProfit);
    const pnl = calculatePnl(position.side, position.entryPrice, exitPrice, position.quantity);
    await PaperPositionModel.updateOne({ _id: position._id, userId, status: 'open' }, { currentPrice: exitPrice });
    if (reason) await closePosition(userId, String(position._id), exitPrice, reason, pnl);
  }
}

export async function closePosition(userId: string, id: string, exitPrice: number, reason: string, pnl: number) {
  const position = await PaperPositionModel.findOneAndUpdate({ _id: id, userId, status: 'open' }, { status: 'closed', currentPrice: exitPrice }, { new: true }).lean();
  if (!position) return null;
  await Promise.all([
    PaperTradeModel.create({
      userId, symbol: position.symbol, side: position.side, quantity: position.quantity,
      entryPrice: position.entryPrice, exitPrice, pnl, strategyVersion: FD_SMART_STRATEGY_VERSION,
      inputData: { stopLoss: position.stopLoss, takeProfit: position.takeProfit }, reason,
      openedAt: position.openedAt,
    }),
    PaperAccountModel.updateOne({ userId }, { $inc: { realizedPnl: pnl, balance: pnl }, $set: { updatedAt: new Date() } }),
    releasePositionSlot(userId),
  ]);
  void notifyTelegramUser(userId, `Simulated paper exit: ${position.symbol} at ${exitPrice}. Reason: ${reason}. P/L: ${pnl.toFixed(2)}. No real order was placed.`, `exit:${String(position._id)}`);
  return position;
}

export async function closeManualPosition(userId: string, id: string) {
  const position = await PaperPositionModel.findOne({ _id: id, userId, status: 'open' }).lean();
  if (!position) throw new Error('Open simulated position not found');
  const quote = await getFreshQuote(position.symbol as MarketSymbol);
  const settings = await getSettings(userId);
  const exitPrice = simulatedExitPrice(quote.price, position.side, settings.spreadBps, settings.slippageBps);
  const pnl = calculatePnl(position.side, position.entryPrice, exitPrice, position.quantity);
  const closed = await closePosition(userId, id, exitPrice, 'manual-close', pnl);
  if (!closed) throw new Error('Simulated position could not be closed');
  return { ...closed, pnl };
}
