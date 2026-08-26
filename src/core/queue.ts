/**
 * Job Queue - In-Memory with Postgres persistence
 * Enhanced with proper typing and BullMQ-like interface
 */

import { prisma } from "../db/client.js";
import type { ChainId } from "./chains.js";

export interface JobData {
  userId?: string;
  contractAddress: string;
  chain: ChainId;
  options?: any;
  detectedAt?: number;
  txHash?: string;
}

export interface QueuedJob {
  id: string;
  data: JobData;
  attempts: number;
  attemptsMade: number;  // Added for Bull compatibility
  priority: number;
  createdAt: number;
  delayUntil?: number;
  opts: { attempts: number; priority?: number };  // Added for Bull compatibility
}

type JobProcessor = (job: QueuedJob) => Promise<any>;

interface JobLogData {
  queueName: string;
  jobId: string;
  userId: bigint;
  contractAddress: string;
  chain: string;
  status: string;
  result?: string | null;
  error?: string | null;
}

class MemoryQueue {
  private name: string;
  private jobs: QueuedJob[] = [];
  private processing: boolean = false;
  private processor?: JobProcessor;
  private intervalMs: number;
  private intervalId?: NodeJS.Timeout;
  private eventHandlers: Map<string, Function[]> = new Map();

  constructor(name: string, intervalMs: number = 1000) {
    this.name = name;
    this.intervalMs = intervalMs;
    console.log(`MemoryQueue '${name}' initialized`);
  }

  public process(processor: JobProcessor): void {
    this.processor = processor;
    this.startProcessing();
  }

  private startProcessing(): void {
    if (this.intervalId) return;
    
    this.intervalId = setInterval(async () => {
      if (this.processing || !this.processor || this.jobs.length === 0) return;
      
      this.processing = true;
      
      // Sort by priority (lower = higher priority), then by creation time
      this.jobs.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.createdAt - b.createdAt;
      });

      const now = Date.now();
      const readyIndex = this.jobs.findIndex(j => !j.delayUntil || j.delayUntil <= now);
      
      if (readyIndex === -1) {
        this.processing = false;
        return;
      }

      const job = this.jobs.splice(readyIndex, 1)[0];
      
      try {
        console.log(`[${this.name}] Processing job ${job.id} (attempt ${job.attemptsMade + 1})`);
        const result = await this.processor(job);
        await this.logJob(job, 'completed', result);
        this.emit('completed', job, result);
        console.log(`[${this.name}] Job ${job.id} completed`);
      } catch (error: any) {
        console.error(`[${this.name}] Job ${job.id} failed:`, error.message);
        job.attempts++;
        job.attemptsMade++;
        
        if (job.attempts < (job.opts.attempts || 5)) {
          const backoffMs = Math.pow(2, job.attempts) * 1000;
          job.delayUntil = Date.now() + backoffMs;
          this.jobs.push(job);
          console.log(`[${this.name}] Job ${job.id} requeued for retry ${job.attempts}`);
        } else {
          await this.logJob(job, 'failed', null, error.message);
          this.emit('failed', job, error);
          console.error(`[${this.name}] Job ${job.id} failed permanently`);
        }
      }
      
      this.processing = false;
    }, this.intervalMs);
  }

  private async logJob(
    job: QueuedJob, 
    status: string, 
    result?: any, 
    error?: string
  ): Promise<void> {
    try {
      if (!job.data.userId) return;
      
      await prisma.jobLog.create({
        data: {
          queueName: this.name,
          jobId: job.id,
          userId: BigInt(job.data.userId),
          contractAddress: job.data.contractAddress,
          chain: job.data.chain,
          status,
          result: result ? JSON.stringify(result).slice(0, 1000) : null,
          error: error?.slice(0, 1000),
        },
      });
    } catch (e) {
      console.error('Failed to log job:', e);
    }
  }

  public async add(
    data: JobData, 
    options?: { priority?: number; delay?: number; attempts?: number }
  ): Promise<{ id: string }> {
    const attempts = options?.attempts ?? 5;
    const job: QueuedJob = {
      id: `${this.name}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      data,
      attempts: 0,
      attemptsMade: 0,
      priority: options?.priority ?? 5,
      createdAt: Date.now(),
      delayUntil: options?.delay ? Date.now() + options.delay : undefined,
      opts: { attempts: attempts, priority: options?.priority ?? 5 },
    };

    this.jobs.push(job);
    console.log(`[${this.name}] Job ${job.id} added (queue size: ${this.jobs.length})`);
    return { id: job.id };
  }

  public getStats(): { pending: number; processing: boolean } {
    return {
      pending: this.jobs.length,
      processing: this.processing,
    };
  }

  public close(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    console.log(`[${this.name}] Queue closed`);
  }

  public on(event: string, handler: Function): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event)!.push(handler);
  }

  private emit(event: string, ...args: any[]): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach(handler => {
        try {
          handler(...args);
        } catch (e) {
          console.error(`Event handler error for ${event}:`, e);
        }
      });
    }
  }
}

export const mintQueue = new MemoryQueue('nft-mints', 500);
export const discoveryQueue = new MemoryQueue('nft-discovery', 1000);

export async function closeQueues(): Promise<void> {
  mintQueue.close();
  discoveryQueue.close();
}

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
  }, {
    priority: 2,
    attempts: 5,
  });
  return job.id;
}

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
  }, {
    priority: 1,
    delay: 500,
  });
  return job.id;
}

export function isQueueHealthy(): boolean {
  return true;
}
