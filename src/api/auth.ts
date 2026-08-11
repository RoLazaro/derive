import { ethers } from 'ethers';
import { DeriveClient } from './derive-client.js';
import { logger } from '../utils/logger.js';

export class Auth {
  private client: DeriveClient;
  private wallet: ethers.Wallet;
  private deriveWalletAddress: string;

  constructor(
    client: DeriveClient,
    sessionKeyAddress: string,
    sessionSecret: string
  ) {
    this.client = client;
    // The session secret is the private key of the session key wallet
    this.wallet = new ethers.Wallet(sessionSecret);
    // The deriveWalletAddress is the session key address (used as X-LyraWallet)
    this.deriveWalletAddress = sessionKeyAddress;

    logger.info(`Session key wallet: ${this.wallet.address}`);
    logger.info(`Derive wallet (session key): ${this.deriveWalletAddress}`);
  }

  async login(): Promise<void> {
    const timestamp = Date.now();

    // Sign the timestamp with the session key's private key
    // Derive expects: signMessage(timestamp) where timestamp is the string representation
    const signature = await this.wallet.signMessage(timestamp.toString());

    logger.info(`Logging in at timestamp: ${timestamp}`);

    await this.client.request('public/login', {
      wallet: this.deriveWalletAddress,
      timestamp,
      signature,
    });

    logger.info('Login successful');
  }

  /**
   * Generate authentication headers for REST API calls
   */
  async getAuthHeaders(): Promise<Record<string, string>> {
    const timestamp = Date.now();
    const signature = await this.wallet.signMessage(timestamp.toString());

    return {
      'X-LyraWallet': this.deriveWalletAddress,
      'X-LyraTimestamp': timestamp.toString(),
      'X-LyraSignature': signature,
    };
  }

  getDeriveWalletAddress(): string {
    return this.deriveWalletAddress;
  }

  getWallet(): ethers.Wallet {
    return this.wallet;
  }
}
