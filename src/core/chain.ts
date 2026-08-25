/**
 * Chain Configuration - Production Version with Rate Limit Handling
 */

import {
  createWalletClient,
  http,
  createPublicClient,
  type Address,
  type Hex,
  type Chain,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  baseViemChain,
  robinhoodViemChain,
  getChainConfig,
  getDefaultChainId,
  resolveBaseRpcUrl,
  resolveRobinhoodRpcUrl,
  type ChainId,
  type ChainSelection,
} from "./chains.js";
import { getRPCPool } from "./rpcPool.js"; // NEW: Import RPC pool

export type { Hex, Address };
export type { ChainId, ChainSelection };
export { getDefaultChainId, resolveBaseRpcUrl, resolveRobinhoodRpcUrl };

export const BASE_CHAIN_ID = 8453;
export const baseChain: Chain = baseViemChain;
export const robinhoodChain: Chain = robinhoodViemChain;

// Backward compatibility
export function getBaseRpcUrl(): string {
  return resolveBaseRpcUrl();
}

// NEW: Get provider with failover
function getProviderWithFailover(chain: ChainId): { url: string; name: string } {
  const pool = getRPCPool(chain);
  const provider = pool.getProvider();
  
  if (!provider) {
    console.error(`No healthy providers for ${chain}, using fallback`);
    // Emergency fallback
    return {
      url: chain === "base" ? "https://mainnet.base.org" : "https://robinhoodchain.blockscout.com",
      name: "emergency-fallback",
    };
  }
  
  return { url: provider.url, name: provider.name };
}

// NEW: Wrap client creation with error handling
function createInstrumentedPublicClient(chain: ChainId): PublicClient {
  const { url, name } = getProviderWithFailover(chain);
  const config = getChainConfig(chain);
  
  const client = createPublicClient({
    chain: config.viemChain,
    transport: http(url, {
      timeout: 15000,
      retryCount: 0, // We handle retries ourselves
      retryDelay: 1000,
    }),
  }) as PublicClient;

  // NEW: Wrap methods to track success/failure
  const originalRequest = (client as any).request;
  (client as any).request = async (...args: any[]) => {
    const start = Date.now();
    try {
      const result = await originalRequest.apply(client, args);
      getRPCPool(chain).reportSuccess(name, Date.now() - start);
      return result;
    } catch (error) {
      getRPCPool(chain).reportFailure(name, error);
      throw error;
    }
  };

  return client;
}

export function getPublicClient(chain?: ChainId): PublicClient {
  const target = chain ?? getDefaultChainId();
  return createInstrumentedPublicClient(target);
}

export function getWalletClient(privateKey: Hex, chain?: ChainId): WalletClient {
  const target = chain ?? getDefaultChainId();
  const account = privateKeyToAccount(privateKey);
  const config = getChainConfig(target);
  
  // Wallet client uses same failover logic
  const { url, name } = getProviderWithFailover(target);
  
  const client = createWalletClient({
    account,
    chain: config.viemChain,
    transport: http(url, {
      timeout: 20000,
      retryCount: 0,
      retryDelay: 1000,
    }),
  }) as WalletClient;

  // Instrument wallet client too
  const originalRequest = (client as any).request;
  (client as any).request = async (...args: any[]) => {
    const start = Date.now();
    try {
      const result = await originalRequest.apply(client, args);
      getRPCPool(target).reportSuccess(name, Date.now() - start);
      return result;
    } catch (error) {
      getRPCPool(target).reportFailure(name, error);
      throw error;
    }
  };

  return client;
}

// DEPRECATED: Old rotation logic - kept for compatibility but not used
const providerRotation: Record<ChainId, number> = { base: 0, robinhood: 0 };
const providerFailures: Record<ChainId, number[]> = { base: [0, 0, 0, 0], robinhood: [0, 0, 0] };

const PROVIDERS: Record<ChainId, { name: string; url: string }[]> = {
  base: [
    { name: "QuickNode", url: process.env.QUICKNODE_BASE_RPC || "" },
    { name: "Alchemy", url: process.env.ALCHEMY_API_KEY ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : "" },
    { name: "Infura", url: process.env.INFURA_BASE_RPC || "" },
    { name: "Public", url: "https://mainnet.base.org" },
  ].filter(p => p.url),
  robinhood: [
    { name: "QuickNode", url: process.env.QUICKNODE_ROBINHOOD_RPC || "" },
    { name: "Alchemy", url: process.env.ALCHEMY_API_KEY ? `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : "" },
    { name: "Public", url: "https://robinhoodchain.blockscout.com" },
  ].filter(p => p.url),
};

export function markProviderFailed(chain: ChainId): void {
  // Deprecated - handled by RPC pool now
  const providers = PROVIDERS[chain];
  if (providers.length <= 1) return;
  providerRotation[chain]++;
}

export function getAddressFromPrivateKey(privateKey: Hex): Address {
  return privateKeyToAccount(privateKey).address;
}

export function shortenAddress(addr: string, prefix = 4, suffix = 4): string {
  if (!addr || addr.length <= prefix + suffix + 2) return addr;
  return `${addr.slice(0, prefix + 2)}..${addr.slice(-suffix)}`;
}

export function isValidAddress(addr: string): boolean {
  const stripped = addr.startsWith("0x") ? addr.slice(2) : addr;
  return /^[a-fA-F0-9]{40}$/.test(stripped);
}

export function normalizeAddressInput(addr: string): string {
  const stripped = addr.startsWith("0x") ? addr.slice(2) : addr;
  return `0x${stripped.toLowerCase()}`;
}

export function isValidPrivateKey(key: string): boolean {
  const stripped = key.startsWith("0x") ? key.slice(2) : key;
  return /^[a-fA-F0-9]{64}$/.test(stripped);
}

export function normalizePrivateKey(key: string): Hex {
  const stripped = key.startsWith("0x") ? key.slice(2) : key;
  return `0${stripped.toLowerCase()}` as Hex;
}

export function normalizeAddress(addr: string): string {
  return addr.toLowerCase();
}
