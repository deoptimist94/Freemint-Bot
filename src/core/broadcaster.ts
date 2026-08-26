/**
 * Event Broadcaster - Simultaneous multi-user notifications
 */

import { type Bot } from "grammy";
import { prisma } from "../db/client.js";
import { getChainsForSelection, getUserChainSelection } from "./userChain.js";
import type { ChainId } from "./chains.js";

interface FreeMintEvent {
  type: 'free_mint';
  contractAddress: string;
  chain: ChainId;
  detectedAt: number;
  txHash?: string;
  securityScore: number;
  isGated: boolean;
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

const subscribers = new Map<bigint, {
  telegramId: bigint;
  chainSelection: ChainId[];
  autoMintEnabled: boolean;
}>();

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
    
    console.log(`📡 Loaded ${subscribers.size} subscribers`);
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
      console.log(`⏭️ Event ${eventKey} already broadcast recently`);
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
    const badge = event.chain === 'base' ? '⛽' : '🏹';
    const gatedWarning = event.isGated ? '\n⚠️ *Gated mint detected - may require whitelist*' : '';
    message = 
      `🚨 *FREE MINT DETECTED* ${badge}\n\n` +
      `Contract: \\`${event.contractAddress}\\`\n` +
      `Chain: ${event.chain.toUpperCase()}\n` +
      `Security Score: ${event.securityScore}/100${gatedWarning}\n\n` +
      `Auto-mint will attempt if enabled.`;
  } else {
    const badge = event.chain === 'base' ? '⛽' : '🏹';
    const label = event.whaleLabel ? `(${event.whaleLabel})` : '';
    message = 
      `🐋 *WHALE MINT DETECTED* ${badge}\n\n` +
      `Whale: \\`${event.whaleAddress}\\` ${label}\n` +
      `Contract: \\`${event.contractAddress}\\`\n` +
      `Chain: ${event.chain.toUpperCase()}\n\n` +
      `Copy-mint will attempt if enabled.`;
  }
  
  const promises: Promise<void>[] = [];
  
  for (const sub of subscribers.values()) {
    if (!sub.chainSelection.includes(event.chain)) continue;
    
    const promise = (async () => {
      try {
        await bot.api.sendMessage(Number(sub.telegramId), message, {
          parse_mode: 'Markdown',
          link_preview_options: { is_disabled: true },
        });
      } catch (err: any) {
        if (err?.error_code === 403) {
          subscribers.delete(sub.telegramId);
        } else {
          console.error(`Failed to notify ${sub.telegramId}:`, err.message);
        }
      }
    })();
    
    promises.push(promise);
  }
  
  await Promise.race([
    Promise.all(promises),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Broadcast timeout')), 30000)
    ),
  ]).catch(err => {
    console.error('Broadcast error:', err);
  });
  
  console.log(`📡 Broadcast ${event.type} to ${promises.length} users`);
}

export function getSubscriberStats(): { total: number; autoMint: number } {
  let autoMint = 0;
  for (const sub of subscribers.values()) {
    if (sub.autoMintEnabled) autoMint++;
  }
  return { total: subscribers.size, autoMint };
}
