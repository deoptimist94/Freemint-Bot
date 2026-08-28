/**
 * Enhanced Event Broadcaster - True parallel multi-user notifications
 */

import type { Bot } from "grammy";
import { prisma } from "../db/client.js";
import { getChainsForSelection, getUserChainSelection } from "./userChain.js";
import type { ChainId } from "./chains.js";

interface FreeMintEvent {
  type: 'free_mint';
  contractAddress: string;
  chain: ChainId;
  detectedAt: number;
  txHash?: string;
  securityScore: number;  // FIXED: Changed from 'security' object to direct number
  isGated: boolean;
  requiresSignature?: boolean;
}

interface WhaleMintEvent {
  type: 'whale_mint';
  contractAddress: string;
  chain: ChainId;
  whaleAddress: string;
  whaleLabel?: string;
  txHash: string;
}

type BotEvent = FreeMintEvent | WhaleMintEvent;

interface Subscriber {
  telegramId: bigint;
  chainSelection: ChainId[];
  autoMintEnabled: boolean;
}

const subscribers = new Map<bigint, Subscriber>();
const recentEvents = new Map<string, number>();
const EVENT_DEDUP_TTL = 60 * 1000;

export async function loadSubscribers(): Promise<void> {
  try {
    const users = await prisma.user.findMany({
      where: { wallets: { some: {} } },
      include: { wallets: true },
    });

    for (const user of users) {
      const selection = await getUserChainSelection(user.telegramId);
      subscribers.set(user.telegramId, {
        telegramId: user.telegramId,
        chainSelection: getChainsForSelection(selection),
        autoMintEnabled: user.autoMintEnabled,
      });
    }

    console.log(`Loaded ${subscribers.size} subscribers`);
  } catch (err) {
    console.error('Failed to load subscribers:', err);
  }
}

export async function refreshSubscriber(telegramId: bigint): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { telegramId },
      include: { wallets: true },
    });

    if (!user || user.wallets.length === 0) {
      subscribers.delete(telegramId);
      return;
    }

    const selection = await getUserChainSelection(telegramId);
    subscribers.set(telegramId, {
      telegramId,
      chainSelection: getChainsForSelection(selection),
      autoMintEnabled: user.autoMintEnabled,
    });
  } catch (err) {
    console.error('Failed to refresh subscriber:', err);
  }
}

export async function broadcastEvent(bot: Bot, event: BotEvent): Promise<void> {
  const eventKey = `${event.type}:${event.contractAddress}:${event.chain}`;
  const now = Date.now();

  if (recentEvents.has(eventKey)) {
    const lastTime = recentEvents.get(eventKey)!;
    if (now - lastTime < EVENT_DEDUP_TTL) {
      console.log(`Event ${eventKey} already broadcast recently`);
      return;
    }
  }

  recentEvents.set(eventKey, now);
  
  for (const [key, time] of recentEvents) {
    if (now - time > EVENT_DEDUP_TTL * 2) {
      recentEvents.delete(key);
    }
  }

  let message: string;
  if (event.type === 'free_mint') {
    const badge = event.chain === 'base' ? 'BASE' : 'ROBINHOOD';
    const gatedWarning = event.isGated ? '\nGated mint detected' : '';
    const sigWarning = event.requiresSignature ? '\nSignature required' : '';
    
    // FIXED: Use event.securityScore directly
    message =
      `FREE MINT DETECTED ${badge}\n\n` +
      `Contract: ${event.contractAddress}\n` +
      `Chain: ${event.chain.toUpperCase()}\n` +
      `Security Score: ${event.securityScore}/100${gatedWarning}${sigWarning}\n\n` +
      `Auto-mint will attempt if enabled.`;
  } else {
    const badge = event.chain === 'base' ? 'BASE' : 'ROBINHOOD';
    const label = event.whaleLabel ? ` (${event.whaleLabel})` : '';
    
    message =
      `WHALE MINT DETECTED ${badge}\n\n` +
      `Whale: ${event.whaleAddress}${label}\n` +
      `Contract: ${event.contractAddress}\n` +
      `Chain: ${event.chain.toUpperCase()}\n\n` +
      `Copy-mint will attempt if enabled.`;
  }

  const eligibleSubscribers = Array.from(subscribers.values())
    .filter(sub => sub.chainSelection.includes(event.chain));

  console.log(`Broadcasting ${event.type} to ${eligibleSubscribers.length} users`);

  const results: PromiseSettledResult<{ success: boolean; userId: bigint; error?: string }>[] = [];
  const CHUNK_SIZE = 20;
  for (let index = 0; index < eligibleSubscribers.length; index += CHUNK_SIZE) {
    const chunk = eligibleSubscribers.slice(index, index + CHUNK_SIZE);
    results.push(...await Promise.allSettled(
      chunk.map(async (sub) => {
      try {
        await bot.api.sendMessage(Number(sub.telegramId), message, {
          parse_mode: 'Markdown',
          link_preview_options: { is_disabled: true },
        });
        return { success: true, userId: sub.telegramId };
      } catch (err: unknown) {
        const errorCode =
          typeof err === "object" && err !== null && "error_code" in err
            ? err.error_code
            : undefined;
        if (errorCode === 403) {
          subscribers.delete(sub.telegramId);
          console.log(`Removed blocked user ${sub.telegramId}`);
        }
        const errorMessage = err instanceof Error ? err.message : String(err);
        return { success: false, userId: sub.telegramId, error: errorMessage };
      }
      })
    ));
    if (index + CHUNK_SIZE < eligibleSubscribers.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  const successCount = results.filter(
    (result) => result.status === 'fulfilled' && result.value.success
  ).length;
  const failCount = results.length - successCount;

  console.log(`Broadcast complete: ${successCount} success, ${failCount} failed`);
}

export function getSubscriberStats(): { total: number; autoMint: number } {
  let autoMint = 0;
  for (const sub of subscribers.values()) {
    if (sub.autoMintEnabled) autoMint++;
  }
  return { total: subscribers.size, autoMint };
}
