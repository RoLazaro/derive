import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type { WSMessage } from './types.js';
import { logger } from '../utils/logger.js';

export class DeriveClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private subscriptions = new Map<string, (data: unknown) => void>();
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private wsUrl: string,
    private restUrl: string
  ) {
    super();
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      logger.info(`Connecting to Derive WebSocket: ${this.wsUrl}`);
      this.ws = new WebSocket(this.wsUrl);

      this.ws.on('open', () => {
        logger.info('WebSocket connected');
        resolve();
      });

      this.ws.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString()) as WSMessage;
          this.handleMessage(msg);
        } catch (err) {
          logger.error('Failed to parse WS message', err);
        }
      });

      this.ws.on('close', () => {
        logger.warn('WebSocket disconnected');
        this.emit('disconnected');
        this.scheduleReconnect();
      });

      this.ws.on('error', (err: Error) => {
        logger.error('WebSocket error', err.message);
        reject(err);
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) return;
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect().catch(() => {});
    }, 5000);
  }

  private handleMessage(msg: WSMessage): void {
    // Response to a request
    if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
      const pending = this.pendingRequests.get(msg.id)!;
      this.pendingRequests.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(`API Error ${msg.error.code}: ${msg.error.message}`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Subscription notification
    if (msg.channel) {
      const handler = this.subscriptions.get(msg.channel);
      if (handler) {
        handler(msg.data);
      }
      this.emit('subscription', msg.channel, msg.data);
    }
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    const id = ++this.requestId;
    const msg = { method, params, id };

    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve: resolve as (v: unknown) => void, reject });

      // Timeout after 30s
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, 30000);

      this.ws!.send(JSON.stringify(msg));
    });
  }

  async subscribe(channel: string, handler: (data: unknown) => void): Promise<void> {
    this.subscriptions.set(channel, handler);
    await this.request('subscribe', { channels: [channel] });
  }

  async unsubscribe(channel: string): Promise<void> {
    this.subscriptions.delete(channel);
    await this.request('unsubscribe', { channels: [channel] });
  }

  disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
