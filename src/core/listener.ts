import { getAddress } from "viem";
import { getPublicClient } from "./chain.js";

// Common 4-byte free-mint selectors
const MINT_SELECTORS = new Set([
  "0x1249c58b", // mint()
  "0xa0712d68", // mint(uint256)
  "0x6a627842", // mint(address)
  "0x4e6ec247", // claim()
  "0xefef39a1", // publicMint()
  "0x84bb1e42", // mintFree()
  "0xa6f2ae3a", // claim(address,uint256)
]);

export interface DropEvent {
  contractAddress: string;
  selector: string;
  txHash: string;
  timestamp: number;
}

export type DropCallback = (drop: DropEvent) => Promise<void>;

const MAX_SEEN = 2000;
const BASE_RECONNECT_MS = 2_000;
const MAX_RECONNECT_MS = 30_000;

export class BaseDropListener {
  private isRunning = false;
  private unwatch: (() => void) | null = null;
  private seenContracts = new Set<string>();
  private seenOrder: string[] = [];
  private reconnectDelay = BASE_RECONNECT_MS;
  private onDropDetected: DropCallback;

  constructor(onDropDetected: DropCallback) {
    this.onDropDetected = onDropDetected;
  }

  public start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log("📡 Free-Mint Auto-Discovery Listener active on Base...");
    this.subscribe();
  }

  private subscribe() {
    const client = getPublicClient();

    this.unwatch = client.watchBlocks({
      includeTransactions: true,
      emitMissed: false,
      onBlock: async (block) => {
        await this.handleBlock(block);
      },
      onError: (error) => {
        console.error("Block watcher error:", error);
        this.scheduleReconnect();
      },
    });
  }

  private scheduleReconnect() {
    if (!this.isRunning) return;

    // Tear down the dead subscription so a later stop() can't act on it.
    if (this.unwatch) {
      try { this.unwatch(); } catch { /* ignore */ }
      this.unwatch = null;
    }

    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_MS);
    console.log(`🔁 Block watcher re-subscribing in ${delay}ms...`);

    setTimeout(() => {
      if (!this.isRunning) return;
      try {
        this.subscribe();
        this.reconnectDelay = BASE_RECONNECT_MS; // success → reset backoff
      } catch (err) {
        console.error("Block watcher re-subscribe failed:", err);
        this.scheduleReconnect();
      }
    }, delay);
  }

  private rememberContract(addr: string): boolean {
    if (this.seenContracts.has(addr)) return false;

    this.seenContracts.add(addr);
    this.seenOrder.push(addr);

    // Evict oldest entries once the cache is full (FIFO) so we never wipe
    // everything and re-alert on known contracts.
    while (this.seenOrder.length > MAX_SEEN) {
      const oldest = this.seenOrder.shift();
      if (oldest) this.seenContracts.delete(oldest);
    }
    return true;
  }

  private async handleBlock(block: any): Promise<void> {
    const txs = block?.transactions ?? [];
    for (const tx of txs) {
      if (!tx?.to || !tx?.input || tx.input === "0x") continue;

      // Only evaluate zero-value transactions (free mints)
      if (tx.value !== 0n) continue;

      const selector = tx.input.slice(0, 10).toLowerCase();
      if (!MINT_SELECTORS.has(selector)) continue;

      const contractAddr = getAddress(tx.to);

      // Avoid duplicate processing within the same session
      if (!this.rememberContract(contractAddr)) continue;

      console.log(`🎯 Free-mint candidate detected: ${contractAddr} (sig: ${selector})`);

      this.onDropDetected({
        contractAddress: contractAddr,
        selector,
        txHash: tx.hash,
        timestamp: Date.now(),
      }).catch((err) => console.error("Drop handler error:", err));
    }
  }

  public stop() {
    this.isRunning = false;
    if (this.unwatch) {
      this.unwatch();
      this.unwatch = null;
    }
    console.log("🛑 Auto-Discovery Listener stopped.");
  }
}
