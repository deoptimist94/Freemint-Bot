import { type ChainId } from "./chains.js";
import { getRPCPool } from "./rpcPool.js";
import { isZeroTransactionValue } from "./listener.js";
import { evaluateNftEligibility } from "./scanner.js";

const MINT_SELECTORS = new Set([
  "0x1249c58b", // mint()
  "0xa0712d68", // mint(uint256)
  "0x6a627842", // mint(address)
  "0x40c10f19", // mint(address,uint256)
  "0x4e6ec247", // claim()
  "0x84bb1e42", // claim(uint256)
  "0xa6f2ae3a", // claim(address,uint256)
  "0x161ac21f", // mintPublic (SeaDrop)
  "0xefef39a1", // mintSeaDrop
  "0x2db11544", // mintSigned
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
  private cleanupInterval: NodeJS.Timeout | null = null;
  private baseDelay = 5000;
  private currentDelay = this.baseDelay;
  private maxDelay = 30000;
  private consecutiveErrors = 0;
  private lastBlockNumber: bigint | null = null;
  private errorStreak = 0;

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

        // Get pending block with transactions
        const block = await pool.dedupRequest(
          `pendingBlock-${this.chain}`,
          () => client.getBlock({ 
            blockTag: "pending", 
            includeTransactions: true 
          })
        ).catch((err) => {
          if (this.errorStreak < 3) {
            console.warn(`[${this.chain}] Failed to get pending block:`, err.message);
          }
          return null;
        });

        if (!block) {
          scheduleNext();
          return;
        }

        // Check if new block
        if (this.lastBlockNumber && block.number === this.lastBlockNumber) {
          scheduleNext();
          return;
        }
        this.lastBlockNumber = block.number;

        // Process transactions
        if (block.transactions) {
          for (const tx of block.transactions) {
            await this.processTransaction(tx as any);
          }
        }
        
        // Reset error state on success
        if (this.consecutiveErrors > 0) {
          console.log(`[${this.chain}] Mempool recovered`);
          this.consecutiveErrors = 0;
          this.errorStreak = 0;
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
    this.errorStreak++;
    const oldDelay = this.currentDelay;
    this.currentDelay = Math.min(this.currentDelay * 1.5, this.maxDelay);
    
    const errorStr = JSON.stringify(error).toLowerCase();
    const isRateLimit = errorStr.includes("rate") || 
                       errorStr.includes("limit") || 
                       errorStr.includes("-32003") || 
                       errorStr.includes("-32007") ||
                       errorStr.includes("429");
    
    if (isRateLimit) {
      console.warn(`[${this.chain}] Mempool rate limited: ${oldDelay}ms -> ${this.currentDelay}ms`);
    } else if (this.errorStreak <= 3) {
      console.warn(`[${this.chain}] Mempool error (${this.errorStreak}):`, error.message || error);
    }
  }

  private async processTransaction(tx: any): Promise<void> {
    if (!tx?.to || !tx?.input || tx.input === "0x") return;
    if (!isZeroTransactionValue(tx.value)) return; // Skip paid transactions

    const selector = tx.input.slice(0, 10).toLowerCase();
    if (!MINT_SELECTORS.has(selector)) return;

    const target = String(tx.to).toLowerCase();
    try {
      const { scanContract } = await import("./scanner.js");
      const scan = await scanContract(target, this.chain);
      if (!scan.isNft || scan.rejectionReason || !scan.mintFunctions.length) {
        return;
      }
    } catch {
      return;
    }

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

    // Execute callback with error isolation
    try {
      await this.callback(mint);
    } catch (err) {
      console.error(`[${this.chain}] Mempool callback error:`, err);
    }
  }

  private startCacheCleanup(): void {
    this.cleanupInterval = setInterval(() => {
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
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    console.log(`[${this.chain}] Mempool Monitor stopped`);
  }
}
