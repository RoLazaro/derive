import { EventEmitter } from 'events';
import { PositionManager } from './position-manager.js';
import { PriceFeed } from './price-feed.js';
import { OrderExecutor } from './order-executor.js';
import type { ManagedPosition, Instrument, Position } from '../api/types.js';
import { createManagedPosition, parseInstrumentName } from '../utils/math.js';
import { logger } from '../utils/logger.js';
import { getConfig } from '../config.js';

export class BreakEvenEngine extends EventEmitter {
  private managedPositions = new Map<string, ManagedPosition>();
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private currencies = new Set<string>();

  constructor(
    private positionManager: PositionManager,
    private priceFeed: PriceFeed,
    private orderExecutor: OrderExecutor
  ) {
    super();
  }

  async start(): Promise<void> {
    logger.info('Starting break-even engine...');
    await this.refreshPositions();
    this.startPolling();
  }

  stop(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    logger.info('Break-even engine stopped');
  }

  private startPolling(): void {
    const config = getConfig();
    this.pollingTimer = setInterval(() => {
      this.refreshPositions().catch((err) => {
        logger.error('Error refreshing positions', err);
      });
    }, config.pollIntervalMs);
  }

  async refreshPositions(): Promise<void> {
    try {
      const { positions, instruments } = await this.positionManager.loadPositions();

      // Track which positions still exist
      const activePositions = new Set<string>();

      for (let i = 0; i < positions.length; i++) {
        const pos = positions[i];
        const instr = instruments[i];
        if (!instr || !instr.option_details) continue;

        activePositions.add(pos.instrument_name);

        // Ensure we're subscribed to the currency's spot feed
        const { currency } = parseInstrumentName(pos.instrument_name);
        if (!this.currencies.has(currency)) {
          this.currencies.add(currency);
          await this.priceFeed.subscribe(currency);
          logger.info(`Subscribed to ${currency} spot feed`);
        }

        // Create or update managed position
        if (!this.managedPositions.has(pos.instrument_name)) {
          const managed = createManagedPosition(pos, instr);
          if (managed) {
            this.managedPositions.set(pos.instrument_name, managed);
            logger.info(
              `Tracking: ${pos.instrument_name} | Break-even: $${managed.breakEvenPrice.toFixed(2)} | Dir: ${managed.breakEvenType}`
            );
            this.emit('position:added', managed);
          }
        } else {
          // Update existing position data
          const existing = this.managedPositions.get(pos.instrument_name)!;
          existing.position = pos;
          existing.instrument = instr;
        }
      }

      // Remove positions that no longer exist
      for (const [name] of this.managedPositions) {
        if (!activePositions.has(name)) {
          const removed = this.managedPositions.get(name)!;
          logger.info(`Position closed: ${name}`);
          this.managedPositions.delete(name);
          this.emit('position:removed', removed);
        }
      }
    } catch (err) {
      logger.error('Failed to refresh positions', err);
    }
  }

  async checkBreakEvenTriggers(): Promise<void> {
    for (const [name, managed] of this.managedPositions) {
      if (managed.triggerPlaced) continue;

      const { currency } = parseInstrumentName(name);
      const spotPrice = this.priceFeed.getPrice(currency);

      if (!spotPrice) continue;

      let shouldTrigger = false;

      if (managed.breakEvenType === 'below' && spotPrice <= managed.breakEvenPrice) {
        shouldTrigger = true;
      } else if (managed.breakEvenType === 'above' && spotPrice >= managed.breakEvenPrice) {
        shouldTrigger = true;
      }

      if (shouldTrigger) {
        logger.info(
          `Break-even triggered for ${name}! Spot: $${spotPrice.toFixed(2)} | Target: $${managed.breakEvenPrice.toFixed(2)}`
        );

        try {
          const orderId = await this.orderExecutor.executeClose(managed);
          managed.triggerPlaced = true;
          managed.triggerOrderId = orderId;
          this.emit('trigger:placed', managed);
        } catch (err) {
          logger.error(`Failed to place trigger for ${name}`, err);
        }
      }
    }
  }

  getManagedPositions(): ManagedPosition[] {
    return Array.from(this.managedPositions.values());
  }

  getManagedPosition(name: string): ManagedPosition | undefined {
    return this.managedPositions.get(name);
  }
}
