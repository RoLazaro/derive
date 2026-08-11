import { DeriveClient } from '../api/derive-client.js';
import type { Position, Instrument, Subaccount } from '../api/types.js';
import { logger } from '../utils/logger.js';

export class PositionManager {
  private client: DeriveClient;
  private subaccountId: number;
  private instruments = new Map<string, Instrument>();

  constructor(client: DeriveClient, subaccountId: number) {
    this.client = client;
    this.subaccountId = subaccountId;
  }

  async loadPositions(): Promise<{ positions: Position[]; instruments: Instrument[] }> {
    logger.debug('Loading positions...');

    const subaccount = await this.client.request<Subaccount>('private/get_subaccount', {
      subaccount_id: this.subaccountId,
    });

    const positions = subaccount.positions || [];
    const loadedInstruments: Instrument[] = [];

    // Load instrument details for each position
    for (const pos of positions) {
      if (!this.instruments.has(pos.instrument_name)) {
        try {
          const instrument = await this.client.request<Instrument>('public/get_instrument', {
            instrument_name: pos.instrument_name,
          });
          this.instruments.set(pos.instrument_name, instrument);
          loadedInstruments.push(instrument);
        } catch (err) {
          logger.error(`Failed to load instrument ${pos.instrument_name}`, err);
        }
      } else {
        loadedInstruments.push(this.instruments.get(pos.instrument_name)!);
      }
    }

    logger.debug(`Loaded ${positions.length} positions`);
    return { positions, instruments: loadedInstruments };
  }

  getInstrument(name: string): Instrument | undefined {
    return this.instruments.get(name);
  }

  async getOpenOrders(): Promise<unknown[]> {
    try {
      const result = await this.client.request<{ orders: unknown[] }>('private/get_open_orders', {
        subaccount_id: this.subaccountId,
      });
      return result.orders || [];
    } catch (err) {
      logger.error('Failed to load open orders', err);
      return [];
    }
  }
}
