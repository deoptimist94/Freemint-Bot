/**
 * Freemint Bot - Professional Edition
 */

import "dotenv/config";
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
import { getAutoMintStatus } from "./core/watchlist.js";
import { batchMint, checkMintStillOpen } from "./core/mint.js";
import { withChainContext } from "./core/chainContext.js";
import { type ChainId, getChainConfig } from "./core/chains.js";
import {
  getChainsForSelection,
  getUserChainSelection,
} from "./core/userChain.js";
import { MempoolMonitor, type MempoolMint } from "./core/mempoolSniper.js";
import { getRPCPool, getRPCStats } from "./core/rpcPool.js";
import { mintQueue, discoveryQueue } from "./core/queue.js";

const monitors: Map<ChainId, MempoolMonitor> = new Map();

async function main() {
  console.log("Starting Freemint Bot Professional Edition");

  const required = ["BOT_TOKEN", "ENCRYPTION_KEY", "DATABASE_URL"];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }

  const hasQuickNode = !!(process.env.QUICKNODE_BASE_RPC || process.env.QUICKNODE_ROBINHOOD_RPC);
  const hasAlchemy = !!process.env.ALCHEMY_API_KEY;
  const hasInfura = !!process.env.INFURA_BASE_RPC;
  
  console.log(`RPC Providers Configured:`);
  console.log(`  ${hasQuickNode ? "OK" : "NO"} QuickNode`);
  console.log(`  ${hasAlchemy ? "OK" : "NO"} Alchemy`);
  console.log(`  ${hasInfura ? "OK" : "NO"} Infura`);

  try {
    await prisma.$connect();
    console.log("Database connected");
  } catch (error) {
    console.error("Database connection failed:", error);
    process.exit(1);
  }

  console.log("Initializing RPC pools");
  getRPCPool("base");
  getRPCPool("robinhood");

  const bot = createBot();
  startHealthServer(bot);
  startAutoMintLoop(bot);
  startFloorWatcher(bot, 300);

  console.log("Starting mempool monitors");
  
  const baseMempool = new MempoolMonitor("base", handleMempoolMint("base"));
  baseMempool.start();
  monitors.set("base", baseMempool);

  const robinhoodEnabled = !!(process.env.ROBINHOOD_RPC_URL || process.env.ROBINHOOD_ALCHEMY_API_KEY || process.env.QUICKNODE_ROBINHOOD_RPC);
  
  if (robinhoodEnabled) {
    const robinhoodMempool = new MempoolMonitor("robinhood", handleMempoolMint("robinhood"));
    robinhoodMempool.start();
    monitors.set("robinhood", robinhoodMempool);
  } else {
    console.log("Robinhood mempool disabled");
  }

  const dropListener = new DropListener("base", handleDrop("base"));
  dropListener.start();

  const robinhoodListener = robinhoodEnabled
    ? new DropListener("robinhood", handleDrop("robinhood"))
    : null;
  robinhoodListener?.start();

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
    console.log("Robinhood:", getRPCStats("robinhood"));
  }, 300000);

  const handleShutdown = async (signal: string) => {
    console.log(`Shutting down (${signal})`);
    
    monitors.forEach(m => m.stop());
    dropListener.stop();
    robinhoodListener?.stop();
    
    await mintQueue.close();
    await discoveryQueue.close();
    
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
        console.log(`Drop already processed by mempool: ${drop.contractAddress}`);
        return;
      }

      console.log(`Block drop detected: ${drop.contractAddress} on ${chain}`);
      
      await discoveryQueue.add({
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

discoveryQueue.process(async (job) => {
  const { contractAddress, chain, detectedAt, txHash } = job.data;
  
  try {
    await processDiscovery(contractAddress, chain, detectedAt, txHash);
  } catch (error) {
    console.error(`Discovery processing failed for ${contractAddress}:`, error);
    throw error;
  }
});

async function processDiscovery(
  contractAddress: string,
  chain: ChainId,
  detectedAt: number,
  txHash?: string
): Promise<void> {
  const { badge, name, explorerBaseUrl } = getChainConfig(chain);
  
  const scan = await withChainContext(chain, () =>
    scanContract(contractAddress)
  );

  if (!scan.isContract || !scan.isNft) {
    console.log(`Not an NFT: ${contractAddress}`);
    return;
  }
  
  if (!scan.security?.isSafe) {
    console.log(`Unsafe contract: ${contractAddress}`);
    return;
  }
  
  if (!scan.mintFunctions.length) {
    console.log(`No free mint: ${contractAddress}`);
    return;
  }

  const spam = await evaluateSpamContract(scan, chain);
  if (spam.isSpam) {
    console.log(`Spam filtered: ${contractAddress}`);
    return;
  }

  const fn = getBestMintFunction(scan.mintFunctions) || scan.mintFunctions[0];

  const probeWallets = await getWallets(0n).catch(() => [] as any);
  const probeFrom = probeWallets[0]?.address || "0x0000000000000000000000000000000000000001";

  const sim = await withChainContext(chain, () =>
    simulateMint(scan.contractAddress, probeFrom, fn)
  );
  
  if (!sim.success) {
    console.log(`Simulation failed: ${contractAddress}`);
    return;
  }

  const activeUsers = await prisma.user.findMany({
    where: { 
      wallets: { some: {} },
    },
    include: { wallets: true },
  });

  for (const user of activeUsers) {
    if (!user.wallets?.length) continue;

    const selection = await getUserChainSelection(BigInt(user.telegramId));
    if (!getChainsForSelection(selection).includes(chain)) continue;

    console.log(`Alert sent to ${user.telegramId} for ${scan.contractAddress}`);

    const autoOn = await getAutoMintStatus(BigInt(user.telegramId));
    if (autoOn) {
      console.log(`Auto-minting for ${user.telegramId}`);
      
      await mintQueue.add({
        userId: user.telegramId.toString(),
        contractAddress: scan.contractAddress,
        chain,
        options: {},
      }, {
        priority: 2,
        attempts: 3,
      });
    }
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
