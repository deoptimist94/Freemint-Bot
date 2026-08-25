/**
 * Mempool Sniper - HTTP polling with rate limit protection
 */

import { type ChainId } from "./chains.js";
import { getRPCPool } from "./rpcPool.js";

const MINT_SELECTORS = new Set([
  "0x1249c58b",
  "0xa0712d68",
  "0x6a627842",
  "0x40c10f19",
  "0x4e6ec247",
  "0x84bb1e42",
  "0xa6f2ae3a",
  "0x161ac21f",
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
  private processedTxs = new Set<string>();
  private readonly MAX_CACHE = 5000;
  private pollInterval: NodeJS.Timeout | null = null;
  
  // NEW: Exponential backoff state
  private baseDelay = 5000; // INCREASED from 2000ms to 5000ms
  private currentDelay = this.baseDelay;
  private maxDelay = 30000; // Max 30s between polls
  private consecutiveErrors = 0;

  constructor(chain: ChainId, callback: MempoolCallback) {
    this.chain = chain;
    this.callback = callback;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`Mempool Monitor starting on ${this.chain} (poll interval: ${this.currentDelay}ms)`);
    this.startPolling();
  }

  private startPolling(): void {
    const poll = async () => {
      if (!this.isRunning) return;
      
      const startTime = Date.now();
      
      try {
        // NEW: Check if circuit breaker is open
        const pool = getRPCPool(this.chain);
        const provider = pool.getProvider();
        if (!provider) {
          console.warn(`[${this.chain}] Mempool: No healthy providers, backing off...`);
          this.consecutiveErrors++;
          this.currentDelay = Math.min(this.currentDelay * 2, this.maxDelay);
          scheduleNext();
          return;
        }

        const { getPublicClient } = await import("./chain.js");
        const client = getPublicClient(this.chain);
        
        // Use pending block - single call instead of two
        const block = await client.getBlock({ 
          blockTag: "pending",
          includeTransactions: true 
        }).catch(() => null);
        
        if (block?.transactions) {
          for (const tx of block.transactions) {
            this.processTransaction(tx as any);
          }
        }
        
        // NEW: Success - reset backoff
        if (this.consecutiveErrors > 0) {
          console.log(`[${this.chain}] Mempool recovered, resetting poll interval`);
          this.consecutiveErrors = 0;
          this.currentDelay = this.baseDelay;
        }
        
      } catch (error: any) {
        this.consecutiveErrors++;
        
        // NEW: Exponential backoff on errors
        const oldDelay = this.currentDelay;
        this.currentDelay = Math.min(this.currentDelay * 1.5, this.maxDelay);
        
        // Check if it's a rate limit
        const errorStr = JSON.stringify(error).toLowerCase();
        if (errorStr.includes("rate") || errorStr.includes("limit") || errorStr.includes("-32003")) {
          console.warn(`[${this.chain}] Mempool rate limited, backing off: ${oldDelay}ms -> ${this.currentDelay}ms`);
        } else {
          console.error(`[${this.chain}] Mempool error:`, error.message || error);
        }
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

  private processTransaction(tx: any): void {
    if (!tx?.to || !tx?.input || tx.input === "0x") return;
    if (tx.value && BigInt(tx.value) > 0n) return;

    const selector = tx.input.slice(0, 10).toLowerCase();
    if (!MINT_SELECTORS.has(selector)) return;

    if (this.processedTxs.has(tx.hash)) return;
    this.processedTxs.add(tx.hash);
    
    if (this.processedTxs.size > this.MAX_CACHE) {
      const toDelete = Array.from(this.processedTxs).slice(0, 1000);
      toDelete.forEach(h => this.processedTxs.delete(h));
    }

    const mint: MempoolMint = {
      txHash: tx.hash,
      contractAddress: tx.to.toLowerCase(),
      selector,
      from: tx.from?.toLowerCase() || "",
      value: tx.value || "0",
      chain: this.chain,
      detectedAt: Date.now(),
    };

    this.callback(mint).catch(console.error);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.pollInterval) {
      clearTimeout(this.pollInterval);
      this.pollInterval = null;
    }
  }
}
