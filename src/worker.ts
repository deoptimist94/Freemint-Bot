/**
 * Worker Node - Processes mint jobs from queue
 * Fixed TypeScript errors and enhanced logging
 * Run with: npm run worker
 */

import "dotenv/config";
import { mintQueue, type QueuedJob } from "./core/queue.js";
import { batchMint, type BatchMintResult } from "./core/mint.js";
import { prisma } from "./db/client.js";

console.log("👷 Worker node starting...");

// Connect database
prisma.$connect().then(() => {
  console.log("✅ Worker database connected");
}).catch((err) => {
  console.error("❌ Worker database failed:", err);
  process.exit(1);
});

// Process mint jobs with proper typing
mintQueue.process(async (job: QueuedJob): Promise<BatchMintResult> => {
  const startTime = Date.now();
  const { userId, contractAddress, chain, options } = job.data;

  // ✅ FIXED: Validate userId exists
  if (!userId) {
    throw new Error("Missing userId in job data");
  }

  console.log(`\n🔄 Processing job ${job.id}`);
  console.log(`   User: ${userId}`);
  console.log(`   Contract: ${contractAddress}`);
  console.log(`   Chain: ${chain}`);
  // ✅ FIXED: Use correct property names
  console.log(`   Attempt: ${job.attemptsMade + 1}/${job.opts.attempts}`);

  try {
    // ✅ FIXED: Safe BigInt conversion
    const userIdBigInt = BigInt(userId);
    const result = await batchMint(userIdBigInt, contractAddress, options);
    
    const duration = Date.now() - startTime;
    
    console.log(`✅ Job ${job.id} completed in ${duration}ms`);
    console.log(`   Success: ${result.totalSuccess}/${result.totalSuccess + result.totalFailed}`);
    
    if (result.abortReason) {
      console.log(`   Aborted: ${result.abortReason}`);
    }

    // Log detailed results
    for (const r of result.results) {
      const status = r.success ? '✅' : '❌';
      const shortAddr = `${r.walletAddress.slice(0, 6)}...${r.walletAddress.slice(-4)}`;
      const errorMsg = r.error ? ` — ${r.error}` : '';
      console.log(`   ${status} ${r.label}: ${shortAddr}${errorMsg}`);
    }

    return result;
  } catch (error) {
    console.error(`❌ Job ${job.id} failed:`, error);
    throw error; // Bull will retry based on config
  }
});

// Handle discovery jobs (optional)
// discoveryQueue.process(async (job: QueuedJob) => {
//   console.log(`🔍 Discovery job ${job.id}`);
//   // Process discovery
// });

// ✅ FIXED: Typed event handlers
mintQueue.on('completed', (job: QueuedJob, result: BatchMintResult) => {
  console.log(`🎉 Job ${job.id} finished: ${result.totalSuccess} successful mints`);
});

mintQueue.on('failed', (job: QueuedJob, error: Error) => {
  console.error(`💥 Job ${job.id} failed permanently:`, error.message);
});

mintQueue.on('stalled', (job: QueuedJob) => {
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
