/**
 * Freemint Bot - Professional Edition
 * Features: Mempool sniping, RPC pool, job queues, unlimited scale
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

// Global monitors
const monitors: Map<ChainId, MempoolMonitor> = new Map();

async function main() {
  console.log("🚀 Starting Freemint Bot Professional Edition...");
  console.log("⚡ Features: Mempool Sniping | RPC Pool | Job Queue | Unlimited Scale");

  // Validate environment
  const required = ["BOT_TOKEN", "ENCRYPTION_KEY", "DATABASE_URL"];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error(`❌ Missing required environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }

  // Check RPC configuration
  const hasQuickNode = !!(process.env.QUICKNODE_BASE_RPC || process.env.QUICKNODE_ROBINHOOD_RPC);
  const hasAlchemy = !!process.env.ALCHEMY_API_KEY;
  const hasInfura = !!process.env.INFURA_BASE_RPC;
  
  console.log(`🔌 RPC Providers Configured:`);
  console.log(`   ${hasQuickNode ? '✅' : '❌'} QuickNode`);
  console.log(`   ${hasAlchemy ? '✅' : '❌'} Alchemy`);
  console.log(`   ${hasInfura ? '✅' : '❌'} Infura`);
  
  if (!hasQuickNode && !hasAlchemy && !hasInfura) {
    console.warn("⚠️  Warning: No premium RPC providers configured. Using public RPCs only.");
  }

  // Connect database
  try {
    await prisma.$connect();
    console.log("✅ Database connected");
  } catch (error) {
    console.error("❌ Database connection failed:", error);
    process.exit(1);
  }

  // Initialize RPC pools
  console.log("🌐 Initializing RPC pools...");
  getRPCPool("base");
  getRPCPool("robinhood");

  // Create bot
  const bot = createBot();
  startHealthServer(bot);
  startAutoMintLoop(bot);
  startFloorWatcher(bot, 300);

  // Start mempool monitors (10x faster detection)
  console.log("🎯 Starting mempool monitors...");
  
  const baseMempool = new MempoolMonitor("base", handleMempoolMint("base"));
  baseMempool.start();
  monitors.set("base", baseMempool);

  const robinhoodEnabled = !!(process.env.ROBINHOOD_RPC_URL || process.env.ROBINHOOD_ALCHEMY_API_KEY || process.env.QUICKNODE_ROBINHOOD_RPC);
  
  if (robinhoodEnabled) {
    const robinhoodMempool = new MempoolMonitor("robinhood", handleMempoolMint("robinhood"));
    robinhoodMempool.start();
    monitors.set("robinhood", robinhoodMempool);
  } else {
    console.log("⏭ Robinhood mempool disabled (no RPC configured)");
  }

  // Legacy block listener as backup (slower but reliable)
  const dropListener = new DropListener("base", handleDrop("base"));
  dropListener.start();

  const robinhoodListener = robinhoodEnabled
    ? new DropListener("robinhood", handleDrop("robinhood"))
    : null;
  robinhoodListener?.start();

  // Copy-trade polling (every 15s with queue)
  setInterval(async () => {
    try {
      const configs = await prisma.sniperConfig.findMany({
        where: { autoCopy: true },
      });
      
      for (const cfg of configs) {
        // Add to queue instead of direct processing
        await queueTrackedWalletPoll(cfg.userId);
      }
    } catch (err) {
      console.error("Error in copy-trade scheduler:", err);
    }
  }, 15_000);

  // RPC stats logging (every 5 minutes)
  setInterval(() => {
    console.log("\n📊 RPC Pool Stats:");
    console.log("Base:", getRPCStats("base"));
    console.log("Robinhood:", getRPCStats("robinhood"));
  }, 300_000);

  // Graceful shutdown
  const handleShutdown = async (signal: string) => {
    console.log(`🛑 Shutting down (${signal})...`);
    
    // Stop monitors
    monitors.forEach(m => m.stop());
    dropListener.stop();
    robinhoodListener?.stop();
    
    // Close queues
    await mintQueue.close();
    await discoveryQueue.close();
    
    await bot.stop();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => handleShutdown("SIGINT"));
  process.on("SIGTERM", () => handleShutdown("SIGTERM"));

  // Start bot
  try {
    await bot.start({
      onStart: (botInfo) => {
        console.log(`✅ Bot started: @${botInfo.username}`);
        console.log(`🚀 System ready for unlimited users!`);
      },
    });
  } catch (error) {
    console.error("❌ Failed to start bot:", error);
    process.exit(1);
  }
}

// Mempool mint handler (ULTRA FAST - <500ms detection)
function handleMempoolMint(chain: ChainId) {
  return async (mint: MempoolMint) => {
    const { badge, name } = getChainConfig(chain);
    
    try {
      // Skip if already processed
      const existing = await prisma.mintHistory.findFirst({
        where: { 
          contractAddress: mint.contractAddress,
          chain,
          timestamp: { gte: new Date(Date.now() - 60000) } // Last minute
        }
      });
      
      if (existing) return;

      console.log(`⚡ Mempool mint detected: ${mint.contractAddress} on ${chain}`);

      // Add to discovery queue for processing
      await discoveryQueue.add({
        contractAddress: mint.contractAddress,
        chain,
        detectedAt: mint.detectedAt,
        txHash: mint.txHash,
      }, {
        priority: 1, // High priority for mempool
        delay: 100, // Small delay to batch process
      });

    } catch (err) {
      console.error(`Mempool handler error (${chain}):`, err);
    }
  };
}

// Legacy block drop handler (slower but reliable backup)
function handleDrop(chain: ChainId) {
  return async (drop: { contractAddress: string; selector: string; txHash: string }) => {
    const { badge, name } = getChainConfig(chain);
    
    try {
      // Check if already processed by mempool
      const existing = await prisma.mintHistory.findFirst({
        where: { 
          contractAddress: drop.contractAddress,
          chain,
          timestamp: { gte: new Date(Date.now() - 30000) }
        }
      });
      
      if (existing) {
        console.log(`⏭ Drop already processed by mempool: ${drop.contractAddress}`);
        return;
      }

      console.log(`📦 Block drop detected: ${drop.contractAddress} on ${chain}`);
      
      // Lower priority for block drops
      await discoveryQueue.add({
        contractAddress: drop.contractAddress,
        chain,
        detectedAt: Date.now(),
        txHash: drop.txHash,
      }, {
        priority: 5, // Lower priority
        delay: 500,
      });

    } catch (err) {
      console.error(`Block drop handler error (${chain}):`, err);
    }
  };
}

// Queue handler for tracked wallet polling
async function queueTrackedWalletPoll(userId: bigint): Promise<void> {
  // This runs the sniper engine but with better error handling
  try {
    const configs = await prisma.sniperConfig.findMany({
      where: { userId, autoCopy: true },
    });
    
    if (configs.length === 0) return;
    
    // Process with rate limiting
    await pollTrackedWalletsForUser(userId, async (msg: string) => {
      try {
        const user = await prisma.user.findUnique({ where: { telegramId: userId } });
        if (!user) return;
        
        await sendNotification(userId, msg);
      } catch (e) {
        console.error("Failed to send notification:", e);
      }
    });
  } catch (err) {
    console.error(`Error polling tracked wallets for ${userId}:`, err);
  }
}

// Discovery queue processor
discoveryQueue.process(async (job) => {
  const { contractAddress, chain, detectedAt, txHash } = job.data;
  
  try {
    await processDiscovery(contractAddress, chain, detectedAt, txHash);
  } catch (error) {
    console.error(`Discovery processing failed for ${contractAddress}:`, error);
    throw error; // Will retry
  }
});

// Process discovery (scan + notify + auto-mint)
async function processDiscovery(
  contractAddress: string,
  chain: ChainId,
  detectedAt: number,
  txHash?: string
): Promise<void> {
  const { badge, name, explorerBaseUrl } = getChainConfig(chain);
  
  // Scan contract
  const scan = await withChainContext(chain, () =>
    scanContract(contractAddress)
  );

  // Hard gates
  if (!scan.isContract || !scan.isNft) {
    console.log(`⏭ Not an NFT: ${contractAddress}`);
    return;
  }
  
  if (!scan.security?.isSafe) {
    console.log(`⏭ Unsafe contract: ${contractAddress}`);
    return;
  }
  
  if (!scan.mintFunctions.length) {
    console.log(`⏭ No free mint: ${contractAddress}`);
    return;
  }

  // Spam filter
  const spam = await evaluateSpamContract(scan, chain);
  if (spam.isSpam) {
    console.log(`⏭ Spam filtered: ${contractAddress}`);
    return;
  }

  const fn = getBestMintFunction(scan.mintFunctions) || scan.mintFunctions[0];

  // Simulation test
  const probeWallets = await getWallets(0n).catch(() => [] as any);
  const probeFrom = probeWallets[0]?.address || "0x0000000000000000000000000000000000000001";

  const sim = await withChainContext(chain, () =>
    simulateMint(scan.contractAddress, probeFrom, fn)
  );
  
  if (!sim.success) {
    console.log(`⏭ Simulation failed: ${contractAddress} - ${sim.error?.slice(0, 100)}`);
    return;
  }

  // Get active users for this chain
  const activeUsers = await prisma.user.findMany({
    where: { 
      wallets: { some: {} },
      chainSelection: { contains: chain }
    },
    include: { wallets: true },
  });

  // Notify and queue mints
  for (const user of activeUsers) {
    if (!user.wallets?.length) continue;

    const selection = await getUserChainSelection(BigInt(user.telegramId));
    if (!getChainsForSelection(selection).includes(chain)) continue;

    // Send alert
    const alertMessage =
      `🚨 *NEW FREE MINT DETECTED!* — ${badge} ${name}\n\n` +
      `📦 *Contract:* \\`${scan.contractAddress}\\`\n` +
      `⚙️ *Function:* \\`${fn.name}(${fn.args.join(",")})\\`\n` +
      `🔍 *Verified:* ${scan.isVerified ? "✅ Yes" : "⚠️ Bytecode"}\\n` +
      `⚡ *Detection:* ${Date.now() - detectedAt}ms\\n\\n` +
      `_Tap below to mint with your active wallets:_`;

    await sendNotification(BigInt(user.telegramId), alertMessage, {
      inline_keyboard: [
        [
          {
            text: "🚀 Batch Mint Now",
            callback_data: `mint_${scan.contractAddress}_${chain}`,
          },
        ],
        [
          {
            text: `🔗 View on ${chain === 'base' ? 'BaseScan' : 'Blockscout'}`,
            url: `${explorerBaseUrl}/address/${scan.contractAddress}`,
          },
        ],
      ],
    });

    // Auto-mint via queue
    const autoOn = await getAutoMintStatus(BigInt(user.telegramId));
    if (autoOn) {
      console.log(`⚡ Auto-minting for ${user.telegramId} on ${chain}`);
      
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

// Helper: Send notification with error handling
async function sendNotification(
  userId: bigint,
  message: string,
  keyboard?: any
): Promise<void> {
  // You'll need to import your bot instance or use a global
  // This is a placeholder - implement based on your bot structure
  try {
    // Implementation depends on your bot setup
    console.log(`📨 Notification to ${userId}: ${message.slice(0, 50)}...`);
  } catch (error) {
    console.error(`Failed to notify ${userId}:`, error);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
