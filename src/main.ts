/**
 * Freemint Bot - Professional Edition
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
  simulateMint,
} from "./core/scanner.js";
import { evaluateSpamContract } from "./core/spamFilter.js";
import { startFloorWatcher } from "./core/floorWatcher.js";
import { pollTrackedWalletsForUser } from "./core/sniperEngine.js";
import { getWallets } from "./core/wallet.js";
import { batchMint } from "./core/mint.js";
import { withChainContext } from "./core/chainContext.js";
import { type ChainId, getChainConfig } from "./core/chains.js";
import {
  getChainsForSelection,
  getUserChainSelection,
} from "./core/userChain.js";
import { MempoolMonitor, type MempoolMint } from "./core/mempoolSniper.js";
import { getRPCPool, getRPCStats } from "./core/rpcPool.js";
import { mintQueue, discoveryQueue, closeQueues } from "./core/queue.js";
import { loadSubscribers } from "./core/broadcaster.js";

const monitors: Map<ChainId, MempoolMonitor> = new Map();
let bot: Bot;

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
  
  console.log(`RPC Providers:`);
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

  console.log("Registering queue handlers");
  
  mintQueue.process(async (job) => {
    const { userId, contractAddress, options } = job.data;
    console.log(`Processing mint job ${job.id} for user ${userId}`);
    const result = await batchMint(BigInt(userId), contractAddress, options);
    return result;
  });

  discoveryQueue.process(async (job) => {
    const { contractAddress, chain, detectedAt, txHash } = job.data;
    try {
      await processDiscovery(contractAddress, chain, detectedAt, txHash);
    } catch (error) {
      console.error(`Discovery processing failed for ${contractAddress}:`, error);
      throw error;
    }
  });

  bot = createBot();
  startHealthServer(bot);
  startAutoMintLoop(bot);
  startFloorWatcher(bot, 300 as number);

  console.log("Starting mempool monitors");
  
  const baseMempool = new MempoolMonitor("base", handleMempoolMint("base"));
  baseMempool.start();
  monitors.set("base", baseMempool);

  if (hasRobinhoodAlchemy) {
    const robinhoodMempool = new MempoolMonitor("robinhood", handleMempoolMint("robinhood"));
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

  setInterval(() => {
    console.log("RPC Pool Stats:");
    console.log("Base:", getRPCStats("base"));
    if (hasRobinhoodAlchemy) {
      console.log("Robinhood:", getRPCStats("robinhood"));
    }
  }, 300000);

  const handleShutdown = async (signal: string) => {
    console.log(`Shutting down (${signal})`);
    
    monitors.forEach(m => m.stop());
    dropListener.stop();
    robinhoodListener?.stop();
    
    await closeQueues();
    
    await bot.stop();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => handleShutdown("SIGINT"));
  process.on("SIGTERM", () => handleShutdown("SIGTERM"));

  try {
    await bot.start({
      onStart: (botInfo) => {
        console.log(`Bot started: @${botInfo.username}`);
      },
    });
  } catch (error) {
    console.error("Failed to start bot:", error);
    process.exit(1);
  }
}

function handleMempoolMint(chain: ChainId) {
  return async (mint: MempoolMint) => {
    try {
      const existing = await prisma.mintHistory.findFirst({
        where: { 
          contractAddress: mint.contractAddress,
          chain,
          timestamp: { gte: new Date(Date.now() - 60000) }
        }
      });
      
      if (existing) return;

      console.log(`Mempool mint detected: ${mint.contractAddress} on ${chain}`);

      await discoveryQueue.add({
        userId: "system",
        contractAddress: mint.contractAddress,
        chain,
        detectedAt: mint.detectedAt,
        txHash: mint.txHash,
      }, {
        priority: 1,
        delay: 100,
      });

    } catch (err) {
      console.error(`Mempool handler error (${chain}):`, err);
    }
  };
}

function handleDrop(chain: ChainId) {
  return async (drop: { contractAddress: string; selector: string; txHash: string }) => {
    try {
      const existing = await prisma.mintHistory.findFirst({
        where: { 
          contractAddress: drop.contractAddress,
          chain,
          timestamp: { gte: new Date(Date.now() - 30000) }
        }
      });
      
      if (existing) {
        console.log(`Drop already processed: ${drop.contractAddress}`);
        return;
      }

      console.log(`Block drop detected: ${drop.contractAddress} on ${chain}`);
      
      await discoveryQueue.add({
        userId: "system",
        contractAddress: drop.contractAddress,
        chain,
        detectedAt: Date.now(),
        txHash: drop.txHash,
      }, {
        priority: 5,
        delay: 500,
      });

    } catch (err) {
      console.error(`Block drop handler error (${chain}):`, err);
    }
  };
}

async function queueTrackedWalletPoll(userId: bigint): Promise<void> {
  try {
    const configs = await prisma.sniperConfig.findMany({
      where: { userId, autoCopy: true },
    });
    
    if (configs.length === 0) return;
    
    await pollTrackedWalletsForUser(userId, async (msg: string) => {
      try {
        const user = await prisma.user.findUnique({ where: { telegramId: userId } });
        if (!user) return;
        
        console.log(`Notification to ${userId}: ${msg.slice(0, 50)}`);
      } catch (e) {
        console.error("Failed to send notification:", e);
      }
    });
  } catch (err) {
    console.error(`Error polling tracked wallets for ${userId}:`, err);
  }
}

async function processDiscovery(
  contractAddress: string,
  chain: ChainId,
  detectedAt: number,
  txHash?: string
): Promise<void> {
  const config = getChainConfig(chain);
  
  const scan = await withChainContext(chain, () =>
    scanContract(contractAddress)
  );

  if (!scan.isContract || !scan.isNft) {
    console.log(`Not an NFT: ${contractAddress}`);
    return;
  }
  
  if (!scan.security?.isSafe) {
    console.log(`Unsafe contract: ${contractAddress} - ${scan.security.warnings.join(', ')}`);
    return;
  }
  
  if (!scan.mintFunctions.length) {
    console.log(`No free mint: ${contractAddress}`);
    return;
  }

  const spam = await evaluateSpamContract(scan, chain);
  if (spam.isSpam) {
    console.log(`Spam filtered: ${contractAddress} - ${spam.reason}`);
    return;
  }

  const fn = getBestMintFunction(scan.mintFunctions) || scan.mintFunctions[0];

  const probeWallets = await getWallets(0n).catch(() => [] as any);
  const probeFrom = probeWallets[0]?.address || "0x0000000000000000000000000000000000000001";

  const sim = await withChainContext(chain, () =>
    simulateMint(scan.contractAddress, probeFrom, fn)
  );
  
  if (!sim.success) {
    console.log(`Simulation failed: ${contractAddress} - ${sim.error}`);
    return;
  }

  const activeUsers = await prisma.user.findMany({
    where: { 
      wallets: { some: {} },
    },
    include: { wallets: true },
  });

  console.log(`Free-mint alert: ${scan.contractAddress} on ${chain} - broadcasting to ${activeUsers.length} users`);

  const userPromises = activeUsers.map(async (user) => {
    try {
      if (!user.wallets?.length) return;

      const selection = await getUserChainSelection(BigInt(user.telegramId));
      if (!getChainsForSelection(selection).includes(chain)) return;

      if (user.autoMintEnabled) {
        await mintQueue.add({
          userId: user.telegramId.toString(),
          contractAddress: scan.contractAddress,
          chain,
          options: {
            detectedAt,
            txHash,
            securityScore: scan.security.riskScore,
          },
        }, {
          priority: scan.security.riskScore < 20 ? 1 : 2,
          attempts: 5,
        });

        console.log(`Queued mint for user ${user.telegramId} on ${scan.contractAddress}`);
      }

      try {
        const badge = chain === 'base' ? 'BASE' : 'ROBINHOOD';
        const gatedWarning = (scan.isGated || scan.requiresSignature) ? '\nThis mint may be gated/signature-required' : '';
        
        await bot.api.sendMessage(Number(user.telegramId), 
          `FREE MINT DETECTED ${badge}\n\n` +
          `Contract: ${scan.contractAddress}\n` +
          `Chain: ${chain.toUpperCase()}\n` +
          `Security Score: ${scan.security.riskScore}/100${gatedWarning}\n\n` +
          `${user.autoMintEnabled ? 'Auto-mint has been queued.' : 'Use /bypass to attempt mint manually.'}`,
          { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } }
        );
      } catch (notifyErr: any) {
        if (notifyErr?.error_code === 403) {
          console.log(`User ${user.telegramId} blocked the bot`);
        } else {
          console.error(`Failed to notify ${user.telegramId}:`, notifyErr.message);
        }
      }

    } catch (err) {
      console.error(`Failed to process user ${user.telegramId}:`, err);
    }
  });

  await Promise.race([
    Promise.all(userPromises),
    new Promise((unused, reject) => 
      setTimeout(() => reject(new Error('User processing timeout')), 30000)
    ),
  ]).catch(err => {
    console.error('Parallel user processing error:', err);
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
