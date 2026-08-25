/**
 * Chain Configuration - Production Version
 * Features: RPC failover, rate limiting, multi-chain support
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
  type ChainId,
  type ChainSelection,
} from "./chains.js";

export type { Hex, Address };
export type { ChainId, ChainSelection };
export { getDefaultChainId };

export const BASE_CHAIN_ID = 8453;
export const baseChain: Chain = baseViemChain;
export const robinhoodChain: Chain = robinhoodViemChain;

// Provider rotation state
const providerRotation: Record<ChainId, number> = { base: 0, robinhood: 0 };
const providerFailures: Record<ChainId, number[]> = { base: [0, 0, 0, 0], robinhood: [0, 0, 0] };

// Provider configs with failover order
const PROVIDERS: Record<ChainId, { name: string; url: string }[]> = {
  base: [
    { name: "QuickNode", url: process.env.QUICKNODE_BASE_RPC || "" },
    { name: "Alchemy", url: process.env.ALCHEMY_API_KEY ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : "" },
    { name: "Ankr", url: "https://rpc.ankr.com/base" },
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
    throw new Error(`No RPC providers configured for ${chain}`);
  }
  
  // Rotate provider based on failures
  const rotationIndex = providerRotation[chain] % providers.length;
  const provider = providers[rotationIndex];
  
  console.log(`🌐 Using ${provider.name} RPC for ${chain}`);
  return provider.url;
}

function markProviderFailed(chain: ChainId): void {
  const providers = PROVIDERS[chain];
  if (providers.length <= 1) return;
  
  const currentIndex = providerRotation[chain] % providers.length;
  providerFailures[chain][currentIndex]++;
  
  // Rotate to next provider
  providerRotation[chain]++;
  console.log(`⚠️ Provider ${providers[currentIndex].name} failed, rotating to next...`);
}

export function getPublicClient(chain?: ChainId): PublicClient {
  const target = chain ?? getDefaultChainId();
  const config = getChainConfig(target);
  
  const transport = http(getProviderUrl(target), {
    timeout: 15000,
    retryCount: 1,
    retryDelay: 500,
    fetchOptions: {
      headers: {
        'Content-Type': 'application/json',
      },
    },
  });
  
  // Wrap to handle failures
  const client = createPublicClient({
    chain: config.viemChain,
    transport,
  }) as PublicClient;
  
  return new Proxy(client, {
    get(target, prop) {
      if (typeof target[prop as keyof PublicClient] === 'function') {
        return async (...args: any[]) => {
          try {
            const result = await (target[prop as keyof PublicClient] as any)(...args);
            return result;
          } catch (error: any) {
            // Check if it's a rate limit or connection error
            if (error?.status === 429 || error?.code === -32005 || error?.message?.includes('rate')) {
              console.log(`🔄 Rate limit hit on ${prop.toString()}, trying failover...`);
              markProviderFailed(target as ChainId);
              // Retry with new provider
              const newClient = createPublicClient({
                chain: config.viemChain,
                transport: http(getProviderUrl(target as ChainId), {
                  timeout: 15000,
                  retryCount: 0,
                }),
              });
              return (newClient[prop as keyof PublicClient] as any)(...args);
            }
            throw error;
          }
        };
      }
      return target[prop as keyof PublicClient];
    },
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
