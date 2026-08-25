/**
 * Mempool Sniper - Uses HTTP polling (WebSocket optional)
 */

import { type ChainId } from "./chains.js";

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

  constructor(chain: ChainId, callback: MempoolCallback) {
    this.chain = chain;
    this.callback = callback;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`Mempool Monitor starting on ${this.chain}`);
    this.startPolling();
  }

  private startPolling(): void {
    const poll = async () => {
      if (!this.isRunning) return;
      
      try {
        // HTTP mempool polling via pending block
        const { getPublicClient } = await import("./chain.js");
        const client = getPublicClient(this.chain);
        
        const blockNumber = await client.getBlockNumber();
        
        // Try to get pending transactions
        const block = await client.getBlock({ 
          blockNumber: blockNumber + 1n,
          includeTransactions: true 
        }).catch(() => null);
        
        if (block?.transactions) {
          for (const tx of block.transactions) {
            this.processTransaction(tx as any);
          }
        }
      } catch (error) {
        // Silent fail for polling
      }
      
      if (this.isRunning) {
        this.pollInterval = setTimeout(poll, 2000);
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
