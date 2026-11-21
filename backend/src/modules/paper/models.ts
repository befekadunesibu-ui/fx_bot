import mongoose, { Schema, type Model } from 'mongoose';

export type AutomationSettingsDocument = {
  userId: string; enabled: boolean; engineStatus: 'RUNNING' | 'PAUSED' | 'STOPPED';
  engineMessage: string | null; engineStatusUpdatedAt: Date;
  riskPerTrade: number; maxOpenPositions: number;
  openPositionCount: number; spreadBps: number; slippageBps: number; strategyVersion: string;
  strategyConfig: Record<string, unknown>; dailyRiskDate: string; dailyRiskReservedPercent: number;
};
export type SignalDocument = {
  userId: string; symbol: string; interval: string; classification: string; setup: string;
  analysis: Record<string, unknown> & { supportingEvidence?: string[]; contradictoryEvidence?: string[] };
  strategyVersion: string; decision: 'BUY SIMULATION' | 'SELL SIMULATION' | 'WAIT';
  confidence: number; reason: string; geminiAssessment: string | null;
  dedupeKey: string; consumed: boolean; createdAt: Date;
};
export type PaperAccountDocument = { userId: string; balance: number; realizedPnl: number };
export type PaperPositionDocument = {
  _id: mongoose.Types.ObjectId; userId: string; symbol: string; side: 'long' | 'short';
  quantity: number; entryPrice: number; currentPrice: number; stopLoss: number; takeProfit: number; openedAt: Date;
};
export type SchedulerStateDocument = {
  _id: string; emergencyPaused: boolean; pauseReason?: string | null;
  leaseOwner?: string | null; leaseExpiresAt?: Date | null; running: boolean;
  lastRunAt?: Date | null; nextRunAt?: Date | null; lastError?: string | null;
  lastErrorAt?: Date | null; cycleCount: number;
};

const ownership = { type: String, required: true, index: true };

const marketAnalysisSchema = new Schema({
  userId: ownership, symbol: String, interval: String, payload: { type: Schema.Types.Mixed, required: true },
  createdAt: { type: Date, default: Date.now, index: true },
});
const signalSchema = new Schema({
  userId: ownership, symbol: String, interval: String, classification: String, setup: String,
  analysis: { type: Schema.Types.Mixed, required: true }, strategyVersion: String,
  decision: { type: String, enum: ['BUY SIMULATION', 'SELL SIMULATION', 'WAIT'], default: 'WAIT' },
  confidence: { type: Number, min: 0, max: 100, default: 0 },
  reason: { type: String, required: true },
  geminiAssessment: { type: String, default: null },
  dedupeKey: { type: String, required: true, unique: true, index: true },
  consumed: { type: Boolean, default: false }, createdAt: { type: Date, default: Date.now, index: true },
});
const accountSchema = new Schema({
  userId: { ...ownership, unique: true }, balance: { type: Number, required: true },
  realizedPnl: { type: Number, default: 0 }, updatedAt: { type: Date, default: Date.now },
});
const positionSchema = new Schema({
  userId: ownership, symbol: { type: String, required: true }, side: { type: String, enum: ['long', 'short'], required: true },
  quantity: { type: Number, required: true, min: 0 }, entryPrice: { type: Number, required: true, min: 0 },
  currentPrice: { type: Number, required: true, min: 0 },
  stopLoss: { type: Number, required: true, min: 0 }, takeProfit: { type: Number, required: true, min: 0 },
  openedAt: { type: Date, default: Date.now }, status: { type: String, default: 'open', index: true },
});
const tradeSchema = new Schema({
  userId: ownership, symbol: String, side: String, quantity: Number, entryPrice: Number,
  exitPrice: Number, pnl: Number, strategyVersion: String, inputData: Schema.Types.Mixed,
  reason: String, openedAt: Date, closedAt: { type: Date, default: Date.now, index: true },
});
const settingsSchema = new Schema({
  userId: { ...ownership, unique: true }, enabled: { type: Boolean, default: false },
  engineStatus: { type: String, enum: ['RUNNING', 'PAUSED', 'STOPPED'], default: 'STOPPED' },
  engineMessage: { type: String, default: null },
  engineStatusUpdatedAt: { type: Date, default: Date.now },
  riskPerTrade: { type: Number, default: 0.005 },   maxOpenPositions: { type: Number, default: 3 },
  openPositionCount: { type: Number, default: 0 },
  dailyRiskDate: { type: String, required: true },
  dailyRiskReservedPercent: { type: Number, default: 0, min: 0, max: 2 },
  spreadBps: { type: Number, default: 2 }, slippageBps: { type: Number, default: 1 },
  strategyVersion: { type: String, default: 'fd-smart-scalp-v1' },
  strategyConfig: { type: Schema.Types.Mixed, required: true },
  updatedAt: { type: Date, default: Date.now },
});
const schedulerStateSchema = new Schema({
  _id: { type: String, default: 'global' },
  emergencyPaused: { type: Boolean, default: false },
  pauseReason: { type: String, default: null },
  leaseOwner: { type: String, default: null },
  leaseExpiresAt: { type: Date, default: null },
  running: { type: Boolean, default: false },
  lastRunAt: { type: Date, default: null },
  nextRunAt: { type: Date, default: null },
  lastError: { type: String, default: null },
  lastErrorAt: { type: Date, default: null },
  cycleCount: { type: Number, default: 0 },
  updatedAt: { type: Date, default: Date.now },
});
const telegramNotificationSchema = new Schema({
  dedupeKey: { type: String, required: true, unique: true, index: true },
  userId: ownership,
  text: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, index: true },
});
positionSchema.index({ userId: 1, symbol: 1, status: 1 }, {
  unique: true,
  partialFilterExpression: { status: 'open' },
});

export const MarketAnalysisModel = mongoose.models.MarketAnalysis ?? mongoose.model('MarketAnalysis', marketAnalysisSchema);
export const SignalModel: Model<SignalDocument> = (mongoose.models.Signal as Model<SignalDocument> | undefined) ?? mongoose.model<SignalDocument>('Signal', signalSchema);
export const PaperAccountModel: Model<PaperAccountDocument> = (mongoose.models.PaperAccount as Model<PaperAccountDocument> | undefined) ?? mongoose.model<PaperAccountDocument>('PaperAccount', accountSchema);
export const PaperPositionModel: Model<PaperPositionDocument> = (mongoose.models.PaperPosition as Model<PaperPositionDocument> | undefined) ?? mongoose.model<PaperPositionDocument>('PaperPosition', positionSchema);
export const PaperTradeModel = mongoose.models.PaperTrade ?? mongoose.model('PaperTrade', tradeSchema);
export const AutomationSettingsModel: Model<AutomationSettingsDocument> = (mongoose.models.AutomationSettings as Model<AutomationSettingsDocument> | undefined) ?? mongoose.model<AutomationSettingsDocument>('AutomationSettings', settingsSchema);
export const SchedulerStateModel: Model<SchedulerStateDocument> = (mongoose.models.SchedulerState as Model<SchedulerStateDocument> | undefined) ?? mongoose.model<SchedulerStateDocument>('SchedulerState', schedulerStateSchema);
export const TelegramNotificationModel = mongoose.models.TelegramNotification ?? mongoose.model('TelegramNotification', telegramNotificationSchema);
