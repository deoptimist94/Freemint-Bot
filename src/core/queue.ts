/**
 * Job Queue - Redis-based for unlimited users
 * Processes mints asynchronously without blocking
 */

import Queue from 'bull';
import { type ChainId } from './chains.js';

// Redis connection
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// Mint queue - handlers registered in main.ts
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

// Discovery queue - handlers registered in main.ts
export const discoveryQueue = new Queue('nft-discovery', redisUrl, {
  defaultJobOptions: {
    delay: 1000, // 1 second delay for processing
    removeOnComplete: 500,
  },
});

// Queue events
mintQueue.on('completed', (job, result) => {
  console.log(`✅ Mint job ${job.id} completed: ${result?.totalSuccess ?? 0} success`);
});

mintQueue.on('failed', (job, error) => {
  console.error(`❌ Mint job ${job.id} failed:`, error.message);
});

discoveryQueue.on('completed', (job) => {
  console.log(`✅ Discovery job ${job.id} completed`);
});

discoveryQueue.on('failed', (job, error) => {
  console.error(`❌ Discovery job ${job.id} failed:`, error.message);
});

// Add job wrapper for mint
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

// Add job wrapper for discovery
export async function queueDiscovery(
  contractAddress: string,
  chain: ChainId,
  detectedAt: number,
  txHash?: string
): Promise<string> {
  const job = await discoveryQueue.add({
    contractAddress,
    chain,
    detectedAt,
    txHash,
  });
  
  return job.id.toString();
}
