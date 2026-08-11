import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import WebSocket from 'ws';
import { loadSettings, saveSettings, getSettingsPath, type AppSettings } from './config/settings.js';
import { verifyPassword } from './utils/password.js';
import { logger } from './utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = join(__dirname, '..', 'public');

let deriveWs: WebSocket | null = null;
let currentPositions: unknown[] = [];
let currentSpotPrices: Record<string, number> = {};
let wsRequestId = 0;
let wsPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

// Global stop state
let globalStop = { armed: false, price: 0, triggered: false };

// ─── Auth (password + session cookie) ───
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours
const COOKIE_NAME = 'derive_session';
const sessions = new Map<string, number>(); // token -> expiry (ms)

function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie || '';
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isAuthenticated(req: IncomingMessage): boolean {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry) return false;
  if (expiry < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (isAuthenticated(req)) return true;
  const wantsJson = (req.url || '').startsWith('/api/');
  if (wantsJson) {
    json(res, { error: 'Non authentifie' }, 401);
  } else {
    res.writeHead(302, { Location: '/login.html' });
    res.end();
  }
  return false;
}

function serveFile(res: ServerResponse, filePath: string): void {
  const content = readFileSync(filePath);
  const ext = filePath.split('.').pop() || 'html';
  const mimeTypes: Record<string, string> = {
    html: 'text/html', css: 'text/css', js: 'application/javascript',
    json: 'application/json', png: 'image/png', svg: 'image/svg+xml',
  };
  res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
  res.end(content);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', () => resolve(body));
  });
}

function wsSend(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!deriveWs || deriveWs.readyState !== WebSocket.OPEN) {
      reject(new Error('WebSocket not connected'));
      return;
    }
    const id = ++wsRequestId;
    logger.debug(`WS SEND: ${method} (id=${id})`);
    deriveWs.send(JSON.stringify({ method, params, id }));
    wsPending.set(id, { resolve, reject });
    setTimeout(() => {
      if (wsPending.has(id)) {
        wsPending.delete(id);
        reject(new Error(`WS timeout: ${method}`));
      }
    }, 15000);
  });
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function connectToDerive(): Promise<void> {
  const settings = loadSettings();
  if (!settings.sessionKey || !settings.sessionSecret) {
    logger.info('No credentials, skipping Derive connection');
    return;
  }

  // Normalize WS URL
  let wsUrl = settings.wsUrl;
  if (wsUrl.endsWith('/v2')) wsUrl = wsUrl.replace('/v2', '');
  if (!wsUrl.endsWith('/ws')) wsUrl = wsUrl + '/ws';

  logger.info(`Connecting to Derive: ${wsUrl}`);

  return new Promise((resolve, reject) => {
    deriveWs = new WebSocket(wsUrl);

    deriveWs.on('open', async () => {
      logger.info('WebSocket connected to Derive');

      try {
        const { ethers } = await import('ethers');
        const wallet = new ethers.Wallet(settings.sessionSecret);
        const timestamp = Date.now();
        const signature = await wallet.signMessage(timestamp.toString());

        const loginId = ++wsRequestId;
        logger.info(`Logging in (id=${loginId})...`);

        deriveWs!.send(JSON.stringify({
          method: 'public/login',
          params: { wallet: settings.sessionKey, timestamp, signature },
          id: loginId,
        }));

        // Store login ID to match response
        const onMessage = (raw: Buffer) => {
          try {
            const msg = JSON.parse(raw.toString());

            // Match login response
            if (msg.id === loginId) {
              deriveWs!.off('message', onMessage);
              if (msg.error) {
                logger.error(`Login FAILED: ${JSON.stringify(msg.error)}`);
                reject(new Error(`Login failed: ${msg.error.message}`));
              } else {
                logger.info(`Login SUCCESS: ${JSON.stringify(msg.result)}`);
                // Extract subaccount ID from login result
                const subaccounts = msg.result as number[];
                if (subaccounts && subaccounts.length > 0) {
                  const subId = subaccounts[0];
                  const currentSettings = loadSettings();
                  if (currentSettings.subaccountId !== subId) {
                    logger.info(`Auto-setting subaccount_id to ${subId} from login`);
                    saveSettings({ subaccountId: subId });
                  }
                }
                resolve();
              }
            }
          } catch (e) {
            // ignore parse errors
          }
        };

        deriveWs!.on('message', onMessage);
      } catch (err) {
        logger.error('Login error:', err);
        reject(err);
      }
    });

    deriveWs.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());

        // Handle pending requests
        if (msg.id !== undefined && wsPending.has(msg.id)) {
          const p = wsPending.get(msg.id)!;
          wsPending.delete(msg.id);
          if (msg.error) {
            logger.debug(`WS error for id ${msg.id}: ${msg.error.message}`);
            p.reject(new Error(msg.error.message));
          } else {
            logger.debug(`WS response for id ${msg.id}`);
            p.resolve(msg.result);
          }
          return;
        }

        // Handle spot feed
        if (msg.channel && msg.channel.startsWith('spot_feed.')) {
          const currency = msg.channel.split('.')[1];
          const data = msg.data as Record<string, unknown>;
          if (data) {
            // Try different formats
            if (data.price) {
              currentSpotPrices[currency] = parseFloat(data.price as string);
            } else if (data.feeds && typeof data.feeds === 'object') {
              const feeds = data.feeds as Record<string, string>;
              if (feeds[currency]) {
                currentSpotPrices[currency] = parseFloat(feeds[currency]);
              }
            } else if (data.index_price) {
              currentSpotPrices[currency] = parseFloat(data.index_price as string);
            }
            if (currentSpotPrices[currency]) {
              logger.info(`Spot ${currency}: $${currentSpotPrices[currency]}`);

              // Check global stop
              if (currency === 'ETH' && globalStop.armed && !globalStop.triggered) {
                if (currentSpotPrices.ETH <= globalStop.price) {
                  logger.warn(`GLOBAL STOP TRIGGERED! ETH $${currentSpotPrices.ETH} <= $${globalStop.price}`);
                  globalStop.triggered = true;
                  closeAllPositions().catch(err => {
                    logger.error('Failed to close positions:', err.message);
                  });
                }
              }
            }
          }
        }
      } catch (e) {
        // ignore
      }
    });

    deriveWs.on('close', (code, reason) => {
      logger.info(`WebSocket closed: code=${code} reason=${reason}`);
      currentPositions = [];
      currentSpotPrices = {};
      setTimeout(() => connectToDerive().catch(() => {}), 5000);
    });

    deriveWs.on('error', (err: Error) => {
      logger.error('WebSocket error:', err.message);
    });
  });
}

async function fetchSubaccounts(): Promise<void> {
  try {
    const result = await wsSend('private/get_subaccounts', {}) as { subaccounts?: Array<{ subaccount_id: number; label: string }> };
    const subs = result.subaccounts || [];
    logger.info(`Found ${subs.length} subaccount(s): ${JSON.stringify(subs)}`);

    // Auto-set subaccount_id if not configured or invalid
    if (subs.length > 0) {
      const settings = loadSettings();
      const validSub = subs.find(s => s.subaccount_id === settings.subaccountId) || subs[0];
      if (validSub.subaccount_id !== settings.subaccountId) {
        logger.info(`Auto-setting subaccount_id to ${validSub.subaccount_id}`);
        saveSettings({ subaccountId: validSub.subaccount_id });
      }
    }
  } catch (err) {
    logger.error('Failed to fetch subaccounts:', (err as Error).message);
  }
}

async function fetchPositions(): Promise<void> {
  const settings = loadSettings();
  try {
    logger.debug(`Fetching positions for subaccount ${settings.subaccountId}...`);
    const result = await wsSend('private/get_subaccount', {
      subaccount_id: settings.subaccountId,
    }) as { positions?: unknown[]; collateral?: unknown };

    currentPositions = result.positions || [];
    logger.debug(`Got ${currentPositions.length} positions`);

    if (currentPositions.length > 0) {
      const first = currentPositions[0] as Record<string, unknown>;
      logger.info(`Position: ${first.instrument_name} | ${first.direction} | ${first.amount}`);
    }
  } catch (err) {
    logger.error('Failed to fetch positions:', (err as Error).message);
    currentPositions = [];
  }
}

// Derive protocol constants (mainnet)
const ACTION_TYPEHASH = '0x4d7a9f27c403ff9c0f19bce61d76d82f9aa29f8d6d4b0c5474607d9770d1af17';
const DOMAIN_SEPARATOR = '0xd96e5f90797da7ec8dc4e276260c7f3f87fedf68775fbe1ef116e996fc60441b';
const TRADE_MODULE_ADDRESS = '0xB8D20c2B7a1Ad2EE33Bc50eF10876eD3035b5e7b';

interface InstrumentDetails {
  base_asset_address: string;
  base_asset_sub_id: string;
  instrument_name: string;
  option_details?: { sub_id: string };
}

const instrumentCache = new Map<string, InstrumentDetails>();

async function getInstrument(name: string): Promise<InstrumentDetails> {
  if (instrumentCache.has(name)) return instrumentCache.get(name)!;

  const result = await wsSend('public/get_instrument', { instrument_name: name }) as InstrumentDetails;
  instrumentCache.set(name, result);
  return result;
}

async function signOrder(
  order: Record<string, unknown>,
  assetAddress: string,
  optionSubId: string
): Promise<string> {
  const settings = loadSettings();
  const { ethers } = await import('ethers');
  const wallet = new ethers.Wallet(settings.sessionSecret);
  const encoder = ethers.AbiCoder.defaultAbiCoder();

  // Encode trade data
  const limitPrice = ethers.parseUnits((order.limit_price as string) || '0', 18);
  const amount = ethers.parseUnits((order.amount as string) || '1', 18);
  const maxFee = ethers.parseUnits((order.max_fee as string) || '0.1', 18);

  const encodedData = encoder.encode(
    ['address', 'uint', 'int', 'int', 'uint', 'uint', 'bool'],
    [
      assetAddress,
      optionSubId,
      limitPrice,
      amount,
      maxFee,
      order.subaccount_id,
      order.direction === 'buy',
    ]
  );
  const dataHash = ethers.keccak256(Buffer.from(encodedData.slice(2), 'hex'));

  // Encode action hash
  const actionHash = ethers.keccak256(
    encoder.encode(
      ['bytes32', 'uint256', 'uint256', 'address', 'bytes32', 'uint256', 'address', 'address'],
      [
        ACTION_TYPEHASH,
        order.subaccount_id,
        order.nonce,
        TRADE_MODULE_ADDRESS,
        dataHash,
        order.signature_expiry_sec,
        settings.sessionKey,  // owner = Derive wallet address
        wallet.address,       // signer = session key address (derived from private key)
      ]
    )
  );

  // Create typed data hash
  const typedDataHash = ethers.keccak256(
    Buffer.concat([
      Buffer.from('1901', 'hex'),
      Buffer.from(DOMAIN_SEPARATOR.slice(2), 'hex'),
      Buffer.from(actionHash.slice(2), 'hex'),
    ])
  );

  // Sign
  const signingKey = new ethers.SigningKey(settings.sessionSecret);
  const sig = signingKey.sign(typedDataHash);
  return ethers.Signature.from(sig).serialized;
}

async function closeAllPositions(): Promise<void> {
  const settings = loadSettings();
  logger.warn('=== CLOSING ALL POSITIONS ===');

  // Refresh positions first
  await fetchPositions();

  for (const pos of currentPositions) {
    const p = pos as Record<string, unknown>;
    const name = p.instrument_name as string;
    const rawAmount = parseFloat(p.amount as string);
    const absAmount = Math.abs(rawAmount).toString();

    // Close: if long (positive amount), sell; if short (negative amount), buy
    const closeDirection = rawAmount > 0 ? 'sell' : 'buy';

    const nonce = Number(`${Date.now()}${Math.round(Math.random() * 999)}`);
    const orderId = `stop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const expirySec = Math.floor(Date.now() / 1000) + 600;

    logger.warn(`Closing ${name}: ${closeDirection} ${absAmount}`);

    try {
      // Get instrument details for signing
      const instrument = await getInstrument(name);
      const assetAddress = instrument.base_asset_address;
      const optionSubId = instrument.base_asset_sub_id;

      // Use limit order at mark price (maker fee = 0.01%) instead of market (taker = 0.03%)
      // This saves ~66% on fees
      const markP = parseFloat((p.mark_price as string) || '0');
      const limitPrice = Math.round(markP).toString();
      // max_fee: base_fee ($0.50) + maker_fee (0.01% * notional * amount)
      const maxFee = (0.50 + markP * 0.0001 * Math.abs(rawAmount) * 2).toFixed(2);

      // Derive session key address from private key
      const { ethers: ethersLib } = await import('ethers');
      const sessionWallet = new ethersLib.Wallet(settings.sessionSecret);

      // Sign the order
      const signature = await signOrder(
        {
          subaccount_id: settings.subaccountId,
          nonce,
          instrument_name: name,
          amount: absAmount,
          direction: closeDirection,
          limit_price: limitPrice,
          order_type: 'limit',
          max_fee: maxFee,
          signer: sessionWallet.address,
          signature_expiry_sec: expirySec,
        },
        assetAddress,
        optionSubId
      );

      const result = await wsSend('private/order', {
        instrument_name: name,
        amount: absAmount,
        direction: closeDirection,
        limit_price: limitPrice,
        order_type: 'limit',
        subaccount_id: settings.subaccountId,
        max_fee: maxFee,
        reduce_only: true,
        nonce,
        order_id: orderId,
        signature,
        signature_expiry_sec: expirySec,
        signer: sessionWallet.address,
        time_in_force: 'gtc',
        mmp: false,
      }) as { order?: { order_id: string; order_status: string } };

      logger.warn(`Order placed: ${result?.order?.order_id} | Status: ${result?.order?.order_status}`);
    } catch (err) {
      logger.error(`Failed to close ${name}:`, (err as Error).message);
    }
  }

  logger.warn('=== ALL POSITIONS CLOSED ===');

  // Reset stop after closing
  globalStop.armed = false;
  globalStop.triggered = false;
}

async function startFeedAndPositions(): Promise<void> {
  // First, get subaccounts to find correct ID
  await fetchSubaccounts();

  // Subscribe to spot feeds
  try {
    await wsSend('subscribe', { channels: ['spot_feed.ETH', 'spot_feed.BTC'] });
    logger.info('Subscribed to spot feeds');
  } catch (err) {
    logger.error('Failed to subscribe to feeds:', (err as Error).message);
  }

  // Fetch positions immediately
  await fetchPositions();

  // Poll positions every 5 seconds
  setInterval(() => {
    fetchPositions().catch(() => {});
  }, 5000);
}

export function startServer(port = 3001): void {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || '/';

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ─── Auth routes (publiques) ───
    if (url === '/api/auth-status' && req.method === 'GET') {
      return json(res, { authenticated: isAuthenticated(req) });
    }

    if (url === '/api/login' && req.method === 'POST') {
      try {
        const data = JSON.parse(await readBody(req)) as { password?: string };
        const settings = loadSettings();
        if (!settings.authPasswordHash) {
          return json(res, { error: 'Aucun mot de passe configure. Lancez: node dist/set-password.js <mot-de-passe>' }, 500);
        }
        if (!data.password || !verifyPassword(data.password, settings.authPasswordHash)) {
          logger.warn('Login refused: mauvais mot de passe');
          return json(res, { error: 'Mot de passe incorrect' }, 401);
        }
        const token = randomBytes(32).toString('hex');
        sessions.set(token, Date.now() + SESSION_TTL_MS);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
        });
        res.end(JSON.stringify({ success: true }));
        logger.info('Login reussi');
        return;
      } catch (err) {
        return json(res, { error: (err as Error).message }, 500);
      }
    }

    if (url === '/api/logout' && req.method === 'POST') {
      const token = parseCookies(req)[COOKIE_NAME];
      if (token) sessions.delete(token);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`,
      });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // ─── Auth gate : tout le reste (API + pages) est protege ───
    if (url !== '/login.html' && !requireAuth(req, res)) return;

    if (url === '/api/settings' && req.method === 'GET') {
      const s = loadSettings();
      return json(res, {
        configured: !!(s.sessionKey && s.sessionSecret),
        wsUrl: s.wsUrl, restUrl: s.restUrl, sessionKey: s.sessionKey,
        subaccountId: s.subaccountId, breakEvenOffsetPct: s.breakEvenOffsetPct,
        logLevel: s.logLevel, settingsPath: getSettingsPath(),
      });
    }

    if (url === '/api/settings' && req.method === 'POST') {
      try {
        const data = JSON.parse(await readBody(req)) as Partial<AppSettings>;
        const s = saveSettings(data);
        // Reconnect
        if (deriveWs) { deriveWs.close(); deriveWs = null; }
        setTimeout(() => {
          connectToDerive()
            .then(() => startFeedAndPositions())
            .catch(() => {});
        }, 500);
        return json(res, { success: true, subaccountId: s.subaccountId });
      } catch (err) {
        return json(res, { success: false, error: (err as Error).message }, 500);
      }
    }

    if (url === '/api/positions' && req.method === 'GET') {
      return json(res, { positions: currentPositions, spotPrices: currentSpotPrices, raw: currentPositions[0] || null });
    }

    if (url === '/api/subaccounts' && req.method === 'GET') {
      try {
        const result = await wsSend('private/get_subaccounts', {}) as { subaccounts?: unknown[] };
        return json(res, { subaccounts: result.subaccounts || [] });
      } catch (err) {
        return json(res, { subaccounts: [], error: (err as Error).message });
      }
    }

    if (url === '/api/status' && req.method === 'GET') {
      const s = loadSettings();
      return json(res, {
        configured: !!(s.sessionKey && s.sessionSecret),
        connected: deriveWs?.readyState === WebSocket.OPEN,
        network: s.wsUrl.includes('demo') ? 'TESTNET' : 'MAINNET',
        spotPrices: currentSpotPrices,
        positionCount: currentPositions.length,
        subaccountId: s.subaccountId,
      });
    }

    // Emergency close
    if (url === '/api/emergency-close' && req.method === 'POST') {
      try {
        await closeAllPositions();
        return json(res, { success: true, message: `${currentPositions.length} positions fermees` });
      } catch (err) {
        return json(res, { success: false, error: (err as Error).message }, 500);
      }
    }

    // Global Stop
    if (url === '/api/stop' && req.method === 'GET') {
      return json(res, {
        armed: globalStop.armed,
        price: globalStop.price,
        triggered: globalStop.triggered,
        ethSpot: currentSpotPrices.ETH || null,
      });
    }

    if (url === '/api/stop' && req.method === 'POST') {
      try {
        const data = JSON.parse(await readBody(req)) as { armed?: boolean; price?: number };
        globalStop.armed = data.armed || false;
        globalStop.price = data.price || 0;
        globalStop.triggered = false;

        if (globalStop.armed) {
          logger.warn(`Global stop ARMED at $${globalStop.price}`);
        } else {
          logger.info('Global stop disarmed');
        }

        return json(res, { success: true, armed: globalStop.armed, price: globalStop.price });
      } catch (err) {
        return json(res, { success: false, error: (err as Error).message }, 500);
      }
    }

    // Static files
    let filePath = join(PUBLIC_DIR, url === '/' ? 'index.html' : url);
    if (existsSync(filePath)) { serveFile(res, filePath); return; }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, async () => {
    logger.info(`Web server running at http://localhost:${port}`);

    const settings = loadSettings();
    if (settings.sessionKey && settings.sessionSecret) {
      try {
        await connectToDerive();
        await startFeedAndPositions();
      } catch (err) {
        logger.error('Failed to connect to Derive:', (err as Error).message);
      }
    } else {
      logger.info('No credentials configured yet');
    }
  });
}
