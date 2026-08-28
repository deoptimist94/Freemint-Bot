/**
 * Freemint Bot - Professional Edition
 * Fixed TypeScript errors + runtime dedup cache + bot.start()
 */

import "dotenv/config";
import { Bot } from "grammy";
import { createBot } from "./bot/index.js";
import { startHealthServer } from "./server/health.js";
import { startAutoMintLoop } from "./core/autoMint.js";
import { prisma } from "./db/client.js";
import { DropListener } from "./core/listener.js";
import {
  scanContract,
  getBestMintFunction,
} from "./core/scanner.js";
import { evaluateSpamContract } from "./core/spamFilter.js";
import { startFloorWatcher } from "./core/floorWatcher.js";
import { pollTrackedWalletsForUser } from "./core/sniperEngine.js";
import { batchMint } from "./core/mint.js";
import type { ChainId } from "./core/chains.js";
import { getChainsForSelection, getUserChainSelection } from "./core/userChain.js";
import { MempoolMonitor, type MempoolMint } from "./core/mempoolSniper.js";
import { getRPCPool, getRPCStats } from "./core/rpcPool.js";
import { mintQueue, discoveryQueue, closeQueues } from "./core/queue.js";
import { loadSubscribers } from "./core/broadcaster.js";
import { discoveryMintKeyboard } from "./bot/keyboards.js";

const monitors: Map<ChainId, MempoolMonitor> = new Map();
let bot: Bot;

// --- Skip cache: avoid re-scanning known non-mintable addresses ---
const skipCache = new Map<string, number>();
const SKIP_CACHE_TTL_MS = 30 * 60 * 1000;

function isSkipped(chain: ChainId, address: string): boolean {
  const key = `${chain}:${address.toLowerCase()}`;
  const until = skipCache.get(key);
  if (!until) return false;
  if (Date.now() < until) return true;
  skipCache.delete(key);
  return false;
}

function markSkipped(chain: ChainId, address: string): void {
  const key = `${chain}:${address.toLowerCase()}`;
  skipCache.set(key, Date.now() + SKIP_CACHE_TTL_MS);
  if (skipCache.size > 10_000) {
    const firstKey = skipCache.keys().next().value;
    if (firstKey) skipCache.delete(firstKey);
  }
}

function isTrustedWrapper(address: string): boolean {
  return (process.env.TRUSTED_WRAPPER_ADDRESSES || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .includes(address.toLowerCase());
}

async function main() {
  console.log("Starting Freemint Bot Professional Edition");

  const required = ["BOT_TOKEN", "ENCRYPTION_KEY", "DATABASE_URL"];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }

  const hasBaseAlchemy = !!process.env.ALCHEMY_BASE_API_KEY;
  const hasRobinhoodAlchemy = !!process.env.ALCHEMY_ROBINHOOD_API_KEY;

  console.log("RPC Providers:");
  console.log(`  Base: ${hasBaseAlchemy ? "Alchemy OK" : "MISSING"}`);
  console.log(`  Robinhood: ${hasRobinhoodAlchemy ? "Alchemy OK" : "MISSING"}`);

  if (!hasBaseAlchemy) {
    console.error("ALCHEMY_BASE_API_KEY is required!");
    process.exit(1);
  }

  try {
    await prisma.$connect();
    console.log("Database connected");
    await loadSubscribers();
    console.log("Subscribers loaded");
  } catch (error) {
    console.error("Database connection failed:", error);
    process.exit(1);
  }

  console.log("Initializing RPC pools");
  getRPCPool("base");
  if (hasRobinhoodAlchemy) getRPCPool("robinhood");

  // Register queue handlers
  mintQueue.process(async (job) => {
    const { userId, contractAddress, options } = job.data;
    if (!userId) {
      console.error(`Job ${job.id} missing userId`);
      throw new Error("Missing userId in job data");
    }
    console.log(`Processing mint job ${job.id} for user ${userId}`);
    try {
      const result = await batchMint(BigInt(userId), contractAddress, options);
      return result;
    } catch (error) {
      console.error(`Mint job ${job.id} failed:`, error);
      throw error;
    }
  });

  discoveryQueue.process(async (job) => {
    const { contractAddress, chain, detectedAt: rawDetectedAt, txHash } = job.data;
    const detectedAt = rawDetectedAt ?? Date.now();
    try {
      await processDiscovery(contractAddress, chain as ChainId, detectedAt, txHash);
    } catch (error) {
      console.error(`Discovery processing failed for ${contractAddress}:`, error);
      throw error;
    }
  });

  bot = createBot();
  startHealthServer(bot);
  startAutoMintLoop(bot);
  startFloorWatcher(bot, 300);

  console.log("Starting mempool monitors");
  const baseMempool = new MempoolMonitor("base", handleMempoolMint("base"));
  baseMempool.start();
  monitors.set("base", baseMempool);

  let robinhoodMempool: MempoolMonitor | null = null;
  if (hasRobinhoodAlchemy) {
    robinhoodMempool = new MempoolMonitor("robinhood", handleMempoolMint("robinhood"));
    robinhoodMempool.start();
    monitors.set("robinhood", robinhoodMempool);
  }

  const dropListener = new DropListener("base", handleDrop("base"));
  dropListener.start();

  let robinhoodListener: DropListener | null = null;
  if (hasRobinhoodAlchemy) {
    robinhoodListener = new DropListener("robinhood", handleDrop("robinhood"));
    robinhoodListener.start();
  }

  // Copy-trade scheduler
  setInterval(async () => {
    try {
      const configs = await prisma.sniperConfig.findMany({
        where: { autoCopy: true },
      });
      for (const cfg of configs) {
        await queueTrackedWalletPoll(cfg.userId);
      }
    } catch (err) {
      console.error("Error in copy-trade scheduler:", err);
    }
  }, 15000);

  // RPC stats logging
  setInterval(() => {
    console.log("RPC Pool Stats:");
    console.log("  Base:", getRPCStats("base"));
    if (hasRobinhoodAlchemy) {
      console.log("  Robinhood:", getRPCStats("robinhood"));
    }
  }, 300000);

  // Graceful shutdown
  const handleShutdown = async (signal: string) => {
    console.log(`\nShutting down (${signal})`);

    monitors.forEach(m => m.stop());
    dropListener.stop();
    robinhoodListener?.stop();

    await closeQueues();
    await bot.stop();
    await prisma.$disconnect();

    console.log("Goodbye");
    process.exit(0);
  };

  process.on("SIGINT", () => handleShutdown("SIGINT"));
  process.on("SIGTERM", () => handleShutdown("SIGTERM"));

  console.log("Bot initialization complete");

  // ★★★ THIS IS THE MISSING LINE ★★★
  // Start long-polling so the bot actually receives /start, /whois, etc.
  bot.start();
  console.log("Bot polling started — awaiting commands");
}

// Mempool mint handler
function handleMempoolMint(chain: ChainId) {
  return async (mint: MempoolMint) => {
    console.log(`Mempool mint detected on ${chain}:`, mint.contractAddress);
    await discoveryQueue.add({
      contractAddress: mint.contractAddress,
      chain,
      detectedAt: mint.detectedAt,
      txHash: mint.txHash,
    }, {
      priority: 1,
      delay: 100,
    });
  };
}

// Drop handler
function handleDrop(chain: ChainId) {
  return async (drop: { contractAddress: string; selector: string; txHash: string; timestamp: number }) => {
    console.log(`Block drop detected on ${chain}:`, drop.contractAddress);
    await discoveryQueue.add({
      contractAddress: drop.contractAddress,
      chain,
      detectedAt: drop.timestamp,
      txHash: drop.txHash,
    }, {
      priority: 1,
      delay: 100,
    });
  };
}

// Queue tracked wallet poll
async function queueTrackedWalletPoll(userId: bigint): Promise<void> {
  try {
    const notifyCallback: (msg: string) => Promise<void> = async (msg: string) => {
      try {
        await bot.api.sendMessage(Number(userId), msg, { parse_mode: "Markdown" });
      } catch (e) {
        console.error(`Failed to notify user ${userId}:`, e);
      }
    };

    await pollTrackedWalletsForUser(userId, notifyCallback);
  } catch (err) {
    console.error(`Error polling tracked wallets for ${userId}:`, err);
  }
}

// Process discovery — with skip cache
async function processDiscovery(
  contractAddress: string,
  chain: ChainId,
  detectedAt: number,
  txHash?: string
): Promise<void> {
  if (isSkipped(chain, contractAddress)) {
    return;
  }

  console.log(`Processing discovery: ${contractAddress} on ${chain}`);

  const scan = await scanContract(contractAddress, chain);
  const trustedWrapper = isTrustedWrapper(scan.contractAddress);
  const hasValidFreeMint = scan.mintFunctions.some(
    (fn) => fn.isFreeMint && !fn.requiresPayment
  );
  if ((!scan.isVerified && !trustedWrapper) || scan.security.riskScore > 20 || !hasValidFreeMint) {
    markSkipped(chain, contractAddress);
    return;
  }

  if (!scan.isNft || scan.mintFunctions.length === 0) {
    console.log(`No mint functions found for: ${contractAddress} — caching skip`);
    markSkipped(chain, contractAddress);
    return;
  }

  const spamCheck = await evaluateSpamContract(scan, chain);
  if (spamCheck.isSpam) {
    console.log(`Skipping spam contract: ${contractAddress} — ${spamCheck.reason}`);
    markSkipped(chain, contractAddress);
    return;
  }

  const bestMint = getBestMintFunction(scan.mintFunctions);
  if (!bestMint || !bestMint.isFreeMint) {
    console.log(`Not a free mint: ${contractAddress} — caching skip`);
    markSkipped(chain, contractAddress);
    return;
  }

  console.log(`Free mint confirmed: ${contractAddress}`);

  const activeUsers = await prisma.user.findMany({
    where: { wallets: { some: {} } },
    include: { wallets: true },
  });

  console.log(`Broadcasting to ${activeUsers.length} users`);

  const CHUNK_SIZE = 50;
  const chunks: typeof activeUsers[] = [];

  for (let i = 0; i < activeUsers.length; i += CHUNK_SIZE) {
    chunks.push(activeUsers.slice(i, i + CHUNK_SIZE));
  }

  for (const chunk of chunks) {
    await Promise.allSettled(
      chunk.map(user => processUser(user, scan, chain, detectedAt, txHash))
    );
  }
}

// Process individual user
async function processUser(
  user: any,
  scan: any,
  chain: ChainId,
  detectedAt: number,
  txHash?: string
): Promise<void> {
  try {
    if (!user.wallets?.length) return;

    const selection = await getUserChainSelection(BigInt(user.telegramId));
    if (!getChainsForSelection(selection).includes(chain)) return;

    if (user.autoMintEnabled) {
      const priorityValue = scan.security?.riskScore < 20 ? 1 : 2;

      await mintQueue.add({
        userId: user.telegramId.toString(),
        contractAddress: scan.contractAddress,
        chain,
        options: {
          detectedAt,
          txHash,
          securityScore: scan.security?.riskScore || 50,
        },
      }, {
        priority: priorityValue,
        attempts: 5,
      });

      console.log(`Queued mint for user ${user.telegramId}`);
    }

    const badge = chain === 'base' ? 'BASE' : 'ROBINHOOD';
    const gatedWarning = (scan.isGated || scan.requiresSignature)
      ? '\nThis mint may be gated/signature-required'
      : '';

    await bot.api.sendMessage(
      Number(user.telegramId),
      `FREE MINT DETECTED ${badge}\n\n` +
      `Contract: ${scan.contractAddress}\n` +
      `Chain: ${chain.toUpperCase()}\n` +
      `Security Score: ${scan.security?.riskScore || 'N/A'}/100${gatedWarning}\n\n` +
      `${user.autoMintEnabled ? 'Auto-mint has been queued.' : 'Use /bypass to attempt mint manually.'}`,
      {
        parse_mode: 'Markdown',
        reply_markup: discoveryMintKeyboard(scan.contractAddress, chain),
        link_preview_options: { is_disabled: true }
      }
    );

  } catch (err: any) {
    if (err?.error_code === 403) {
      console.log(`User ${user.telegramId} blocked the bot`);
    } else {
      console.error(`Failed to process user ${user.telegramId}:`, err);
    }
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
