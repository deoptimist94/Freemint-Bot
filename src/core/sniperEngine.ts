/**
 * Enhanced Sniper Engine with Mempool-based whale watching
 */

import type { Address } from "viem";
import { getPublicClient } from "./chain.js";
import { prisma } from "../db/client.js";
import { batchMint, type MintOptions } from "./mint.js";
import { withChainContext } from "./chainContext.js";
import type { ChainId } from "./chains.js";
import { getChainsForSelection, getUserChainSelection } from "./userChain.js";
import { getRPCPool } from "./rpcPool.js";

interface WhaleTransaction {
  hash: string;
  to: string;
  from: string;
  input: string;
  value: bigint;
}

const SEADROP_ROUTER = "0x00005ea00ac477b1030ce78506496e8c2de24bf5";
const MINT_PUBLIC_SELECTOR = "0x161ac21f";
const CYCLE_MS = 8000;
const MAX_BLOCKS_PER_CYCLE = 50n;

interface SeaDropContext {
  isViaRouter: boolean;
  routerAddress: string;
  feeRecipient?: string;
  quantity?: number;
}

// FIXED: Added 'id' property to match Prisma model
interface TrackedWallet {
  id: string;
  address: string;
  label?: string | null;
}

const whaleMempoolMonitors: Map<ChainId, any> = new Map();
const cycleStartedAt: Record<ChainId, number> = { base: 0, robinhood: 0 };
const cycleFromBlock: Record<ChainId, bigint | null> = { base: null, robinhood: null };
const cycleToBlock: Record<ChainId, bigint | null> = { base: null, robinhood: null };
const cycleProcessed: Record<ChainId, Set<string>> = { 
  base: new Set(), 
  robinhood: new Set() 
};

export async function addTrackedWallet(telegramId: bigint, address: string, label?: string) {
  return await prisma.trackedWallet.upsert({
    where: { 
      userId_address: { 
        userId: telegramId, 
        address: address.toLowerCase() 
      } 
    },
    update: { label },
    create: { 
      userId: telegramId, 
      address: address.toLowerCase(), 
      label 
    },
  });
}

export async function removeTrackedWallet(telegramId: bigint, address: string) {
  return await prisma.trackedWallet.deleteMany({
    where: { 
      userId: telegramId, 
      address: address.toLowerCase() 
    },
  });
}

export async function getTrackedWallets(telegramId: bigint): Promise<TrackedWallet[]> {
  const wallets = await prisma.trackedWallet.findMany({
    where: { userId: telegramId },
  });
  // Map to ensure id is included
  return wallets.map(w => ({
    id: w.id,
    address: w.address,
    label: w.label
  }));
}

export async function getSniperConfig(telegramId: bigint) {
  let config = await prisma.sniperConfig.findUnique({
    where: { userId: telegramId },
  });
  
  if (!config) {
    config = await prisma.sniperConfig.create({
      data: { 
        userId: telegramId, 
        autoCopy: false, 
        maxSpendEth: 0.0 
      },
    });
  }
  
  return config;
}

export async function setSniperConfig(
  telegramId: bigint, 
  autoCopy: boolean, 
  maxSpendEth: number
) {
  return await prisma.sniperConfig.upsert({
    where: { userId: telegramId },
    update: { autoCopy, maxSpendEth },
    create: { 
      userId: telegramId, 
      autoCopy, 
      maxSpendEth 
    },
  });
}

export async function startWhaleMempoolMonitoring(
  chain: ChainId,
  onWhaleMint: (tx: WhaleTransaction, whale: TrackedWallet) => Promise<void>
): Promise<void> {
  if (whaleMempoolMonitors.has(chain)) return;

  const monitor = setInterval(async () => {
    try {
      const { getPublicClient } = await import("./chain.js");
      const client = getPublicClient(chain);
      
      const block = await client.getBlock({
        blockTag: "pending",
        includeTransactions: true,
      });

      if (!block.transactions) return;

      for (const tx of block.transactions as any[]) {
        if (!tx.to || !tx.input || tx.input === "0x") continue;
        
        const tracked = await isTrackedWallet(tx.from);
        if (!tracked) continue;

        const selector = tx.input.slice(0, 10).toLowerCase();
        const isMint = [
          "0x1249c58b", "0xa0712d68", "0x6a627842",
          "0x40c10f19", "0x4e6ec247", "0x161ac21f"
        ].includes(selector);

        if (isMint) {
          await onWhaleMint(tx as WhaleTransaction, tracked);
        }
      }
    } catch (err) {
      // Silent fail - will retry
    }
  }, 2000);

  whaleMempoolMonitors.set(chain, monitor);
  console.log(`Whale mempool monitoring started on ${chain}`);
}

export async function stopWhaleMempoolMonitoring(chain: ChainId): Promise<void> {
  const monitor = whaleMempoolMonitors.get(chain);
  if (monitor) {
    clearInterval(monitor);
    whaleMempoolMonitors.delete(chain);
  }
}

async function isTrackedWallet(address: string): Promise<TrackedWallet | null> {
  const wallet = await prisma.trackedWallet.findFirst({
    where: { address: address.toLowerCase() },
  });
  if (!wallet) return null;
  return {
    id: wallet.id,
    address: wallet.address,
    label: wallet.label
  };
}

async function getBlockCached(chain: ChainId, blockNumber: bigint): Promise<any | null> {
  try {
    const block = await getPublicClient(chain).getBlock({
      blockNumber,
      includeTransactions: true,
    });
    return block;
  } catch (err) {
    console.error(`getBlock(${chain}, ${blockNumber}) failed:`, err);
    return null;
  }
}

function decodeSeaDropMintPublic(input: string): { 
  nftContract: Address; 
  feeRecipient: Address; 
  minterIfNotPayer: Address; 
  quantity: bigint 
} | null {
  if (!input || input.length < 266) return null;
  
  try {
    const nftContract = `0x${input.slice(10, 74).slice(24)}`.toLowerCase() as Address;
    const feeRecipient = `0x${input.slice(74, 138).slice(24)}`.toLowerCase() as Address;
    const minterIfNotPayer = `0x${input.slice(138, 202).slice(24)}`.toLowerCase() as Address;
    const quantityHex = input.slice(202, 266);
    const quantity = BigInt(`0x${quantityHex}`);
    
    if (!/^0x[0-9a-f]{40}$/.test(nftContract)) return null;
    
    return { nftContract, feeRecipient, minterIfNotPayer, quantity };
  } catch {
    return null;
  }
}

function resolveMintTarget(
  txTo: string, 
  input: string
): { target: Address; seaDropContext?: SeaDropContext } {
  const to = txTo.toLowerCase();
  const selector = input.slice(0, 10).toLowerCase();
  
  if (to === SEADROP_ROUTER || selector === MINT_PUBLIC_SELECTOR) {
    const decoded = decodeSeaDropMintPublic(input);
    if (decoded) {
      return {
        target: decoded.nftContract,
        seaDropContext: {
          isViaRouter: true,
          routerAddress: SEADROP_ROUTER,
          feeRecipient: decoded.feeRecipient,
          quantity: Number(decoded.quantity),
        },
      };
    }
  }
  
  return { target: to as Address };
}

async function pollChain(
  chain: ChainId,
  telegramId: bigint,
  trackedWallets: TrackedWallet[],
  config: any,
  notifyCallback: (msg: string) => void
): Promise<void> {
  const now = Date.now();
  
  if (now - cycleStartedAt[chain] < CYCLE_MS && cycleFromBlock[chain]) {
    return;
  }

  try {
    const client = getPublicClient(chain);
    const latest = await client.getBlockNumber();
    
    const fromBlock = cycleToBlock[chain] 
      ? cycleToBlock[chain]! + 1n 
      : latest - 5n;
    const toBlock = latest;
    
    if (fromBlock > toBlock) return;
    if (toBlock - fromBlock > MAX_BLOCKS_PER_CYCLE) {
      console.warn(`Block range too large, capping`);
    }

    cycleStartedAt[chain] = now;
    cycleFromBlock[chain] = fromBlock;
    cycleToBlock[chain] = toBlock;

    const trackedAddresses = new Set(
      trackedWallets.map(w => w.address.toLowerCase())
    );

    for (let b = fromBlock; b <= toBlock; b++) {
      const block = await getBlockCached(chain, b);
      if (!block?.transactions) continue;

      for (const tx of block.transactions as any[]) {
        if (!tx.to || !tx.input) continue;
        
        const from = tx.from?.toLowerCase();
        if (!trackedAddresses.has(from)) continue;

        const matchedWallet = trackedWallets.find(
          w => w.address.toLowerCase() === from
        )!;
        
        const { target: mintTarget, seaDropContext } = resolveMintTarget(
          tx.to, 
          tx.input
        );
        
        const valueEth = tx.value 
          ? (Number(tx.value) / 1e18).toFixed(4) 
          : "0";
        
        const chainConfig = await import("./chains.js").then(m => m.getChainConfig(chain));
        const badge = chainConfig.badge;
        const name = chainConfig.name;

        const viaRouter = !!seaDropContext?.isViaRouter;
        
        notifyCallback(
          `Whale Mint Detected (${matchedWallet.label || "Tracked"}) - ${badge} ${name}\n\n` +
          (viaRouter
            ? `Target: ${mintTarget} (via SeaDrop)\n`
            : `Target: ${mintTarget}\n`) +
          `Value: ${valueEth} ETH\n` +
          `Tx: ${tx.hash}\n\n` +
          `Attempting copy-mint...`
        );

        const mintOptions: MintOptions = {
          contractAddress: mintTarget,
          seaDropContext: viaRouter ? seaDropContext : undefined,
        };

        const result = await withChainContext(chain, () =>
          batchMint(telegramId, mintTarget, mintOptions)
        );

        if (result.results.length === 0) {
          notifyCallback(
            `Copy-Mint Skipped\n` +
            `Contract: ${mintTarget}\n` +
            `Reason: ${result.abortReason || "No result"}`
          );
        } else {
          let msg = 
            `Copy-Mint Result\n\n` +
            `Contract: ${mintTarget}\n` +
            `Success: ${result.totalSuccess} Failed: ${result.totalFailed}\n\n`;
          
          for (const r of result.results) {
            const icon = r.success ? "SUCCESS" : "FAILED";
            const shortAddr = `${r.walletAddress.slice(0, 6)}..${r.walletAddress.slice(-4)}`;
            msg += `${icon} ${r.label}: ${shortAddr}`;
            if (r.basescanUrl) msg += ` - TX: ${r.basescanUrl}`;
            if (r.error) msg += ` - ${r.error}`;
            msg += "\n";
          }
          
          notifyCallback(msg);
        }
      }
    }
  } catch (err) {
    console.error(`Error in sniper polling for ${telegramId} on ${chain}:`, err);
  }
}

export async function pollTrackedWalletsForUser(
  telegramId: bigint,
  notifyCallback: (msg: string) => void
): Promise<void> {
  const config = await getSniperConfig(telegramId);
  if (!config.autoCopy) return;

  const tracked = await getTrackedWallets(telegramId);
  if (tracked.length === 0) return;

  const selection = await getUserChainSelection(telegramId);
  const chains = getChainsForSelection(selection);

  for (const chain of chains) {
    await pollChain(chain, telegramId, tracked, config, notifyCallback);
  }
}
