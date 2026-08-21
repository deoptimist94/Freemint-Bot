import { type Address } from "viem";
import { getPublicClient } from "./chain.js";
import { prisma } from "../db/client.js";
import { batchMint } from "./mint.js";

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

// ==== Shared scanning state (replaces per-user cursors) ====
// All users share one time-windowed cursor + one block cache, so the public RPC
// is hit once per block instead of once per user per block.
const CYCLE_MS = 12_000;          // matches the poller interval in main.ts
const MAX_BLOCKS_PER_CYCLE = 50n; // Base mines ~6 blocks per 12s; 50 is a huge safety margin

let cycleStartedAt = 0;
let cycleFromBlock: bigint | null = null;
let cycleToBlock: bigint | null = null;
let cycleProcessed = new Set<string>(); // `${telegramId}:${txHash}`

const blockCache = new Map<string, any>();
let blockCacheSince = 0;

async function getBlockCached(blockNumber: bigint): Promise<any | null> {
  const now = Date.now();
  if (now - blockCacheSince > CYCLE_MS) {
    blockCache.clear();
    blockCacheSince = now;
  }
  const key = blockNumber.toString();
  if (blockCache.has(key)) return blockCache.get(key);
  try {
    const block = await getPublicClient().getBlock({
      blockNumber,
      includeTransactions: true,
    });
    blockCache.set(key, block);
    return block;
  } catch (err) {
    console.error(`getBlock(${key}) failed:`, err);
    return null;
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

  const publicClient = getPublicClient();

  try {
    const head = await publicClient.getBlockNumber();
    const now = Date.now();

    // New 12s window → advance the shared cursor and reset per-cycle dedupe.
    if (now - cycleStartedAt > CYCLE_MS) {
      cycleStartedAt = now;
      cycleFromBlock =
        cycleFromBlock === null ? head - 1n : cycleToBlock === null ? head - 1n : cycleToBlock + 1n;
      cycleToBlock = head;
      cycleProcessed = new Set();
    }

    if (cycleFromBlock === null || cycleToBlock === null) return;

    // Bound the scan to the most recent blocks if we ever fall behind.
    let from = cycleFromBlock;
    if (cycleToBlock - from + 1n > MAX_BLOCKS_PER_CYCLE) {
      from = cycleToBlock - MAX_BLOCKS_PER_CYCLE + 1n;
    }

    for (let bNum = from; bNum <= cycleToBlock; bNum++) {
      const block = await getBlockCached(bNum);
      if (!block?.transactions) continue;

      for (const tx of block.transactions) {
        if (typeof tx !== "object" || !tx.from) continue;

        const sender = tx.from.toLowerCase();
        const matchedWallet = tracked.find((tw) => tw.address.toLowerCase() === sender);
        if (!matchedWallet) continue;

        if (!tx.to || !tx.input || tx.input === "0x" || tx.input.length <= 10) continue;

        // One copy-mint per whale-tx per user (dedupe across shared cycles).
        const dedupeKey = `${telegramId.toString()}:${tx.hash}`;
        if (cycleProcessed.has(dedupeKey)) continue;
        cycleProcessed.add(dedupeKey);

        const valueEth = Number(tx.value || 0n) / 1e18;

        if (valueEth <= config.maxSpendEth) {
          notifyCallback(
            `🎯 **WHALE COPY-MINT ALERT (${matchedWallet.label || "Tracked"})!**\n` +
              `Target Contract: \`${tx.to}\`\n` +
              `Value: \`${valueEth} ETH\`\n` +
              `TxHash: \`${tx.hash}\`\n\n` +
              `🚀 Attempting copy-mint across your sub-wallets… ` +
              `(contract is re-vetted by the security gate before any transaction is sent)`
          );

          // batchMint re-runs scanContract internally, which now FAILS CLOSED:
          // if the GoPlus check or NFT check fails, zero transactions are sent.
          await batchMint(telegramId, tx.to);
        } else {
          notifyCallback(
            `⏭️ **Skipped Copy-Mint (${matchedWallet.label || "Tracked"})**\n` +
              `Cost: ~${valueEth} ETH exceeds your Max Spend setting (${config.maxSpendEth} ETH).\n` +
              `TxHash: \`${tx.hash}\``
          );
        }
      }
    }
  } catch (err) {
    console.error(`Error in sniper polling for user ${telegramId}:`, err);
  }
}
