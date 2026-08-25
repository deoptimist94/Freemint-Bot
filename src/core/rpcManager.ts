/**
 * RPC Manager - Multi-Provider Failover System
 * Handles Alchemy limits with automatic fallback to QuickNode, Ankr, and public RPCs
 */

import { http, createPublicClient, type Chain } from "viem";
import { getChainConfig, type ChainId } from "./chains.js";

interface ProviderConfig {
  name: string;
  url: string;
  rateLimitPerSecond: number;
  priority: number;
  healthy: boolean;
  lastFailure: number;
  requestCount: number;
  resetTime: number;
  failureCount: number;
}

interface ProviderStatus {
  name: string;
  healthy: boolean;
  requests: number;
  failures: number;
}

class RPCManager {
  private providers: Map<ChainId, ProviderConfig[]> = new Map();
  private currentIndex: Map<ChainId, number> = new Map();
  private recoveryInterval = 30000; // 30 seconds
  private maxFailures = 3;

  constructor() {
    this.initializeProviders();
    this.startHealthCheck();
  }

  private initializeProviders(): void {
    // Base Chain Providers - Priority order
    const baseProviders: ProviderConfig[] = [
      {
        name: "QuickNode-Base",
        url: process.env.QUICKNODE_BASE_RPC || "",
        rateLimitPerSecond: 100,
        priority: 1,
        healthy: true,
        lastFailure: 0,
        requestCount: 0,
        resetTime: Date.now() + 1000,
        failureCount: 0,
      },
      {
        name: "Alchemy-Base",
        url: process.env.ALCHEMY_API_KEY 
          ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
          : "",
        rateLimitPerSecond: 50,
        priority: 2,
        healthy: true,
        lastFailure: 0,
        requestCount: 0,
        resetTime: Date.now() + 1000,
        failureCount: 0,
      },
      {
        name: "Ankr-Base",
        url: "https://rpc.ankr.com/base",
        rateLimitPerSecond: 50,
        priority: 3,
        healthy: true,
        lastFailure: 0,
        requestCount: 0,
        resetTime: Date.now() + 1000,
        failureCount: 0,
      },
      {
        name: "Public-Base",
        url: "https://mainnet.base.org",
        rateLimitPerSecond: 10,
        priority: 4,
        healthy: true,
        lastFailure: 0,
        requestCount: 0,
        resetTime: Date.now() + 1000,
        failureCount: 0,
      },
    ].filter(p => p.url); // Filter out providers with no URL

    // Robinhood Chain Providers
    const robinhoodProviders: ProviderConfig[] = [
      {
        name: "QuickNode-Robinhood",
        url: process.env.QUICKNODE_ROBINHOOD_RPC || "",
        rateLimitPerSecond: 100,
        priority: 1,
        healthy: true,
        lastFailure: 0,
        requestCount: 0,
        resetTime: Date.now() + 1000,
        failureCount: 0,
      },
      {
        name: "Alchemy-Robinhood",
        url: process.env.ALCHEMY_API_KEY
          ? `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
          : "",
        rateLimitPerSecond: 50,
        priority: 2,
        healthy: true,
        lastFailure: 0,
        requestCount: 0,
        resetTime: Date.now() + 1000,
        failureCount: 0,
      },
      {
        name: "Public-Robinhood",
        url: "https://robinhoodchain.blockscout.com",
        rateLimitPerSecond: 5,
        priority: 3,
        healthy: true,
        lastFailure: 0,
        requestCount: 0,
        resetTime: Date.now() + 1000,
        failureCount: 0,
      },
    ].filter(p => p.url);

    this.providers.set("base", baseProviders);
    this.providers.set("robinhood", robinhoodProviders);
    this.currentIndex.set("base", 0);
    this.currentIndex.set("robinhood", 0);
  }

  private startHealthCheck(): void {
    setInterval(() => {
      const now = Date.now();
      for (const [chainId, providerList] of this.providers) {
        for (const provider of providerList) {
          if (!provider.healthy && now - provider.lastFailure > this.recoveryInterval) {
            console.log(`🔄 RPC Manager: Recovering ${provider.name}`);
            provider.healthy = true;
            provider.failureCount = 0;
          }
        }
      }
    }, 10000);
  }

  private getHealthyProvider(chainId: ChainId): ProviderConfig | null {
    const providers = this.providers.get(chainId) || [];
    const sorted = [...providers].sort((a, b) => a.priority - b.priority);
    
    for (const provider of sorted) {
      if (provider.healthy && provider.url && provider.failureCount < this.maxFailures) {
        return provider;
      }
    }
    return null;
  }

  public async getProvider(chainId: ChainId): Promise<string> {
    const provider = this.getHealthyProvider(chainId);
    
    if (!provider) {
      // Last resort: try any provider even if unhealthy
      const anyProvider = this.providers.get(chainId)?.find(p => p.url);
      if (anyProvider) {
        console.warn(`⚠️ RPC Manager: Using unhealthy provider ${anyProvider.name} as last resort`);
        return anyProvider.url;
      }
      throw new Error(`No RPC providers available for ${chainId}`);
    }

    // Rate limiting check
    const now = Date.now();
    if (now > provider.resetTime) {
      provider.requestCount = 0;
      provider.resetTime = now + 1000;
    }

    if (provider.requestCount >= provider.rateLimitPerSecond) {
      console.log(`⏳ RPC Manager: ${provider.name} rate limited, rotating...`);
      await new Promise(r => setTimeout(r, 100));
      return this.getProvider(chainId);
    }

    provider.requestCount++;
    return provider.url;
  }

  public markFailed(chainId: ChainId, rpcUrl: string): void {
    const providers = this.providers.get(chainId) || [];
    const provider = providers.find(p => p.url === rpcUrl);
    
    if (provider) {
      provider.failureCount++;
      provider.lastFailure = Date.now();
      
      if (provider.failureCount >= this.maxFailures) {
        console.warn(`⚠️ RPC Manager: ${provider.name} marked unhealthy after ${provider.failureCount} failures`);
        provider.healthy = false;
      }
    }
  }

  public markSuccess(chainId: ChainId, rpcUrl: string): void {
    const providers = this.providers.get(chainId) || [];
    const provider = providers.find(p => p.url === rpcUrl);
    
    if (provider && provider.failureCount > 0) {
      provider.failureCount = 0;
    }
  }

  public getStatus(chainId: ChainId): ProviderStatus[] {
    return (this.providers.get(chainId) || []).map(p => ({
      name: p.name,
      healthy: p.healthy,
      requests: p.requestCount,
      failures: p.failureCount,
    }));
  }

  public getBestProvider(chainId: ChainId): string | null {
    const provider = this.getHealthyProvider(chainId);
    return provider?.url || null;
  }
}

// Singleton instance
let rpcManager: RPCManager | null = null;

export function getRPCManager(): RPCManager {
  if (!rpcManager) {
    rpcManager = new RPCManager();
  }
  return rpcManager;
}

export async function getRpcUrlWithFailover(chainId: ChainId): Promise<string> {
  const manager = getRPCManager();
  return manager.getProvider(chainId);
}

export function getRpcStatus(chainId: ChainId): ProviderStatus[] {
  const manager = getRPCManager();
  return manager.getStatus(chainId);
}
