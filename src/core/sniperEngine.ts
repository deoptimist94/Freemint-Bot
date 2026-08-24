import { type Address, type Hex } from "viem";
import { getPublicClient } from "./chain.js";
import { prisma } from "../db/client.js";
import { batchMint } from "./mint.js";
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
// All users share one time-windowed cursor + one block cache PER CHAIN, so each
// public RPC is hit once per block instead of once per user per block.
// Whale EVM addresses are identical on Base and Robinhood (same address space),
// so TrackedWallet rows need NO chain column — only polling + copy-mint do.
const CYCLE_MS = 12_000;          // matches the poller interval in main.ts
const MAX_BLOCKS_PER_CYCLE = 50n; // both chains mine well under 50 blocks per 12s

const cycleStartedAt: Record<ChainId, number> = { base: 0, robinhood: 0 };
const cycleFromBlock: Record<ChainId, bigint | null> = { base: null, robinhood: null };
const cycleToBlock: Record<ChainId, bigint | null> = { base: null, robinhood: null };
const cycleProcessed: Record<ChainId, Set<string>> = { base: new Set(), robinhood: new Set() };

const blockCache = new Map<string, any>(); // key: `${chain}:${blockNumber}`
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
// OpenSea SeaDrop: mintPublic(address nftContract, address feeRecipient,
// address minterIfNotPayer, uint256 quantity) payable — selector 0x161ac21f.
// The whale's tx goes to the ROUTER, not the NFT, so tx.to alone makes
// batchMint re-vet a non-NFT proxy and fail closed (empty result, no message).
const SEADROP_ROUTER = "0x00005ea00ac477b1030ce78506496e8c2de24bf5";
const MINT_PUBLIC_SELECTOR = "0x161ac21f";

function decodeSeaDropNft(input: string): Address | null {
  // Every SeaDrop mint variant (mintPublic / mintAllowList / mintSigned /
  // mintAllowedTokenHolder) encodes the NFT contract as the FIRST 32-byte word
  // after the selector (address is right-padded inside that word).
  if (!input || input.length < 74) return null;
  const candidate = `0x${input.slice(10, 74).slice(24)}`.toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(candidate) ? (candidate as Address) : null;
}

// Resolve the REAL NFT contract for a whale mint tx. Returns tx.to unchanged
// for ordinary direct mints.
function resolveMintTarget(txTo: string, input: string): Address {
  const to = txTo.toLowerCase();
  const selector = input.slice(0, 10).toLowerCase();
  if (to === SEADROP_ROUTER || selector === MINT_PUBLIC_SELECTOR) {
    const nft = decodeSeaDropNft(input);
    if (nft) return nft;
  }
  return to as Address;
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

    // New 12s window → advance this chain's cursor and reset its dedupe set.
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

    // Bound the scan to the most recent blocks if we ever fall behind.
    let from = fromBlock;
    if (toBlock - from + 1n > MAX_BLOCKS_PER_CYCLE) {
      from = toBlock - MAX_BLOCKS_PER_CYCLE + 1n;
    }

    for (let bNum = from; bNum <= toBlock; bNum++) {
      const block = await getBlockCached(chain, bNum);
      if (!block?.transactions) continue;

      for (const tx of block.transactions) {
        if (typeof tx !== "object" || !tx.from) continue;

        const sender = tx.from.toLowerCase();
        const matchedWallet = tracked.find((tw) => tw.address.toLowerCase() === sender);
        if (!matchedWallet) continue;

        if (!tx.to || !tx.input || tx.input === "0x" || tx.input.length <= 10) continue;

        // One copy-mint per whale-tx per user per chain (dedupe across shared cycles).
        const dedupeKey = `${chain}:${telegramId.toString()}:${tx.hash}`;
        if (cycleProcessed[chain].has(dedupeKey)) continue;
        cycleProcessed[chain].add(dedupeKey);

        const valueEth = Number(tx.value || 0n) / 1e18;
        const mintTarget = resolveMintTarget(tx.to, tx.input);
        const viaRouter = mintTarget.toLowerCase() !== tx.to.toLowerCase();

        if (valueEth <= config.maxSpendEth) {
          notifyCallback(
            `🎯 **WHALE COPY-MINT ALERT (${matchedWallet.label || "Tracked"}) — ${badge} ${name}!**\n` +
              (viaRouter
                ? `Mint Target (decoded from SeaDrop router): \`${mintTarget}\`\n`
                : `Target Contract: \`${mintTarget}\`\n`) +
              `Value: \`${valueEth} ETH\`\n` +
              `TxHash: \`${tx.hash}\`\n\n` +
              `🚀 Attempting copy-mint across your sub-wallets… ` +
              `(contract is re-vetted by the security gate before any transaction is sent)`
          );

          // batchMint re-runs scanContract internally, which now FAILS CLOSED:
          // if the GoPlus check or NFT check fails, zero transactions are sent.
          // mintTarget is the REAL NFT (decoded out of the SeaDrop calldata), so
          // copy-mints now hit the collection instead of the proxy router.
          const result = await withChainContext(chain, () =>
            batchMint(telegramId, mintTarget)
          );

          // Always report the outcome — success, partial, or abort. Previously the
          // result was dropped on the floor, so a fail-closed (0 results) copy-mint
          // produced an alert followed by total silence.
          if (result.results.length === 0) {
            notifyCallback(
              `⏭️ **Copy-Mint Skipped (${matchedWallet.label || "Tracked"}) — ${badge} ${name}**\n` +
                `Contract: \`${mintTarget}\`\n` +
                `Reason: ${result.abortReason ?? "no result returned"}\n` +
                `TxHash: \`${tx.hash}\``
            );
          } else {
            let msg =
              `✅ **Copy-Mint Result (${matchedWallet.label || "Tracked"}) — ${badge} ${name}**\n\n` +
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
        } else {
          notifyCallback(
            `⏭️ **Skipped Copy-Mint (${matchedWallet.label || "Tracked"}) — ${badge} ${name}**\n` +
              `Cost: ~${valueEth} ETH exceeds your Max Spend setting (${config.maxSpendEth} ETH).\n` +
              `TxHash: \`${tx.hash}\``
          );
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

  // Poll every chain the user's /chain selection covers (base, robinhood, or both).
  // Failures on one chain are caught inside pollChain and never block the others.
  const selection = await getUserChainSelection(telegramId);
  const chains = getChainsForSelection(selection);

  for (const chain of chains) {
    await pollChain(chain, telegramId, tracked, config, notifyCallback);
  }
}
