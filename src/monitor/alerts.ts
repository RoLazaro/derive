import type { ManagedPosition } from '../api/types.js';
import { logger } from '../utils/logger.js';
import { formatPnl, formatCurrency, parseInstrumentName } from '../utils/math.js';

export class AlertSystem {
  private priceAlerts = new Map<string, { threshold: number; type: 'above' | 'below'; callback: () => void }>();

  onPositionClose(pos: ManagedPosition, triggerPrice: number, closePrice: number): void {
    const pnl = closePrice - pos.entryPrice;
    const { currency } = parseInstrumentName(pos.position.instrument_name);

    logger.info('');
    logger.info('*** POSITION CLOSED ***');
    logger.info(`  Instrument: ${pos.position.instrument_name}`);
    logger.info(`  Direction: ${pos.position.direction.toUpperCase()}`);
    logger.info(`  Amount: ${pos.position.amount}`);
    logger.info(`  Entry: $${pos.entryPrice.toFixed(2)}`);
    logger.info(`  Trigger: $${triggerPrice.toFixed(2)}`);
    logger.info(`  Close: $${closePrice.toFixed(2)}`);
    logger.info(`  P&L: ${formatPnl(pnl)}`);
    logger.info('**********************');
    logger.info('');
  }

  onTriggerPlaced(pos: ManagedPosition): void {
    const { currency } = parseInstrumentName(pos.position.instrument_name);
    logger.info('');
    logger.info('*** TRIGGER ORDER PLACED ***');
    logger.info(`  Instrument: ${pos.position.instrument_name}`);
    logger.info(`  Break-even: $${pos.breakEvenPrice.toFixed(2)}`);
    logger.info(`  Trigger type: ${pos.breakEvenType}`);
    logger.info(`  Order ID: ${pos.triggerOrderId}`);
    logger.info('****************************');
    logger.info('');
  }

  onBreakEvenApproaching(pos: ManagedPosition, currentPrice: number): void {
    const distance = Math.abs((currentPrice - pos.breakEvenPrice) / pos.breakEvenPrice * 100);
    if (distance < 1 && distance > 0) {
      logger.warn(`CLOSE TO BREAK-EVEN: ${pos.position.instrument_name} - Distance: ${distance.toFixed(2)}%`);
    }
  }

  onEngineStart(positionCount: number, currencies: string[]): void {
    logger.info('');
    logger.info('='.repeat(50));
    logger.info('ENGINE STARTED');
    logger.info(`  Monitoring ${positionCount} position(s)`);
    logger.info(`  Currencies: ${currencies.join(', ')}`);
    logger.info('='.repeat(50));
    logger.info('');
  }

  onEngineError(error: Error): void {
    logger.error('Engine error:', error.message);
  }
}
