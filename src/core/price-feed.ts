import { EventEmitter } from 'events';
import { DeriveClient } from '../api/derive-client.js';
import type { PriceFeedData } from '../api/types.js';
import { logger } from '../utils/logger.js';

export class PriceFeed extends EventEmitter {
  private prices = new Map<string, number>();
  private client: DeriveClient;

  constructor(client: DeriveClient) {
    super();
    this.client = client;
  }

  async subscribe(currency: string): Promise<void> {
    const channel = `spot_feed.${currency}`;
    logger.info(`Subscribing to spot feed: ${currency}`);

    await this.client.subscribe(channel, (data: unknown) => {
      const feedData = data as PriceFeedData;
      if (feedData && feedData.price) {
        const oldPrice = this.prices.get(currency);
        this.prices.set(currency, feedData.price);

        if (!oldPrice || Math.abs(oldPrice - feedData.price) > 0.01) {
          this.emit('price', currency, feedData.price, feedData.timestamp);
        }
      }
    });
  }

  getPrice(currency: string): number | undefined {
    return this.prices.get(currency);
  }

  getAllPrices(): Map<string, number> {
    return new Map(this.prices);
  }
}
