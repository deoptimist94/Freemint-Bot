/**
 * Chain Configuration - Production Version
 * Features: RPC failover integration, multi-chain support
 */

import {
  createWalletClient,
  http,
  createPublicClient,
  type Address,
  type Hex,
  type Chain,
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
import { getRpcUrlWithFailover, getRPCManager } from "./rpcManager.js";

export type { Hex, Address };
export type { ChainId, ChainSelection };
export { getDefaultChainId, resolveBaseRpcUrl, resolveRobinhoodRpcUrl };

export const BASE_CHAIN_ID = 8453;

export const baseChain: Chain = baseViemChain;
export const robinhoodChain: Chain = robinhoodViemChain;

export function getRpcUrl(chain: ChainId = "base"): string {
  return getChainConfig(chain).resolveRpcUrl();
}

export function getBaseRpcUrl(): string {
  return resolveBaseRpcUrl();
}

export async function getPublicClientAsync(chain?: ChainId) {
  const target = chain ?? getDefaultChainId();
  const rpcUrl = await getRpcUrlWithFailover(target);
  const config = getChainConfig(target);
  
  return createPublicClient({
    chain: config.viemChain,
    transport: http(rpcUrl, {
      timeout: 20000,
      retryCount: 2,
      retryDelay: 400,
    }),
  });
}

export function getPublicClient(chain?: ChainId) {
  const target = chain ?? getDefaultChainId();
  const config = getChainConfig(target);
  
  // Try to get from RPC manager first
  const manager = getRPCManager();
  const bestUrl = manager.getBestProvider(target);
  
  return createPublicClient({
    chain: config.viemChain,
    transport: http(bestUrl || config.resolveRpcUrl(), {
      timeout: 20000,
      retryCount: 2,
      retryDelay: 400,
    }),
  });
}

export function getWalletClient(privateKey: Hex, chain?: ChainId) {
  const target = chain ?? getDefaultChainId();
  const account = privateKeyToAccount(privateKey);
  const config = getChainConfig(target);
  
  const manager = getRPCManager();
  const bestUrl = manager.getBestProvider(target);
  
  return createWalletClient({
    account,
    chain: config.viemChain,
    transport: http(bestUrl || config.resolveRpcUrl(), {
      timeout: 20000,
      retryCount: 2,
      retryDelay: 400,
    }),
  });
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
  return `0x${stripped.toLowerCase()}` as Hex;
}

export function normalizeAddress(addr: string): string {
  return addr.toLowerCase();
}
