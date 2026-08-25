/**
 * Job Queue - Redis-based for unlimited users
 * Processes mints asynchronously without blocking
 */

import Queue from 'bull';
import { batchMint } from './mint.js';
import { type ChainId } from './chains.js';

// Redis connection
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// Mint queue
export const mintQueue = new Queue('nft-mints', redisUrl, {
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});

// Process jobs
mintQueue.process(async (job) => {
  const { userId, contractAddress, chain, options } = job.data;
  
  console.log(`🔄 Processing mint job ${job.id} for user ${userId}`);
  
  const result = await batchMint(BigInt(userId), contractAddress, options);
  
  return result;
});

// Add job wrapper
export async function queueMint(
  userId: bigint,
  contractAddress: string,
  chain: ChainId,
  options?: any
): Promise<string> {
  const job = await mintQueue.add({
    userId: userId.toString(),
    contractAddress,
    chain,
    options,
  });
  
  return job.id.toString();
}

// Queue events
mintQueue.on('completed', (job, result) => {
  console.log(`✅ Mint job ${job.id} completed: ${result.totalSuccess} success`);
});

mintQueue.on('failed', (job, error) => {
  console.error(`❌ Mint job ${job.id} failed:`, error.message);
});

// Discovery queue for auto-mint
export const discoveryQueue = new Queue('nft-discovery', redisUrl, {
  defaultJobOptions: {
    delay: 1000, // 1 second delay for processing
    removeOnComplete: 500,
  },
});

discoveryQueue.process(async (job) => {
  const { contractAddress, chain, detectedAt } = job.data;
  
  // Process discovery - scan and notify users
  console.log(`🔍 Processing discovery: ${contractAddress} on ${chain}`);
  
  // Your discovery logic here
});
