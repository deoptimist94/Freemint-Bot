/**
 * Chain Configuration - Production Version
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

export type { Hex, Address };
export type { ChainId, ChainSelection };
export { getDefaultChainId, resolveBaseRpcUrl, resolveRobinhoodRpcUrl };

export const BASE_CHAIN_ID = 8453;
export const baseChain: Chain = baseViemChain;
export const robinhoodChain: Chain = robinhoodViemChain;

// Backward compatibility - keep this export
export function getBaseRpcUrl(): string {
  return resolveBaseRpcUrl();
}

// Provider rotation
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

function getProviderUrl(chain: ChainId): string {
  const providers = PROVIDERS[chain];
  if (providers.length === 0) {
    return chain === "base" ? "https://mainnet.base.org" : "https://robinhoodchain.blockscout.com";
  }
  
  const rotationIndex = providerRotation[chain] % providers.length;
  return providers[rotationIndex].url;
}

export function markProviderFailed(chain: ChainId): void {
  const providers = PROVIDERS[chain];
  if (providers.length <= 1) return;
  providerRotation[chain]++;
}

export function getPublicClient(chain?: ChainId): PublicClient {
  const target = chain ?? getDefaultChainId();
  const config = getChainConfig(target);
  
  return createPublicClient({
    chain: config.viemChain,
    transport: http(getProviderUrl(target), {
      timeout: 15000,
      retryCount: 1,
      retryDelay: 500,
    }),
  }) as PublicClient;
}

export function getWalletClient(privateKey: Hex, chain?: ChainId): WalletClient {
  const target = chain ?? getDefaultChainId();
  const account = privateKeyToAccount(privateKey);
  const config = getChainConfig(target);
  
  return createWalletClient({
    account,
    chain: config.viemChain,
    transport: http(getProviderUrl(target), {
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
