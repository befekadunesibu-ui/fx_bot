export type PaperSide = 'long' | 'short';

export function calculatePositionSize(balance: number, riskPerTrade: number, entryPrice: number, stopDistance: number): number {
  if (![balance, riskPerTrade, entryPrice, stopDistance].every(Number.isFinite) || balance <= 0 || riskPerTrade <= 0 || entryPrice <= 0 || stopDistance <= 0) {
    throw new Error('Invalid paper position sizing inputs');
  }
  return balance * riskPerTrade / stopDistance;
}

export function simulatedEntryPrice(price: number, side: PaperSide, spreadBps: number, slippageBps: number): number {
  const adjustment = (spreadBps + slippageBps) / 10000;
  return price * (side === 'long' ? 1 + adjustment : 1 - adjustment);
}

export function simulatedExitPrice(price: number, side: PaperSide, spreadBps: number, slippageBps: number): number {
  const adjustment = (spreadBps + slippageBps) / 10000;
  return price * (side === 'long' ? 1 - adjustment : 1 + adjustment);
}

export function calculatePnl(side: PaperSide, entryPrice: number, exitPrice: number, quantity: number): number {
  return (exitPrice - entryPrice) * quantity * (side === 'long' ? 1 : -1);
}

export function exitReason(side: PaperSide, price: number, stopLoss: number, takeProfit: number): 'stop-loss' | 'take-profit' | null {
  if (side === 'long' && price <= stopLoss || side === 'short' && price >= stopLoss) return 'stop-loss';
  if (side === 'long' && price >= takeProfit || side === 'short' && price <= takeProfit) return 'take-profit';
  return null;
}
