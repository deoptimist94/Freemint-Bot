import { prisma } from "../db/client.js";
import { getAutoMintUsers, getWatchlist } from "./watchlist.js";
import { batchMint } from "./mint.js";
import type { Bot } from "grammy";

const POLL_INTERVAL_MS = 60_000; // 1 minute
const MINT_COOLDOWN_MS = 5 * 60_000; // 5 minutes per contract per user

const lastMintTime = new Map<string, number>(); // key: userId-contractAddress

export function startAutoMintLoop(bot: Bot) {
  console.log("🔄 Auto-mint polling loop started (60s interval)");

  const interval = setInterval(async () => {
    try {
      await runAutoMintCycle(bot);
    } catch (error) {
      console.error("Auto-mint cycle error:", error);
    }
  }, POLL_INTERVAL_MS);

  return () => clearInterval(interval);
}

async function runAutoMintCycle(bot: Bot) {
  const users = await getAutoMintUsers();
  if (users.length === 0) return;

  for (const user of users) {
    try {
      const contracts = await getWatchlist(user.telegramId);
      if (contracts.length === 0) continue;

      for (const item of contracts) {
        const key = `${user.telegramId}-${item.contractAddress}`;
        const now = Date.now();
        const lastMint = lastMintTime.get(key) || 0;

        if (now - lastMint < MINT_COOLDOWN_MS) continue;

        console.log(`🔄 Auto-minting for user ${user.telegramId} on ${item.contractAddress}`);

        const result = await batchMint(user.telegramId, item.contractAddress);

        // Always notify — including the "nothing was sent" case. Previously a
        // fail-closed batch (0 results) silently produced no message at all.
        lastMintTime.set(key, now);

        let message: string;
        if (result.results.length === 0) {
          message =
            `⏭️ **Auto-Mint Skipped**\n\n` +
            `Contract: \`${item.contractAddress}\`\n` +
            `Reason: ${result.abortReason ?? "no result returned"}`;
        } else {
          message = `⚡ **Auto-Mint Executed**\n\n`;
          message += `Contract: \`${item.contractAddress}\`\n`;
          message += `✅ Success: ${result.totalSuccess}\n`;
          message += `❌ Failed: ${result.totalFailed}\n\n`;

          for (const r of result.results) {
            const icon = r.success ? "✅" : "❌";
            message += `${icon} ${r.label}: ${shortenAddr(r.walletAddress)}`;
            if (r.basescanUrl) message += ` — [TX](${r.basescanUrl})`;
            if (r.error) message += ` — ${r.error}`;
            message += `\n`;
          }
        }

        try {
          await bot.api.sendMessage(user.telegramId.toString(), message, {
            parse_mode: "Markdown",
            link_preview_options: { is_disabled: true },
          });
        } catch (e) {
          console.error(`Failed to notify user ${user.telegramId}:`, e);
        }
      }
    } catch (error) {
      console.error(`Auto-mint error for user ${user.telegramId}:`, error);
    }
  }
}

function shortenAddr(addr: string): string {
  if (!addr || addr.length <= 8) return addr;
  return `${addr.slice(0, 6)}..${addr.slice(-4)}`;
}
