/**
 * Worker Node - Processes mint jobs from queue
 * Run with: npm run worker
 */

import "dotenv/config";
import { mintQueue } from "./core/queue.js";
import { batchMint } from "./core/mint.js";
import { prisma } from "./db/client.js";
import { getChainConfig } from "./core/chains.js";

console.log("👷 Worker node starting...");

// Connect database
prisma.$connect().then(() => {
  console.log("✅ Worker database connected");
}).catch((err) => {
  console.error("❌ Worker database failed:", err);
  process.exit(1);
});

// Process mint jobs
mintQueue.process(async (job) => {
  const startTime = Date.now();
  const { userId, contractAddress, chain, options } = job.data;
  
  console.log(`\n🔄 Processing job ${job.id}`);
  console.log(`   User: ${userId}`);
  console.log(`   Contract: ${contractAddress}`);
  console.log(`   Chain: ${chain}`);
  console.log(`   Attempt: ${job.attemptsMade + 1}/${job.opts.attempts}`);
  
  try {
    const result = await batchMint(BigInt(userId), contractAddress, options);
    
    const duration = Date.now() - startTime;
    console.log(`✅ Job ${job.id} completed in ${duration}ms`);
    console.log(`   Success: ${result.totalSuccess}/${result.totalSuccess + result.totalFailed}`);
    
    if (result.abortReason) {
      console.log(`   Aborted: ${result.abortReason}`);
    }
    
    // Log detailed results
    for (const r of result.results) {
      const status = r.success ? '✅' : '❌';
      console.log(`   ${status} ${r.label}: ${r.walletAddress.slice(0, 6)}...${r.walletAddress.slice(-4)} ${r.error || ''}`);
    }
    
    return result;
    
  } catch (error) {
    console.error(`❌ Job ${job.id} failed:`, error);
    throw error; // Bull will retry based on config
  }
});

// Handle discovery jobs (optional separate worker)
// discoveryQueue.process(async (job) => {
//   console.log(`🔍 Discovery job ${job.id}`);
//   // Process discovery
// });

// Events
mintQueue.on('completed', (job, result) => {
  console.log(`🎉 Job ${job.id} finished: ${result.totalSuccess} mints`);
});

mintQueue.on('failed', (job, error) => {
  console.error(`💥 Job ${job.id} failed permanently:`, error.message);
});

mintQueue.on('stalled', (job) => {
  console.warn(`⚠️ Job ${job.id} stalled`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Worker shutting down...');
  await mintQueue.close();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Worker terminating...');
  await mintQueue.close();
  await prisma.$disconnect();
  process.exit(0);
});

console.log("👷 Worker ready and waiting for jobs...");
