import { ethers } from 'ethers';
import { DeriveClient } from '../api/derive-client.js';
import { getConfig } from '../config.js';
import type { ManagedPosition, Direction } from '../api/types.js';
import { logger } from '../utils/logger.js';

export class OrderExecutor {
  private client: DeriveClient;
  private subaccountId: number;
  private nonceCounter = Date.now();

  constructor(client: DeriveClient, subaccountId: number) {
    this.client = client;
    this.subaccountId = subaccountId;
  }

  private generateNonce(): number {
    this.nonceCounter += 1;
    const randomPart = Math.floor(Math.random() * 999);
    return parseInt(`${this.nonceCounter}${randomPart}`, 10);
  }

  async executeClose(managed: ManagedPosition): Promise<string> {
    const { position, instrument, breakEvenPrice } = managed;

    // Determine order direction: inverse of position direction to close
    const orderDirection: Direction = position.direction === 'sell' ? 'buy' : 'sell';

    // Use market order for immediate execution
    const limitPrice = breakEvenPrice.toString();

    // Calculate max fee (generous estimate)
    const indexPrice = parseFloat(position.index_price);
    const maxFee = (indexPrice * 0.02).toFixed(2);

    const nonce = this.generateNonce();
    const order_id = `be-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    logger.info(
      `Placing ${orderDirection} order for ${position.instrument_name}: ` +
      `amount=${position.amount}, trigger_price=$${breakEvenPrice.toFixed(2)}`
    );

    try {
      const result = await this.client.request<{
        order: { order_id: string; order_status: string };
      }>('private/trigger_order', {
        instrument_name: position.instrument_name,
        amount: position.amount,
        direction: orderDirection,
        limit_price: limitPrice,
        order_type: 'market',
        trigger_type: 'takeprofit',
        trigger_price: breakEvenPrice.toFixed(2),
        trigger_price_type: 'index',
        subaccount_id: this.subaccountId,
        max_fee: maxFee,
        reduce_only: true,
        nonce,
        order_id,
        signature: 'pending',
        signature_expiry_sec: Math.floor(Date.now() / 1000) + 86400,
        signer: getConfig().sessionKey,
        conn_id: `conn-${Date.now()}`,
        mmp: false,
      });

      logger.info(
        `Trigger order placed: ${result.order.order_id} | Status: ${result.order.order_status}`
      );

      return result.order.order_id;
    } catch (err) {
      logger.error(`Failed to execute order for ${position.instrument_name}`, err);
      throw err;
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    try {
      await this.client.request('private/cancel_trigger_order', {
        order_id: orderId,
        subaccount_id: this.subaccountId,
      });
      logger.info(`Cancelled trigger order: ${orderId}`);
    } catch (err) {
      logger.error(`Failed to cancel order ${orderId}`, err);
      throw err;
    }
  }
}
