import type { OptionType, Direction, Position, Instrument, ManagedPosition } from '../api/types.js';
import { getConfig } from '../config.js';

export function parseInstrumentName(name: string): {
  currency: string;
  expiry: string;
  strike: number;
  optionType: OptionType;
} {
  // Format: ETH-21AUG25-1850-P
  const parts = name.split('-');
  if (parts.length !== 4) {
    throw new Error(`Invalid instrument name: ${name}`);
  }
  return {
    currency: parts[0],
    expiry: parts[1],
    strike: parseFloat(parts[2]),
    optionType: parts[3] as OptionType,
  };
}

export function calculateBreakEven(
  strike: number,
  entryPrice: number,
  optionType: OptionType,
  direction: Direction
): { price: number; type: 'above' | 'below' } {
  // For short positions, the entry price is the premium received
  // For long positions, the entry price is the premium paid

  if (direction === 'sell') {
    // Short position
    if (optionType === 'P') {
      // Short Put: break-even = strike - premium received
      // When spot <= break-even, option is ITM, we buy back to close
      return { price: strike - entryPrice, type: 'below' };
    } else {
      // Short Call: break-even = strike + premium received
      // When spot >= break-even, option is ITM, we buy back to close
      return { price: strike + entryPrice, type: 'above' };
    }
  } else {
    // Long position
    if (optionType === 'P') {
      // Long Put: break-even = strike - premium paid
      // When spot <= break-even, we sell to take profit
      return { price: strike - entryPrice, type: 'below' };
    } else {
      // Long Call: break-even = strike + premium paid
      // When spot >= break-even, we sell to take profit
      return { price: strike + entryPrice, type: 'above' };
    }
  }
}

export function createManagedPosition(
  position: Position,
  instrument: Instrument
): ManagedPosition | null {
  if (!instrument.option_details) return null;

  const { strike: parsedStrike, optionType } = parseInstrumentName(position.instrument_name);
  const entryPrice = parseFloat(position.entry_price);
  const indexPrice = parseFloat(position.index_price);

  if (isNaN(entryPrice) || isNaN(indexPrice) || entryPrice === 0) return null;

  const { price: breakEvenPrice, type: breakEvenType } = calculateBreakEven(
    parsedStrike,
    entryPrice,
    optionType,
    position.direction
  );

  const amount = parseFloat(position.amount);
  const markPrice = parseFloat(position.mark_price);

  // P&L calculation
  const strike = parseFloat(instrument.option_details?.strike || '100');
  let pnl = 0;
  if (position.direction === 'sell') {
    // Short: profit when option price decreases
    pnl = (entryPrice - markPrice) * amount * strike;
  } else {
    // Long: profit when option price increases
    pnl = (markPrice - entryPrice) * amount * strike;
  }

  const notional = entryPrice * amount * strike;
  const pnlPct = notional !== 0 ? (pnl / Math.abs(notional)) * 100 : 0;

  // Apply offset
  const config = getConfig();
  const offset = breakEvenPrice * (config.breakEvenOffsetPct / 100);
  const adjustedBreakEven = breakEvenType === 'above'
    ? breakEvenPrice - offset
    : breakEvenPrice + offset;

  return {
    position,
    instrument,
    breakEvenPrice: adjustedBreakEven,
    breakEvenType,
    entryPrice,
    pnl,
    pnlPct,
    triggerPlaced: false,
    triggerOrderId: null,
  };
}

export function formatCurrency(value: number, decimals = 2): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatPnl(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}$${formatCurrency(value)}`;
}
