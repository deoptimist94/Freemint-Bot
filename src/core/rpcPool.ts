
/**
 * RPC Pool - Enterprise Grade with Request Deduplication
 * Alchemy-Only Configuration for Professional Multi-User Operation
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
  rateLimitedUntil: number;
  requestCount: number; // Track actual request volume
}

type ChainId = "base" | "robinhood";

const RATE_LIMIT_PATTERNS = [
  "rate limit",
  "daily request limit",
  "too many requests",
  "exceeded",
  "quota",
  "-32003",
  "-32005",
  "-32007", // Alchemy rate limit
  "429",
  "403", // Auth errors
];

// NEW: Request deduplication cache
interface PendingRequest<T> {
  promise: Promise<T>;
  timestamp: number;
}
const pendingRequests = new Map<string, PendingRequest<any>>();
const REQUEST_DEDUP_TTL = 5000; // 5s deduplication window

class RPCPool {
  private providers: Map<string, RPCProvider> = new Map();
  private chain: ChainId;
  private healthCheckInterval!: NodeJS.Timeout;
  private circuitBreakerOpen = false;
  private circuitBreakerResetTime = 0;
  private requestQueue: Array<() => void> = []; // NEW: Request queue for rate limiting
  private processingQueue = false;

  constructor(chain: ChainId) {
    this.chain = chain;
    this.initializeProviders();
    this.startHealthChecks();
    this.startMetricsLogging();
  }

  private initializeProviders(): void {
    // ALCHEMY-ONLY CONFIGURATION
    const configs: Record<ChainId, Array<{ name: string; url: string; weight: number }>> = {
      base: [
        { 
          name: "Alchemy-Base-Primary", 
          url: process.env.ALCHEMY_BASE_API_KEY 
            ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_BASE_API_KEY}` 
            : "", 
          weight: 70 
        },
        { 
          name: "Alchemy-Base-Backup", 
          url: process.env.ALCHEMY_BASE_BACKUP_KEY 
            ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_BASE_BACKUP_KEY}` 
            : "", 
          weight: 30 
        },
      ],
      robinhood: [
        { 
          name: "Alchemy-Robinhood-Primary", 
          url: process.env.ALCHEMY_ROBINHOOD_API_KEY 
            ? `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_ROBINHOOD_API_KEY}` 
            : "", 
          weight: 70 
        },
        { 
          name: "Alchemy-Robinhood-Backup", 
          url: process.env.ALCHEMY_ROBINHOOD_BACKUP_KEY 
            ? `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_ROBINHOOD_BACKUP_KEY}` 
            : "", 
          weight: 30 
        },
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
        rateLimitedUntil: 0,
        requestCount: 0,
      });
    }

    if (this.providers.size === 0) {
      throw new Error(`[${this.chain}] No Alchemy providers configured! Set ALCHEMY_${this.chain.toUpperCase()}_API_KEY`);
    }

    console.log(`[${this.chain}] RPC Pool initialized with ${this.providers.size} Alchemy providers`);
  }

  // NEW: Deduplicate identical requests
  public async dedupRequest<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = pendingRequests.get(key);
    if (existing && Date.now() - existing.timestamp < REQUEST_DEDUP_TTL) {
      return existing.promise;
    }

    const promise = fn();
    pendingRequests.set(key, { promise, timestamp: Date.now() });

    // Cleanup old entries periodically
    if (pendingRequests.size > 1000) {
      const now = Date.now();
      for (const [k, v] of pendingRequests) {
        if (now - v.timestamp > REQUEST_DEDUP_TTL * 2) {
          pendingRequests.delete(k);
        }
      }
    }

    try {
      const result = await promise;
      return result;
    } finally {
      setTimeout(() => pendingRequests.delete(key), REQUEST_DEDUP_TTL);
    }
  }

  public getProvider(): RPCProvider | null {
    if (this.circuitBreakerOpen && Date.now() < this.circuitBreakerResetTime) {
      console.warn(`[${this.chain}] Circuit breaker open - backing off for ${Math.ceil((this.circuitBreakerResetTime - Date.now())/1000)}s`);
      return null;
    }
    this.circuitBreakerOpen = false;

    // Sort by health, then by load
    const providers = Array.from(this.providers.values())
      .filter(p => {
        if (!p.healthy) return false;
        if (Date.now() < p.rateLimitedUntil) return false;
        return true;
      })
      .sort((a, b) => {
        // Prefer lower load
        const loadDiff = a.currentLoad - b.currentLoad;
        if (loadDiff !== 0) return loadDiff;
        // Then prefer lower response time
        return a.avgResponseTime - b.avgResponseTime;
      });

    if (providers.length === 0) {
      console.error(`[${this.chain}] CRITICAL: No healthy Alchemy providers!`);
      const anyProvider = Array.from(this.providers.values())[0];
      return anyProvider || null;
    }

    // Use weighted random from top 2 providers
    const topProviders = providers.slice(0, 2);
    const totalWeight = topProviders.reduce((sum, p) => sum + p.weight, 0);
    let random = Math.random() * totalWeight;
    
    for (const provider of topProviders) {
      random -= provider.weight;
      if (random <= 0) {
        provider.currentLoad++;
        provider.lastUsed = Date.now();
        provider.requestCount++;
        return provider;
      }
    }

    return topProviders[0];
  }

  // NEW: Queue requests when rate limited
  public async queueRequest<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.requestQueue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processingQueue) return;
    this.processingQueue = true;

    while (this.requestQueue.length > 0) {
      const provider = this.getProvider();
      if (!provider) {
        // Rate limited - wait and retry
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      const request = this.requestQueue.shift();
      if (request) {
        await request();
        // Small delay between requests to avoid hammering
        await new Promise(r => setTimeout(r, 50));
      }
    }

    this.processingQueue = false;
  }

  public reportSuccess(providerName: string, responseTime: number): void {
    const provider = this.providers.get(providerName);
    if (!provider) return;
    
    provider.totalRequests++;
    provider.currentLoad = Math.max(0, provider.currentLoad - 1);
    provider.avgResponseTime = (provider.avgResponseTime * 0.9) + (responseTime * 0.1);
    provider.failedRequests = Math.max(0, provider.failedRequests - 1);
    
    if (provider.failedRequests === 0) {
      provider.rateLimitedUntil = 0;
    }
  }

  public reportFailure(providerName: string, error: any): void {
    const provider = this.providers.get(providerName);
    if (!provider) return;
    
    provider.failedRequests++;
    provider.currentLoad = Math.max(0, provider.currentLoad - 1);
    
    const errorStr = JSON.stringify(error).toLowerCase();
    const isRateLimit = RATE_LIMIT_PATTERNS.some(pattern => 
      errorStr.includes(pattern.toLowerCase()) ||
      error?.message?.toLowerCase().includes(pattern.toLowerCase()) ||
      error?.code?.toString().includes(pattern)
    );
    
    if (isRateLimit) {
      provider.healthy = false;
      provider.rateLimitedUntil = Date.now() + 60000;
      console.warn(`[${this.chain}] ${providerName} RATE LIMITED - backing off 60s`);
      
      // Check if we should open circuit breaker
      const healthyProviders = Array.from(this.providers.values()).filter(p => 
        p.healthy && Date.now() >= p.rateLimitedUntil
      );
      
      if (healthyProviders.length === 0) {
        this.circuitBreakerOpen = true;
        this.circuitBreakerResetTime = Date.now() + 30000;
        console.error(`[${this.chain}] ALL PROVIDERS RATE LIMITED - circuit breaker active`);
      }
    } else if (provider.failedRequests > 2) { // Even more aggressive
      provider.healthy = false;
    }
  }

  private startHealthChecks(): void {
    this.healthCheckInterval = setInterval(() => {
      for (const [name, provider] of this.providers) {
        if (!provider.healthy && Date.now() > provider.rateLimitedUntil) {
          if (Date.now() - provider.lastUsed > 20000) { // 20s cooldown
            provider.healthy = true;
            provider.failedRequests = Math.floor(provider.failedRequests * 0.3);
            provider.rateLimitedUntil = 0;
            console.log(`[${this.chain}] ${name} recovered`);
          }
        }
        
        provider.currentLoad = Math.max(0, provider.currentLoad - 1);
      }
    }, 5000); // Check every 5s
  }

  // NEW: Metrics logging for monitoring
  private startMetricsLogging(): void {
    setInterval(() => {
      const stats = this.getStats();
      const totalRequests = stats.reduce((sum, s) => sum + s.requestCount, 0);
      const healthyCount = stats.filter(s => s.healthy && !s.rateLimited).length;
      
      console.log(`[${this.chain}] RPC Metrics: ${healthyCount}/${stats.length} healthy, ${totalRequests} total requests`);
      
      // Reset counters
      for (const provider of this.providers.values()) {
        provider.requestCount = 0;
      }
    }, 60000); // Every minute
  }

  public getStats(): Array<{ name: string; healthy: boolean; load: number; avgTime: number; rateLimited: boolean; requests: number }> {
    return Array.from(this.providers.values()).map(p => ({
      name: p.name,
      healthy: p.healthy,
      load: p.currentLoad,
      avgTime: Math.round(p.avgResponseTime),
      rateLimited: Date.now() < p.rateLimitedUntil,
      requests: p.requestCount,
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

export function getRPCStats(chain: ChainId) {
  return getRPCPool(chain).getStats();
}

// NEW: Export deduplication helper
export function dedupRPCRequest<T>(chain: ChainId, key: string, fn: () => Promise<T>): Promise<T> {
  return getRPCPool(chain).dedupRequest(key, fn);
}
