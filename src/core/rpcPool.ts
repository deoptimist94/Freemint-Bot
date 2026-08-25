/**
 * RPC Pool - Enterprise Grade
 */

interface RPCProvider {
  name: string;
  url: string;
  weight: number;
  currentLoad: number;
  failedRequests: number;
  totalRequests: number;
  avgResponseTime: number;
  healthy: boolean;
  lastUsed: number;
}

type ChainId = "base" | "robinhood";

class RPCPool {
  private providers: Map<string, RPCProvider> = new Map();
  private chain: ChainId;
  private healthCheckInterval!: NodeJS.Timeout;

  constructor(chain: ChainId) {
    this.chain = chain;
    this.initializeProviders();
    this.startHealthChecks();
  }

  private initializeProviders(): void {
    const configs: Record<ChainId, Array<{ name: string; url: string; weight: number }>> = {
      base: [
        { name: "QuickNode-Base", url: process.env.QUICKNODE_BASE_RPC || "", weight: 35 },
        { name: "Alchemy-Base", url: process.env.ALCHEMY_API_KEY ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : "", weight: 30 },
        { name: "Infura-Base", url: process.env.INFURA_BASE_RPC || "", weight: 20 },
        { name: "Public-Base", url: "https://mainnet.base.org", weight: 5 },
      ],
      robinhood: [
        { name: "QuickNode-RH", url: process.env.QUICKNODE_ROBINHOOD_RPC || "", weight: 60 },
        { name: "Alchemy-RH", url: process.env.ALCHEMY_API_KEY ? `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : "", weight: 30 },
        { name: "Public-RH", url: "https://robinhoodchain.blockscout.com", weight: 10 },
      ],
    };

    const chainProviders = configs[this.chain] || [];
    
    for (const config of chainProviders) {
      if (!config.url) continue;
      
      this.providers.set(config.name, {
        name: config.name,
        url: config.url,
        weight: config.weight,
        currentLoad: 0,
        failedRequests: 0,
        totalRequests: 0,
        avgResponseTime: 0,
        healthy: true,
        lastUsed: 0,
      });
    }

    console.log(`RPC Pool initialized for ${this.chain} with ${this.providers.size} providers`);
  }

  public getProvider(): RPCProvider {
    const healthy = Array.from(this.providers.values()).filter(p => p.healthy);
    
    if (healthy.length === 0) {
      const anyProvider = Array.from(this.providers.values())[0];
      return anyProvider;
    }

    const totalWeight = healthy.reduce((sum, p) => {
      const performanceScore = Math.max(0, 100 - p.avgResponseTime);
      const reliabilityScore = Math.max(0, 100 - p.failedRequests * 10);
      return sum + (p.weight * performanceScore * reliabilityScore) / 10000;
    }, 0);

    let random = Math.random() * totalWeight;
    
    for (const provider of healthy) {
      const performanceScore = Math.max(0, 100 - provider.avgResponseTime);
      const reliabilityScore = Math.max(0, 100 - provider.failedRequests * 10);
      const adjustedWeight = (provider.weight * performanceScore * reliabilityScore) / 10000;
      
      random -= adjustedWeight;
      if (random <= 0) {
        provider.currentLoad++;
        provider.lastUsed = Date.now();
        return provider;
      }
    }

    return healthy[0];
  }

  public reportSuccess(providerName: string, responseTime: number): void {
    const provider = this.providers.get(providerName);
    if (!provider) return;
    
    provider.totalRequests++;
    provider.currentLoad = Math.max(0, provider.currentLoad - 1);
    provider.avgResponseTime = (provider.avgResponseTime * 0.9) + (responseTime * 0.1);
    provider.failedRequests = Math.max(0, provider.failedRequests - 1);
  }

  public reportFailure(providerName: string, error: any): void {
    const provider = this.providers.get(providerName);
    if (!provider) return;
    
    provider.failedRequests++;
    provider.currentLoad = Math.max(0, provider.currentLoad - 1);
    
    if (provider.failedRequests > 10) {
      provider.healthy = false;
    }
    
    if (error?.status === 429 || error?.message?.includes("rate")) {
      console.warn(`${providerName} rate limited`);
    }
  }

  private startHealthChecks(): void {
    this.healthCheckInterval = setInterval(() => {
      for (const [name, provider] of this.providers) {
        if (!provider.healthy && Date.now() - provider.lastUsed > 60000) {
          provider.healthy = true;
          provider.failedRequests = Math.floor(provider.failedRequests * 0.5);
          console.log(`${name} recovered`);
        }
        
        provider.currentLoad = Math.max(0, provider.currentLoad - 1);
      }
    }, 10000);
  }

  public getStats(): Array<{ name: string; healthy: boolean; load: number; avgTime: number }> {
    return Array.from(this.providers.values()).map(p => ({
      name: p.name,
      healthy: p.healthy,
      load: p.currentLoad,
      avgTime: Math.round(p.avgResponseTime),
    }));
  }

  public destroy(): void {
    clearInterval(this.healthCheckInterval);
  }
}

const pools: Map<ChainId, RPCPool> = new Map();

export function getRPCPool(chain: ChainId): RPCPool {
  if (!pools.has(chain)) {
    pools.set(chain, new RPCPool(chain));
  }
  return pools.get(chain)!;
}

export function getRPCStats(chain: ChainId): Array<{ name: string; healthy: boolean; load: number; avgTime: number }> {
  return getRPCPool(chain).getStats();
}
