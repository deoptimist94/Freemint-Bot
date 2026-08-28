/**
 * Enhanced Drop Listener with Strict Verification Filtering
 */

import { getAddress } from "viem";
import { getPublicClient } from "./chain.js";
import type { ChainId } from "./chains.js";
import { getRPCPool } from "./rpcPool.js";
import { scanContract } from "./scanner.js";

const MINT_SELECTORS = new Set([
  "0x1249c58b", // mint()
  "0xa0712d68", // mint(uint256)
  "0x6a627842", // mint(address)
  "0x40c10f19", // mint(address,uint256)
  "0x4e6ec247", // claim()
  "0x84bb1e42", // claim(uint256)
  "0x161ac21f", // mintPublic
  "0xefef39a1", // mintSeaDrop
  "0x6c0360eb", // safeMint(address)
  "0x42842e0e", // safeMint(address,uint256)
  "0x8d45fc5e", // freeMint()
]);

export interface DropEvent {
  contractAddress: string;
  selector: string;
  txHash: string;
  timestamp: number;
}

export type DropCallback = (drop: DropEvent) => Promise<void>;

const MAX_SEEN = 2000;
const BASE_RECONNECT_MS = 2000;
const MAX_RECONNECT_MS = 30000;

function trustedWrapperAddresses(): Set<string> {
  return new Set(
    (process.env.TRUSTED_WRAPPER_ADDRESSES || "")
      .split(",")
      .map((address) => address.trim().toLowerCase())
      .filter((address) => /^0x[a-f0-9]{40}$/.test(address))
  );
}

export class DropListener {
  private chain: ChainId;
  private isRunning = false;
  private unwatch: (() => void) | null = null;
  private seenContracts = new Set<string>();
  private seenOrder: string[] = [];
  private reconnectDelay = BASE_RECONNECT_MS;
  private onDropDetected: DropCallback;
  private consecutiveErrors = 0;
  private maxConsecutiveErrors = 5;

  constructor(chain: ChainId, onDropDetected: DropCallback) {
    this.chain = chain;
    this.onDropDetected = onDropDetected;
  }

  public start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`📡 Free-Mint Auto-Discovery Listener active on ${this.chain}...`);
    this.subscribe();
  }

  private subscribe() {
    const pool = getRPCPool(this.chain);
    const provider = pool.getProvider();
    
    if (!provider) {
      console.error(`[${this.chain}] No healthy providers for block listener, retrying...`);
      this.scheduleReconnect();
      return;
    }

    const client = getPublicClient(this.chain);
    
    this.unwatch = client.watchBlocks({
      includeTransactions: true,
      emitMissed: true,
      pollingInterval: 3000,
      onBlock: async (block) => {
        this.consecutiveErrors = 0;
        await this.handleBlock(block);
      },
      onError: (error: any) => {
        this.consecutiveErrors++;
        console.error(`Block watcher error (${this.chain}):`, error?.message || error);
        this.scheduleReconnect();
      },
    });
  }

  private scheduleReconnect() {
    if (!this.isRunning) return;
    
    if (this.unwatch) {
      try { this.unwatch(); } catch { /* ignore */ }
      this.unwatch = null;
    }

    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_MS);
    
    setTimeout(() => {
      if (!this.isRunning) return;
      try {
        this.subscribe();
        this.reconnectDelay = BASE_RECONNECT_MS;
      } catch (err) {
        this.scheduleReconnect();
      }
    }, delay);
  }

  private rememberContract(addr: string): boolean {
    if (this.seenContracts.has(addr)) return false;
    this.seenContracts.add(addr);
    this.seenOrder.push(addr);
    
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
      if (tx.value !== 0n && tx.value !== undefined && BigInt(tx.value) !== 0n) continue;
      
      const selector = String(tx.input).slice(0, 10).toLowerCase();
      if (!MINT_SELECTORS.has(selector)) continue;

      let contractAddr: string;
      try {
        contractAddr = getAddress(tx.to);
      } catch {
        continue;
      }

      if (this.seenContracts.has(contractAddr)) continue;

      let scan;
      try {
        scan = await scanContract(contractAddr, this.chain);
      } catch {
        continue;
      }
      const isTrustedWrapper = trustedWrapperAddresses().has(contractAddr.toLowerCase());
      const hasValidFreeMint = scan.mintFunctions.some(
        (fn) => fn.isFreeMint && !fn.requiresPayment
      );
      if ((!scan.isVerified && !isTrustedWrapper) || scan.security.riskScore > 20 || !hasValidFreeMint) {
        continue;
      }

      if (!this.rememberContract(contractAddr)) continue;

      // STRIKINGLY STRICT GATE: Perform a quick verification check before notifying!
      try {
        const scanResult = await scanContract(contractAddr, this.chain);
        
        // Skip unverified junk or high risk contracts completely
        if (!scanResult.isVerified || scanResult.security.riskScore > 20) {
          continue;
        }

        // Must have valid free mint functions available
        if (scanResult.mintFunctions.length === 0) {
          continue;
        }

        console.log(`🚀 Confirmed Verified Free-Mint Broadcast: ${contractAddr} (${this.chain})`);
        
        this.onDropDetected({
          contractAddress: contractAddr,
          selector,
          txHash: tx.hash,
          timestamp: Date.now(),
        }).catch((err) => console.error(`Drop handler error (${this.chain}):`, err));
      } catch (scanErr) {
        // Silent drop on scan failure to prevent crash loops
        continue;
      }
    }
  }

  public stop() {
    this.isRunning = false;
    if (this.unwatch) {
      this.unwatch();
      this.unwatch = null;
    }
    console.log(`🛑 Auto-Discovery Listener (${this.chain}) stopped.`);
  }
}

export class BaseDropListener extends DropListener {
  constructor(onDropDetected: DropCallback) {
    super("base", onDropDetected);
  }
}
