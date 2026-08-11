// Derive API Types

export type OptionType = 'C' | 'P';
export type Direction = 'buy' | 'sell';
export type OrderType = 'limit' | 'market';
export type TriggerType = 'stoploss' | 'takeprofit';
export type TriggerPriceType = 'index' | 'mark';
export type TimeInForce = 'gtc' | 'post_only' | 'fok' | 'ioc';

export interface OptionDetails {
  expiry: number;
  index: string;
  option_type: OptionType;
  strike: string;
  settlement_price: string | null;
}

export interface Instrument {
  instrument_name: string;
  instrument_type: string;
  currency: string;
  quote_currency: string;
  is_active: boolean;
  option_details: OptionDetails | null;
  tick_size: string;
  minimum_amount: string;
  maximum_amount: string;
}

export interface Position {
  instrument_name: string;
  amount: string;
  direction: Direction;
  entry_price: string;
  mark_price: string;
  index_price: string;
  unrealized_pnl: string;
  realized_pnl: string;
  margin: string;
  liquidation_price: string | null;
  leverage: string | null;
  subaccount_id: number;
  instrument_type: string;
}

export interface Subaccount {
  subaccount_id: number;
  label: string;
  collateral: Record<string, string>;
  positions: Position[];
}

export interface Ticker {
  instrument_name: string;
  bid: string;
  ask: string;
  mark_price: string;
  index_price: string;
  last_price: string;
  volume_24h: string;
  open_interest: string;
}

export interface TriggerOrderParams {
  instrument_name: string;
  amount: string;
  direction: Direction;
  limit_price: string;
  order_type: OrderType;
  trigger_type: TriggerType;
  trigger_price: string;
  trigger_price_type: TriggerPriceType;
  max_fee: string;
  reduce_only: boolean;
}

export interface TriggerOrder extends TriggerOrderParams {
  order_id: string;
  order_status: string;
  subaccount_id: number;
  nonce: number;
  signature: string;
  signature_expiry_sec: number;
  signer: string;
}

export interface OrderParams {
  instrument_name: string;
  amount: string;
  direction: Direction;
  limit_price: string;
  order_type: OrderType;
  max_fee: string;
  subaccount_id: number;
  reduce_only?: boolean;
}

export interface PriceFeedData {
  currency: string;
  price: number;
  timestamp: number;
}

export interface BreakEvenConfig {
  offsetPct: number;
  pollIntervalMs: number;
}

export interface ManagedPosition {
  position: Position;
  instrument: Instrument;
  breakEvenPrice: number;
  breakEvenType: 'above' | 'below';
  entryPrice: number;
  pnl: number;
  pnlPct: number;
  triggerPlaced: boolean;
  triggerOrderId: string | null;
}

export interface WSMessage {
  method?: string;
  params?: Record<string, unknown>;
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
  channel?: string;
  data?: unknown;
}
