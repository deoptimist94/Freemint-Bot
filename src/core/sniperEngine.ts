import type { Address, Hex } from "viem";
import { getPublicClient } from "./chain.js";
import { prisma } from "../db/client.js";
import { batchMint, type MintOptions } from "./mint.js";
import { withChainContext } from "./chainContext.js";
import { type ChainId, getChainConfig } from "./chains.js";
import { getChainsForSelection, getUserChainSelection } from "./userChain.js";

export async function addTrackedWallet(telegramId: bigint, address: string, label?: string) {
  return await prisma.trackedWallet.upsert({
    where: { userId_address: { userId: telegramId, address: address.toLowerCase() } },
    update: { label },
    create: { userId: telegramId, address: address.toLowerCase(), label },
  });
}

export async function removeTrackedWallet(telegramId: bigint, address: string) {
  return await prisma.trackedWallet.deleteMany({
    where: { userId: telegramId, address: address.toLowerCase() },
  });
}

export async function getTrackedWallets(telegramId: bigint) {
  return await prisma.trackedWallet.findMany({
    where: { userId: telegramId },
  });
}

export async function getSniperConfig(telegramId: bigint) {
  let config = await prisma.sniperConfig.findUnique({
    where: { userId: telegramId },
  });
  if (!config) {
    config = await prisma.sniperConfig.create({
      data: { userId: telegramId, autoCopy: false, maxSpendEth: 0.0 },
    });
  }
  return config;
}

export async function setSniperConfig(telegramId: bigint, autoCopy: boolean, maxSpendEth: number) {
  return await prisma.sniperConfig.upsert({
    where: { userId: telegramId },
    update: { autoCopy, maxSpendEth },
    create: { userId: telegramId, autoCopy, maxSpendEth },
  });
}

// ==== Shared scanning state (per-chain cursors) ====
const CYCLE_MS = 12_000;
const MAX_BLOCKS_PER_CYCLE = 50n;

const cycleStartedAt: Record<ChainId, number> = { base: 0, robinhood: 0 };
const cycleFromBlock: Record<ChainId, bigint | null> = { base: null, robinhood: null };
const cycleToBlock: Record<ChainId, bigint | null> = { base: null, robinhood: null };
const cycleProcessed: Record<ChainId, Set<string>> = { base: new Set(), robinhood: new Set() };
const blockCache = new Map<string, any>();
let blockCacheSince = 0;

async function getBlockCached(chain: ChainId, blockNumber: bigint): Promise<any | null> {
  const now = Date.now();
  if (now - blockCacheSince > CYCLE_MS) {
    blockCache.clear();
    blockCacheSince = now;
  }
  const key = `${chain}:${blockNumber.toString()}`;
  if (blockCache.has(key)) return blockCache.get(key);
  try {
    const block = await getPublicClient(chain).getBlock({
      blockNumber,
      includeTransactions: true,
    });
    blockCache.set(key, block);
    return block;
  } catch (err) {
    console.error(`getBlock(${chain}, ${blockNumber}) failed:`, err);
    return null;
  }
}

// ==== SeaDrop router decoding ====
const SEADROP_ROUTER = "0x00005ea00ac477b1030ce78506496e8c2de24bf5";
const MINT_PUBLIC_SELECTOR = "0x161ac21f";

interface SeaDropContext {
  isViaRouter: boolean;
  routerAddress: string;
  feeRecipient?: string;
  quantity?: number;
}

function decodeSeaDropNft(input: string): Address | null {
  if (!input || input.length < 74) return null;
  const candidate = `0x${input.slice(10, 74).slice(24)}`.toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(candidate) ? (candidate as Address) : null;
}

function decodeSeaDropMintPublic(input: string): { nftContract: Address; feeRecipient: Address; minterIfNotPayer: Address; quantity: bigint } | null {
  if (!input || input.length < 266) return null; // 4 + 4*64 = 260 chars minimum
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

// Resolve the REAL NFT contract for a whale mint tx. Returns tx.to unchanged
// for ordinary direct mints, plus SeaDrop context when applicable.
function resolveMintTarget(txTo: string, input: string): { target: Address; seaDropContext?: SeaDropContext } {
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
    // Fallback to simple NFT extraction
    const nft = decodeSeaDropNft(input);
    if (nft) {
      return {
        target: nft,
        seaDropContext: {
          isViaRouter: true,
          routerAddress: SEADROP_ROUTER,
        },
      };
    }
  }
  
  return { target: to as Address };
}

async function pollChain(
  chain: ChainId,
  telegramId: bigint,
  tracked: Array<{ address: string; label: string | null }>,
  config: { maxSpendEth: number },
  notifyCallback: (msg: string) => void
) {
  const { badge, name } = getChainConfig(chain);
  const publicClient = getPublicClient(chain);
  
  try {
    const head = await publicClient.getBlockNumber();
    const now = Date.now();
    
    if (now - cycleStartedAt[chain] > CYCLE_MS) {
      cycleStartedAt[chain] = now;
      cycleFromBlock[chain] =
        cycleFromBlock[chain] === null
          ? head - 1n
          : cycleToBlock[chain] === null
          ? head - 1n
          : cycleToBlock[chain] + 1n;
      cycleToBlock[chain] = head;
      cycleProcessed[chain] = new Set();
    }
    
    const fromBlock = cycleFromBlock[chain];
    const toBlock = cycleToBlock[chain];
    if (fromBlock === null || toBlock === null) return;
    
    let from = fromBlock;
    if (toBlock - from + 1n > MAX_BLOCKS_PER_CYCLE) {
      from = toBlock - MAX_BLOCKS_PER_CYCLE + 1n;
    }
    
    const trackedAddrs = tracked.map((t) => t.address.toLowerCase());
    const trackedMap = new Map(tracked.map((t) => [t.address.toLowerCase(), t]));
    
    for (let b = from; b <= toBlock; b++) {
      const block = await getBlockCached(chain, b);
      if (!block || !block.transactions) continue;
      
      for (const tx of block.transactions) {
        if (!tx?.to || !tx?.input || tx.input === "0x") continue;
        
        const { target: mintTarget, seaDropContext } = resolveMintTarget(tx.to, tx.input);
        const mintTargetLower = mintTarget.toLowerCase();
        
        // Skip if we've already processed this tx
        const txKey = `${chain}:${tx.hash}`;
        if (cycleProcessed[chain].has(txKey)) continue;
        cycleProcessed[chain].add(txKey);
        
        // Check if this is from a tracked wallet
        const fromLower = (tx.from || "").toLowerCase();
        const matchedWallet = trackedMap.get(fromLower);
        if (!matchedWallet) continue;
        
        // Value check
        const valueEth = Number(tx.value || 0n) / 1e18;
        if (valueEth > config.maxSpendEth) {
          notifyCallback(
            `⏭️ **Skipped Copy-Mint (${matchedWallet.label || "Tracked"}) — ${badge}${name}**\n` +
            `Cost: ~${valueEth} ETH exceeds your Max Spend setting (${config.maxSpendEth} ETH).\n` +
            `TxHash: \`${tx.hash}\``
          );
          continue;
        }
        
        const viaRouter = !!seaDropContext?.isViaRouter;
        
        notifyCallback(
          `🎯 **Whale Mint Detected (${matchedWallet.label || "Tracked"}) — ${badge}${name}**\n\n` +
          (viaRouter
            ? `Mint Target (decoded from SeaDrop router): \`${mintTarget}\`\n`
            : `Target Contract: \`${mintTarget}\`\n`) +
          `Value: \`${valueEth} ETH\`\n` +
          `TxHash: \`${tx.hash}\`\n\n` +
          `🚀 Attempting copy-mint across your sub-wallets… ` +
          `(contract is re-vetted by the security gate before any transaction is sent)`
        );
        
        // Build mint options with SeaDrop context
        const mintOptions: MintOptions = {
          contractAddress: mintTarget,
          seaDropContext: viaRouter ? seaDropContext : undefined,
        };
        
        const result = await withChainContext(chain, () =>
          batchMint(telegramId, mintTarget, mintOptions)
        );
        
        if (result.results.length === 0) {
          notifyCallback(
            `⏭️ **Copy-Mint Skipped (${matchedWallet.label || "Tracked"}) — ${badge}${name}**\n` +
            `Contract: \`${mintTarget}\`\n` +
            `Reason: ${result.abortReason || "no result returned"}\n` +
            `TxHash: \`${tx.hash}\``
          );
        } else {
          let msg =
            `✅ **Copy-Mint Result (${matchedWallet.label || "Tracked"}) — ${badge}${name}**\n\n` +
            `Contract: \`${mintTarget}\`\n` +
            `✅ Success: ${result.totalSuccess} · ❌ Failed: ${result.totalFailed}\n\n`;
          
          for (const r of result.results) {
            const icon = r.success ? "✅" : "❌";
            msg += `${icon} ${r.label}: \`${r.walletAddress.slice(0, 6)}..${r.walletAddress.slice(-4)}\``;
            if (r.basescanUrl) msg += ` — [TX](${r.basescanUrl})`;
            if (r.error) msg += ` — ${r.error}`;
            msg += `\n`;
          }
          notifyCallback(msg);
        }
      }
    }
  } catch (err) {
    console.error(`Error in sniper polling for user ${telegramId} on ${chain}:`, err);
  }
}

export async function pollTrackedWalletsForUser(
  telegramId: bigint,
  notifyCallback: (msg: string) => void
) {
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
