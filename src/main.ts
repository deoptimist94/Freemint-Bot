/**
 * Freemint Bot - Professional Detection Engine
 * Equal Access for All Users
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
import { getRPCPool, getRPCStats, dedupRPCRequest } from "./core/rpcPool.js";
import { mintQueue, discoveryQueue } from "./core/queue.js";

const monitors: Map<ChainId, MempoolMonitor> = new Map();
const listeners: Map<ChainId, DropListener> = new Map();

// Track processed discoveries to prevent duplicates
const processedDiscoveries = new Map<string, number>();
const DISCOVERY_DEDUP_TTL = 60000; // 60 seconds

async function main() {
  console.log("╔════════════════════════════════════════════════╗");
  console.log("║     Freemint Bot - Detection Engine v2.0       ║");
  console.log("║        Equal Access • Maximum Speed              ║");
  console.log("╚════════════════════════════════════════════════╝");

  const required = ["BOT_TOKEN", "ENCRYPTION_KEY", "DATABASE_URL"];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error(`❌ Missing required: ${missing.join(", ")}`);
    process.exit(1);
  }

  // Validate Alchemy configuration
  const hasBaseAlchemy = !!process.env.ALCHEMY_BASE_API_KEY;
  const hasRobinhoodAlchemy = !!process.env.ALCHEMY_ROBINHOOD_API_KEY;
  
  console.log("🔑 RPC Configuration:");
  console.log(`   Base: ${hasBaseAlchemy ? "✅ Alchemy" : "❌ Missing"}`);
  console.log(`   Robinhood: ${hasRobinhoodAlchemy ? "✅ Alchemy" : "❌ Missing"}`);

  if (!hasBaseAlchemy || !hasRobinhoodAlchemy) {
    console.error("❌ Both ALCHEMY_BASE_API_KEY and ALCHEMY_ROBINHOOD_API_KEY are required!");
    process.exit(1);
  }

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

  // Register queue handlers
  console.log("📋 Registering queue handlers...");
  
  mintQueue.process(async (job) => {
    const { userId, contractAddress, options } = job.data;
    console.log(`🔄 Mint job ${job.id} for user ${userId}`);
    return batchMint(BigInt(userId), contractAddress, options);
  });

  discoveryQueue.process(async (job) => {
    const { contractAddress, chain, detectedAt, txHash } = job.data;
    try {
      await processDiscovery(contractAddress, chain, detectedAt, txHash);
    } catch (error) {
      console.error(`Discovery failed for ${contractAddress}:`, error);
      throw error;
    }
  });

  // Start bot and services
  const bot = createBot();
  startHealthServer(bot);
  startAutoMintLoop(bot);
  startFloorWatcher(bot, 300);

  // Start mempool monitors (both chains)
  console.log("🔍 Starting mempool monitors...");
  
  const baseMempool = new MempoolMonitor("base", handleMempoolMint("base"));
  baseMempool.start();
  monitors.set("base", baseMempool);

  const robinhoodMempool = new MempoolMonitor("robinhood", handleMempoolMint("robinhood"));
  robinhoodMempool.start();
  monitors.set("robinhood", robinhoodMempool);

  // Start block listeners (backup detection)
  console.log("📡 Starting block listeners...");
  
  const baseListener = new DropListener("base", handleDrop("base"));
  baseListener.start();
  listeners.set("base", baseListener);

  const robinhoodListener = new DropListener("robinhood", handleDrop("robinhood"));
  robinhoodListener.start();
  listeners.set("robinhood", robinhoodListener);

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
      console.error("Copy-trade scheduler error:", err);
    }
  }, 15000);

  // RPC stats logging
  setInterval(() => {
    console.log("📊 RPC Stats:");
    console.log("   Base:", getRPCStats("base"));
    console.log("   Robinhood:", getRPCStats("robinhood"));
  }, 300000);

  // Cleanup old discoveries
  setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, timestamp] of processedDiscoveries) {
      if (now - timestamp > DISCOVERY_DEDUP_TTL * 2) {
        processedDiscoveries.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`🧹 Cleaned ${cleaned} old discovery entries`);
    }
  }, 300000);

  // Graceful shutdown
  const handleShutdown = async (signal: string) => {
    console.log(`\n🛑 Shutting down (${signal})...`);
    
    monitors.forEach(m => m.stop());
    listeners.forEach(l => l.stop());
    
    await mintQueue.close();
    await discoveryQueue.close();
    
    await bot.stop();
    await prisma.$disconnect();
    
    console.log("✅ Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => handleShutdown("SIGINT"));
  process.on("SIGTERM", () => handleShutdown("SIGTERM"));

  // Start bot
  try {
    await bot.start({
      onStart: (botInfo) => {
        console.log(`🤖 Bot started: @${botInfo.username}`);
        console.log("✅ System ready - Detection engine active");
      },
    });
  } catch (error) {
    console.error("❌ Failed to start bot:", error);
    process.exit(1);
  }
}

// Mempool detection handler
function handleMempoolMint(chain: ChainId) {
  return async (mint: MempoolMint) => {
    const dedupKey = `${chain}:${mint.contractAddress.toLowerCase()}`;
    
    // Skip if already processing
    if (processedDiscoveries.has(dedupKey)) {
      return;
    }
    processedDiscoveries.set(dedupKey, Date.now());

    try {
      // Check if already in database (recent)
      const existing = await prisma.mintHistory.findFirst({
        where: { 
          contractAddress: mint.contractAddress,
          chain,
          timestamp: { gte: new Date(Date.now() - 60000) }
        }
      });
      
      if (existing) return;

      console.log(`🎯 [${chain}] Mempool: ${mint.contractAddress}`);

      // Add to discovery queue with high priority
      await discoveryQueue.add({
        contractAddress: mint.contractAddress,
        chain,
        detectedAt: mint.detectedAt,
        txHash: mint.txHash,
        source: "mempool",
      }, {
        priority: 1, // Highest priority
        delay: 0,    // No delay
        attempts: 3,
      });

    } catch (err) {
      console.error(`Mempool handler error (${chain}):`, err);
    }
  };
}

// Block detection handler (backup)
function handleDrop(chain: ChainId) {
  return async (drop: { contractAddress: string; selector: string; txHash: string }) => {
    const dedupKey = `${chain}:${drop.contractAddress.toLowerCase()}`;
    
    // Skip if mempool already caught it
    if (processedDiscoveries.has(dedupKey)) {
      return;
    }
    processedDiscoveries.set(dedupKey, Date.now());

    try {
      const existing = await prisma.mintHistory.findFirst({
        where: { 
          contractAddress: drop.contractAddress,
          chain,
          timestamp: { gte: new Date(Date.now() - 30000) }
        }
      });
      
      if (existing) return;

      console.log(`📦 [${chain}] Block: ${drop.contractAddress}`);

      await discoveryQueue.add({
        contractAddress: drop.contractAddress,
        chain,
        detectedAt: Date.now(),
        txHash: drop.txHash,
        source: "block",
      }, {
        priority: 5, // Lower priority than mempool
        delay: 0,
        attempts: 3,
      });

    } catch (err) {
      console.error(`Block handler error (${chain}):`, err);
    }
  };
}

// Discovery processor - scans and notifies ALL users
async function processDiscovery(
  contractAddress: string,
  chain: ChainId,
  detectedAt: number,
  txHash?: string
): Promise<void> {
  const startTime = Date.now();
  const config = getChainConfig(chain);
  
  console.log(`🔬 [${chain}] Scanning: ${contractAddress}`);

  // Scan contract (with deduplication)
  const scan = await withChainContext(chain, () =>
    dedupRPCRequest(chain, `scan:${contractAddress}`, () => scanContract(contractAddress))
  );

  if (!scan.isContract || !scan.isNft) {
    console.log(`   ❌ Not an NFT contract`);
    return;
  }
  
  if (!scan.security?.isSafe) {
    console.log(`   ⚠️ Unsafe contract (score: ${scan.security?.score})`);
    return;
  }
  
  if (!scan.mintFunctions.length) {
    console.log(`   ❌ No mint functions found`);
    return;
  }

  // Spam filter
  const spam = await evaluateSpamContract(scan, chain);
  if (spam.isSpam) {
    console.log(`   🚫 Spam filtered`);
    return;
  }

  // Get best mint function
  const bestMintFn = getBestMintFunction(scan.mintFunctions) || scan.mintFunctions[0];

  // Simulate mint (probe wallet)
  const probeWallets = await getWallets(0n).catch(() => [] as any);
  const probeFrom = probeWallets[0]?.address || "0x0000000000000000000000000000000000000001";

  const sim = await withChainContext(chain, () =>
    dedupRPCRequest(chain, `simulate:${contractAddress}`, () => 
      simulateMint(scan.contractAddress, probeFrom, bestMintFn)
    )
  );
  
  if (!sim.success) {
    console.log(`   ❌ Simulation failed: ${sim.error}`);
    return;
  }

  console.log(`   ✅ Valid free mint detected!`);

  // Get floor data for context
  const floorData = await fetchCollectionFloor(contractAddress, undefined, chain)
    .catch(() => ({ floorPriceEth: 0, topBidEth: 0, collectionName: "Unknown" }));

  // Get ALL users with wallets (equal access)
  const activeUsers = await prisma.user.findMany({
    where: { 
      wallets: { some: {} },
    },
    include: { 
      wallets: true,
      sniperConfig: true,
    },
  });

  console.log(`   📢 Notifying ${activeUsers.length} users...`);

  // Send notifications to ALL users simultaneously
  const notificationPromises = activeUsers.map(async (user) => {
    try {
      const selection = await getUserChainSelection(BigInt(user.telegramId));
      if (!getChainsForSelection(selection).includes(chain)) {
        return; // User doesn't want this chain
      }

      // Send alert
      await sendMintAlert(bot, user, {
        contractAddress: scan.contractAddress,
        chain,
        collectionName: floorData.collectionName,
        floorPrice: floorData.floorPriceEth,
        selector: bestMintFn.selector,
        confidence: scan.security?.score || 0,
        gasEstimate: sim.gasEstimate,
        detectionTime: Date.now() - detectedAt,
      });

      // Auto-mint if enabled
      if (user.sniperConfig?.autoCopy) {
        await mintQueue.add({
          userId: user.telegramId.toString(),
          contractAddress: scan.contractAddress,
          chain,
          function: bestMintFn,
          options: { gasMultiplier: 1.2 },
        }, {
          priority: 1,
          attempts: 3,
          backoff: { type: "exponential", delay: 1000 },
        });
      }
    } catch (err) {
      console.error(`   ❌ Failed to notify ${user.telegramId}:`, err);
    }
  });

  // Notify all users in parallel (equal speed)
  await Promise.all(notificationPromises);

  const totalTime = Date.now() - startTime;
  console.log(`   ✅ Discovery complete in ${totalTime}ms | ${activeUsers.length} users notified`);
}

// Copy-trade polling
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
        console.log(`📨 Copy-trade alert to ${userId}: ${msg.slice(0, 50)}`);
      } catch (e) {
        console.error("Notification error:", e);
      }
    });
  } catch (err) {
    console.error(`Copy-trade poll error for ${userId}:`, err);
  }
}

// Notification helper
async function sendMintAlert(bot: any, user: any, data: {
  contractAddress: string;
  chain: ChainId;
  collectionName: string;
  floorPrice: number;
  selector: string;
  confidence: number;
  gasEstimate?: bigint;
  detectionTime: number;
}) {
  const config = getChainConfig(data.chain);
  const gasStr = data.gasEstimate ? `~${(Number(data.gasEstimate) / 1000000).toFixed(1)}M gas` : "Unknown";
  
  const message = `
🎯 **FREE MINT DETECTED**

${config.badge} **${config.name}**
📄 ${data.collectionName || "Unknown Collection"}
🔗 \`${data.contractAddress}\`

📊 Stats:
• Confidence: ${data.confidence}/100
• Floor: ${data.floorPrice > 0 ? `${data.floorPrice.toFixed(4)} ETH` : "Unknown"}
• Gas: ${gasStr}
• Selector: \`${data.selector}\`
⚡ Detection: ${data.detectionTime}ms

[View on Explorer](${config.explorerBaseUrl}/address/${data.contractAddress})
`;

  await bot.api.sendMessage(user.telegramId, message, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[
        { text: "🚀 Auto-Mint", callback_data: `automint:${data.contractAddress}:${data.chain}` },
        { text: "📋 Copy Address", callback_data: `copy:${data.contractAddress}` }
      ]]
    }
  });
}

main().catch((error) => {
  console.error("💥 Fatal error:", error);
  process.exit(1);
});
