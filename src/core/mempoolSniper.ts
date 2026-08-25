import { type ChainId } from "./chains.js";
import { getRPCPool } from "./rpcPool.js";

const MINT_SELECTORS = new Set([
  "0x1249c58b", "0xa0712d68", "0x6a627842", "0x40c10f19",
  "0x4e6ec247", "0x84bb1e42", "0xa6f2ae3a", "0x161ac21f",
]);

export interface MempoolMint {
  txHash: string;
  contractAddress: string;
  selector: string;
  from: string;
  value: string;
  chain: ChainId;
  detectedAt: number;
}

type MempoolCallback = (mint: MempoolMint) => Promise<void>;

export class MempoolMonitor {
  private chain: ChainId;
  private callback: MempoolCallback;
  private isRunning = false;
  private processedTxs = new Map<string, number>();
  private readonly MAX_CACHE = 10000;
  private readonly CACHE_TTL = 10 * 60 * 1000;
  private pollInterval: NodeJS.Timeout | null = null;
  private baseDelay = 4000;
  private currentDelay = this.baseDelay;
  private maxDelay = 30000;
  private consecutiveErrors = 0;
  private lastBlockNumber: bigint | null = null;

  constructor(chain: ChainId, callback: MempoolCallback) {
    this.chain = chain;
    this.callback = callback;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[${this.chain}] Mempool Monitor starting (interval: ${this.currentDelay}ms)`);
    this.startPolling();
    this.startCacheCleanup();
  }

  private startPolling(): void {
    const poll = async () => {
      if (!this.isRunning) return;
      
      try {
        const pool = getRPCPool(this.chain);
        const provider = pool.getProvider();
        if (!provider) {
          this.handleError(new Error("No healthy providers"));
          scheduleNext();
          return;
        }

        const { getPublicClient } = await import("./chain.js");
        const client = await pool.dedupRequest(
          `getPublicClient-${this.chain}`,
          () => Promise.resolve(getPublicClient(this.chain))
        );

        const block = await pool.dedupRequest(
          `pendingBlock-${this.chain}`,
          () => client.getBlock({ blockTag: "pending", includeTransactions: true })
        ).catch(() => null);

        if (!block) {
          scheduleNext();
          return;
        }

        if (this.lastBlockNumber && block.number === this.lastBlockNumber) {
          scheduleNext();
          return;
        }
        this.lastBlockNumber = block.number;

        if (block.transactions) {
          for (const tx of block.transactions) {
            this.processTransaction(tx as any);
          }
        }
        
        if (this.consecutiveErrors > 0) {
          console.log(`[${this.chain}] Mempool recovered`);
          this.consecutiveErrors = 0;
          this.currentDelay = this.baseDelay;
        }
        
      } catch (error: any) {
        this.handleError(error);
      }
      
      scheduleNext();
    };
    
    const scheduleNext = () => {
      if (this.isRunning) {
        this.pollInterval = setTimeout(poll, this.currentDelay);
      }
    };
    
    poll();
  }

  private handleError(error: any): void {
    this.consecutiveErrors++;
    const oldDelay = this.currentDelay;
    this.currentDelay = Math.min(this.currentDelay * 1.5, this.maxDelay);
    
    const errorStr = JSON.stringify(error).toLowerCase();
    if (errorStr.includes("rate") || errorStr.includes("limit") || errorStr.includes("-32003") || errorStr.includes("-32007")) {
      console.warn(`[${this.chain}] Mempool rate limited: ${oldDelay}ms -> ${this.currentDelay}ms`);
    }
  }

  private processTransaction(tx: any): void {
    if (!tx?.to || !tx?.input || tx.input === "0x") return;
    if (tx.value && BigInt(tx.value) > 0n) return;

    const selector = tx.input.slice(0, 10).toLowerCase();
    if (!MINT_SELECTORS.has(selector)) return;

    const now = Date.now();
    if (this.processedTxs.has(tx.hash)) {
      this.processedTxs.set(tx.hash, now);
      return;
    }

    this.processedTxs.set(tx.hash, now);

    const mint: MempoolMint = {
      txHash: tx.hash,
      contractAddress: tx.to.toLowerCase(),
      selector,
      from: tx.from?.toLowerCase() || "",
      value: tx.value || "0",
      chain: this.chain,
      detectedAt: now,
    };

    this.callback(mint).catch(console.error);
  }

  private startCacheCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      let cleaned = 0;
      
      for (const [hash, timestamp] of this.processedTxs) {
        if (now - timestamp > this.CACHE_TTL) {
          this.processedTxs.delete(hash);
          cleaned++;
        }
      }
      
      if (this.processedTxs.size > this.MAX_CACHE) {
        const sorted = Array.from(this.processedTxs.entries())
          .sort((a, b) => a[1] - b[1]);
        const toDelete = sorted.slice(0, sorted.length - this.MAX_CACHE + 1000);
        for (const [hash] of toDelete) {
          this.processedTxs.delete(hash);
          cleaned++;
        }
      }
      
      if (cleaned > 0) {
        console.log(`[${this.chain}] Mempool cache cleaned: ${cleaned} entries, ${this.processedTxs.size} remaining`);
      }
    }, 60000);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.pollInterval) {
      clearTimeout(this.pollInterval);
      this.pollInterval = null;
    }
  }
}
