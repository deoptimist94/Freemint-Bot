/**
 * Mempool Sniper - Professional Edition
 * Monitors pending transactions in mempool for instant detection
 * 10x faster than block polling
 */

import { type Hex, type Address } from "viem";
import { getPublicClient, type ChainId } from "./chain.js";
import { scanContract, getBestMintFunction } from "./scanner.js";
import { withChainContext } from "./chainContext.js";

// Mempool monitoring using WebSocket/HTTP streaming
const MINT_SELECTORS = new Set([
  "0x1249c58b", // mint()
  "0xa0712d68", // mint(uint256)
  "0x6a627842", // mint(address)
  "0x40c10f19", // mint(address,uint256)
  "0x4e6ec247", // claim()
  "0x84bb1e42", // mintFree()
  "0xa6f2ae3a", // claim(address,uint256)
  "0x161ac21f", // mintPublic (SeaDrop)
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
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private processedTxs = new Set<string>();
  private readonly MAX_CACHE = 5000;

  constructor(chain: ChainId, callback: MempoolCallback) {
    this.chain = chain;
    this.callback = callback;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`🎯 Mempool Monitor starting on ${this.chain}...`);
    this.subscribe();
  }

  private async subscribe(): Promise<void> {
    try {
      // Use Alchemy WebSocket if available, otherwise HTTP polling
      const wsUrl = this.getWebSocketUrl();
      
      if (wsUrl && typeof WebSocket !== 'undefined') {
        await this.connectWebSocket(wsUrl);
      } else {
        // Fallback to HTTP mempool polling
        this.startHttpPolling();
      }
    } catch (error) {
      console.error(`Mempool subscription failed (${this.chain}):`, error);
      this.scheduleReconnect();
    }
  }

  private getWebSocketUrl(): string | null {
    const key = process.env.ALCHEMY_API_KEY;
    if (!key) return null;
    
    if (this.chain === 'base') {
      return `wss://base-mainnet.g.alchemy.com/v2/${key}`;
    } else if (this.chain === 'robinhood') {
      return `wss://robinhood-mainnet.g.alchemy.com/v2/${key}`;
    }
    return null;
  }

  private async connectWebSocket(url: string): Promise<void> {
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log(`✅ WebSocket connected for ${this.chain}`);
      
      // Subscribe to pending transactions
      this.ws?.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_subscribe",
        params: ["alchemy_mempool", { 
          toAddress: null, // All transactions
          fromAddress: null,
          hashesOnly: false
        }]
      }));
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleMempoolMessage(message);
      } catch (error) {
        // Ignore parse errors
      }
    });

    this.ws.on('error', (error) => {
      console.error(`WebSocket error (${this.chain}):`, error);
      this.scheduleReconnect();
    });

    this.ws.on('close', () => {
      console.log(`WebSocket closed (${this.chain}), reconnecting...`);
      this.scheduleReconnect();
    });
  }

  private startHttpPolling(): void {
    console.log(`📡 Using HTTP mempool polling for ${this.chain}`);
    
    const poll = async () => {
      if (!this.isRunning) return;
      
      try {
        const client = await withChainContext(this.chain, () => getPublicClient(this.chain));
        const blockNumber = await client.getBlockNumber();
        
        // Get pending block
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
      
      // Poll every 2 seconds
      if (this.isRunning) {
        setTimeout(poll, 2000);
      }
    };
    
    poll();
  }

  private handleMempoolMessage(message: any): void {
    if (message.params?.result) {
      const tx = message.params.result;
      this.processTransaction(tx);
    }
  }

  private processTransaction(tx: any): void {
    if (!tx?.to || !tx?.input || tx.input === "0x") return;
    if (tx.value && BigInt(tx.value) > 0n) return; // Skip paid mints

    const selector = tx.input.slice(0, 10).toLowerCase();
    if (!MINT_SELECTORS.has(selector)) return;

    // Deduplicate
    if (this.processedTxs.has(tx.hash)) return;
    this.processedTxs.add(tx.hash);
    
    // Cleanup old entries
    if (this.processedTxs.size > this.MAX_CACHE) {
      const toDelete = Array.from(this.processedTxs).slice(0, 1000);
      toDelete.forEach(h => this.processedTxs.delete(h));
    }

    const mint: MempoolMint = {
      txHash: tx.hash,
      contractAddress: tx.to.toLowerCase(),
      selector,
      from: tx.from?.toLowerCase() || '',
      value: tx.value || '0',
      chain: this.chain,
      detectedAt: Date.now(),
    };

    // Fire and forget
    this.callback(mint).catch(console.error);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.isRunning) {
        this.subscribe();
      }
    }, 5000);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
