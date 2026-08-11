import { PriceFeed } from '../core/price-feed.js';
import { BreakEvenEngine } from '../core/break-even-engine.js';
import type { ManagedPosition } from '../api/types.js';
import { formatCurrency, formatPnl, parseInstrumentName } from '../utils/math.js';
import { logger } from '../utils/logger.js';

export class Dashboard {
  private engine: BreakEvenEngine;
  private priceFeed: PriceFeed;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(engine: BreakEvenEngine, priceFeed: PriceFeed) {
    this.engine = engine;
    this.priceFeed = priceFeed;

    // Listen for events
    this.engine.on('position:added', (pos: ManagedPosition) => {
      logger.info(`Position added: ${pos.position.instrument_name}`);
    });

    this.engine.on('position:removed', (pos: ManagedPosition) => {
      logger.info(`Position removed: ${pos.position.instrument_name}`);
    });

    this.engine.on('trigger:placed', (pos: ManagedPosition) => {
      logger.info(`Trigger placed for: ${pos.position.instrument_name}`);
    });
  }

  start(): void {
    this.render();
    this.refreshTimer = setInterval(() => this.render(), 5000);
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  render(): void {
    const positions = this.engine.getManagedPositions();
    const prices = this.priceFeed.getAllPrices();

    console.clear();
    console.log(this.buildDashboard(positions, prices));
  }

  private buildDashboard(positions: ManagedPosition[], prices: Map<string, number>): string {
    const lines: string[] = [];

    lines.push('');
    lines.push('='.repeat(80));
    lines.push('           DERIVE OPTION MANAGER - BREAK-EVEN TRACKER');
    lines.push('='.repeat(80));

    // Spot prices
    lines.push('');
    lines.push('SPOT PRICES:');
    for (const [currency, price] of prices) {
      lines.push(`  ${currency}: $${formatCurrency(price)}`);
    }

    if (prices.size === 0) {
      lines.push('  Waiting for price feed...');
    }

    // Positions
    lines.push('');
    lines.push('-'.repeat(80));
    lines.push('POSITIONS:');
    lines.push('-'.repeat(80));

    if (positions.length === 0) {
      lines.push('  No option positions found.');
    } else {
      for (const pos of positions) {
        lines.push(this.formatPosition(pos, prices));
      }
    }

    lines.push('');
    lines.push('-'.repeat(80));
    lines.push(`Last updated: ${new Date().toLocaleTimeString()}`);
    lines.push('='.repeat(80));
    lines.push('');

    return lines.join('\n');
  }

  private formatPosition(pos: ManagedPosition, prices: Map<string, number>): string {
    const lines: string[] = [];
    const { position, instrument, breakEvenPrice, breakEvenType, pnl, triggerPlaced } = pos;
    const { currency } = parseInstrumentName(position.instrument_name);

    const spotPrice = prices.get(currency);
    const spotStr = spotPrice ? `$${formatCurrency(spotPrice)}` : 'N/A';
    const distFromBE = spotPrice
      ? ((spotPrice - breakEvenPrice) / breakEvenPrice * 100).toFixed(2)
      : 'N/A';

    const optType = instrument.option_details?.option_type === 'P' ? 'PUT' : 'CALL';
    const dirLabel = position.direction.toUpperCase();

    lines.push('');
    lines.push(`  ${position.instrument_name}`);
    lines.push(`  Type: ${optType} | Direction: ${dirLabel} | Amount: ${position.amount}`);
    lines.push(`  Entry: $${pos.entryPrice.toFixed(2)} | Mark: $${parseFloat(position.mark_price).toFixed(2)} | Spot: ${spotStr}`);
    lines.push(`  P&L: ${formatPnl(pnl)} | Break-even: $${breakEvenPrice.toFixed(2)} (${breakEvenType})`);
    lines.push(`  Distance from break-even: ${distFromBE}%`);

    if (triggerPlaced) {
      lines.push(`  Status: TRIGGER ACTIVE | Order: ${pos.triggerOrderId}`);
    } else {
      const triggerAction = position.direction === 'sell' ? 'BUY' : 'SELL';
      lines.push(`  Status: MONITORING | Trigger: ${triggerAction} when spot ${breakEvenType} $${breakEvenPrice.toFixed(2)}`);
    }

    return lines.join('\n');
  }
}
