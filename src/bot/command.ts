import { Context, InlineKeyboard } from "grammy";
import {
  isValidAddress,
  normalizeAddressInput,
  shortenAddress,
} from "../core/chain.js";
import { runWhois, formatWhoisReport } from "../core/whois.js";
import { executeBypass } from "../core/bypassEngine.js";
import type { BypassResult } from "../core/bypassEngine.js";
import { startWatchMint, stopWatch } from "../core/watchMint.js";
import { backToMainKeyboard } from "./keyboards.js";

export async function whoisCommand(ctx: Context): Promise<void> {
  const parts = (ctx.message?.text ?? "").trim().split(/\s+/);
  const raw = parts[1];

  if (!raw) {
    await ctx.reply(
      "❌ Usage: /whois <contract address>\n\nExample:\n/whois 0xcd555B393D18c6253CfdDa3Cc591E508D1Ff750E",
      { reply_markup: backToMainKeyboard() }
    );
    return;
  }

  const address = normalizeAddressInput(raw);
  if (!address || !isValidAddress(address)) {
    await ctx.reply(
      "❌ Invalid contract address. Please send a valid Base (EVM) address.",
      { reply_markup: backToMainKeyboard() }
    );
    return;
  }

  await ctx.reply("🔍 Running WHOIS on contract...");
  try {
    const report = await runWhois(address);
    await ctx.reply(formatWhoisReport(report), {
      reply_markup: new InlineKeyboard()
        .text("🚀 Attempt Bypass", `bypass_${report.contractAddress}`)
        .row()
        .text("🏠 Main Menu", "main_menu"),
    });
  } catch (err) {
    await ctx.reply(
      `❌ WHOIS failed: ${err instanceof Error ? err.message : String(err)}`,
      { reply_markup: backToMainKeyboard() }
    );
  }
}

export async function bypassCommand(ctx: Context): Promise<void> {
  const parts = (ctx.message?.text ?? "").trim().split(/\s+/);
  const raw = parts[1];

  if (!raw) {
    await ctx.reply(
      "❌ Usage: /bypass <contract address> [flags]\n\n" +
        "Flags:\n" +
        "--dry — simulate only, no transaction\n" +
        "--probe — map contract state & mint surface\n" +
        "--schedule — arm auto-mint at the public window\n" +
        "--watch — poll-and-fire: fire instantly when the mint opens (FCFS)\n" +
        "--stop — stop active watcher(s) for this contract\n\n" +
        "Examples:\n" +
        "/bypass 0xcd555B393D18c6253CfdDa3Cc591E508D1Ff750E --dry\n" +
        "/bypass 0xcd555B393D18c6253CfdDa3Cc591E508D1Ff750E --probe\n" +
        "/bypass 0xcd555B393D18c6253CfdDa3Cc591E508D1Ff750E --probe --schedule\n" +
        "/bypass 0xcd555B393D18c6253CfdDa3Cc591E508D1Ff750E --watch",
      { reply_markup: backToMainKeyboard() }
    );
    return;
  }

  const address = normalizeAddressInput(raw);
  if (!address || !isValidAddress(address)) {
    await ctx.reply("❌ Invalid contract address.", {
      reply_markup: backToMainKeyboard(),
    });
    return;
  }

  const flags = parts.slice(2);
  const dryRun = flags.includes("--dry") || flags.includes("--simulate");
  const probeOnly = flags.includes("--probe");
  const schedule = flags.includes("--schedule");
  const watch = flags.includes("--watch");
  const stop = flags.includes("--stop");
  const userId = BigInt(ctx.from?.id ?? 0);

  if (stop) {
    const stopped = stopWatch(userId, address);
    await ctx.reply(
      stopped > 0
        ? `⏹ Stopped ${stopped} watcher(s) for ${shortenAddress(address)}.`
        : `ℹ️ No active watcher for ${shortenAddress(address)}.`,
      { reply_markup: backToMainKeyboard() }
    );
    return;
  }

  if (watch) {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) {
      await ctx.reply("❌ Could not resolve chat to send watch updates.", {
        reply_markup: backToMainKeyboard(),
      });
      return;
    }
    const stopKeyboard = () =>
      new InlineKeyboard()
        .text("⏹ Stop Watching", `watch_stop_${address}`)
        .row()
        .text("🏠 Main Menu", "main_menu");

    await ctx.reply(
      "👀 Watch mode armed — polling the contract every 2.5s.\n\n" +
        "The engine will fire the instant the mint opens (FCFS).\n" +
        "Progress updates will be posted here. Use the ⏹ button or /bypass <addr> --stop to cancel.",
      { reply_markup: stopKeyboard() }
    );

    startWatchMint({
      userId,
      rawAddress: address,
      notify: (msg) =>
        ctx.api
          .sendMessage(chatId, msg, { reply_markup: stopKeyboard() })
          .then(() => undefined)
          .catch(() => undefined),
    }).catch((err) =>
      ctx.api
        .sendMessage(
          chatId,
          `❌ Watch error: ${err instanceof Error ? err.message : String(err)}`,
          { reply_markup: backToMainKeyboard() }
        )
        .catch(() => undefined)
    );
    return;
  }

  const statusLine = probeOnly
    ? "🧪 PROBE MODE — mapping contract state & mint surface. No transaction will be sent..."
    : dryRun
      ? "🧪 DRY RUN — simulating only, no transaction will be sent..."
      : "⏳ Running bypass engine... This can take up to a minute.";
  await ctx.reply(statusLine);

  try {
    const result = await executeBypass(userId, address, { dryRun, probeOnly });

    let text = formatBypassResult(result);
    if (schedule) {
      const armed = armAutoMint(ctx, userId, address, result);
      if (armed) {
        text +=
          `\n\n🔔 Auto-mint armed — the engine will fire at the public window and report the outcome here.\n` +
          `🧾 Job ID: ${armed.id}`;
      } else {
        text +=
          `\n\n⏰ No usable public window was detected — nothing armed. ` +
          `Run --probe first to inspect state.`;
      }
    }

    // Plain text only — never parse_mode Markdown (probe/error strings break entities).
    await ctx.reply(text, { reply_markup: backToMainKeyboard() });
  } catch (err) {
    await ctx.reply(
      `❌ Bypass engine error: ${err instanceof Error ? err.message : String(err)}`,
      { reply_markup: backToMainKeyboard() }
    );
  }
}

export async function bypassCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const address = normalizeAddressInput(data.replace(/^bypass_/, ""));
  if (!address || !isValidAddress(address)) {
    await ctx.answerCallbackQuery({ text: "❌ Invalid address in callback" });
    return;
  }

  const userId = BigInt(ctx.from?.id ?? 0);
  await ctx.answerCallbackQuery({ text: "⏳ Running bypass engine..." });
  const progress = await ctx.reply("⏳ Bypass engine running...");

  let result: BypassResult;
  try {
    result = await executeBypass(userId, address);
  } catch (err) {
    result = {
      success: false,
      contractAddress: address,
      gateType: "unknown",
      strategyId: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const text = formatBypassResult(result);
  const chatId = ctx.callbackQuery?.message?.chat?.id;
  if (chatId === undefined) {
    await ctx.reply(text, { reply_markup: backToMainKeyboard() });
    return;
  }

  try {
    await ctx.api.editMessageText(chatId, progress.message_id, text, {
      reply_markup: backToMainKeyboard(),
    });
  } catch (err) {
    if (err instanceof Error && /message is not modified/i.test(err.message)) {
      return;
    }
    await ctx.reply(text, { reply_markup: backToMainKeyboard() });
  }
}

export async function watchStopCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const address = normalizeAddressInput(data.replace(/^watch_stop_/, ""));
  if (!address || !isValidAddress(address)) {
    await ctx.answerCallbackQuery({ text: "❌ Invalid address in callback" });
    return;
  }

  const userId = BigInt(ctx.from?.id ?? 0);
  const stopped = stopWatch(userId, address);
  await ctx.answerCallbackQuery({
    text: stopped > 0 ? "⏹ Watcher stopped" : "No active watcher",
  });

  const msg = ctx.callbackQuery?.message;
  if (msg) {
    try {
      await ctx.api.editMessageText(
        msg.chat.id,
        msg.message_id,
        stopped > 0
          ? `⏹ Watcher stopped for ${shortenAddress(address)}.`
          : `ℹ️ No active watcher for ${shortenAddress(address)}.`,
        { reply_markup: backToMainKeyboard() }
      );
    } catch {
      // message already gone or not modified — ignore
    }
  }
}

interface ScheduledJob {
  id: string;
  userId: bigint;
  address: string;
  chatId: number;
  fireAt: number;
  timer: NodeJS.Timeout;
}

const scheduledJobs = new Map<string, ScheduledJob>();
const MAX_JOBS = 50;
const MIN_DELAY_MS = 10_000;
const MAX_DELAY_MS = 48 * 60 * 60 * 1000;

function armAutoMint(
  ctx: Context,
  userId: bigint,
  address: string,
  result: BypassResult
): { id: string } | null {
  const at = result.publicMintAt;
  if (!at) return null;
  const now = Date.now();
  const delay = at.atMs - now;
  if (delay < MIN_DELAY_MS || delay > MAX_DELAY_MS) return null;
  if (scheduledJobs.size >= MAX_JOBS) return null;

  const chatId = ctx.chat?.id ?? 0;
  if (!chatId) return null;

  const id = `jm_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const timer = setTimeout(async () => {
    scheduledJobs.delete(id);
    try {
      const fireResult = await executeBypass(userId, address);
      await ctx.api
        .sendMessage(
          chatId,
          `🔔 Scheduled mint fired\n\n${formatBypassResult(fireResult)}`
        )
        .catch(() => undefined);
    } catch (err) {
      await ctx.api
        .sendMessage(
          chatId,
          `❌ Scheduled mint failed: ${err instanceof Error ? err.message : String(err)}`
        )
        .catch(() => undefined);
    }
  }, delay);

  scheduledJobs.set(id, { id, userId, address, chatId, fireAt: at.atMs, timer });
  return { id };
}

function formatBypassResult(result: BypassResult): string {
  const lines: string[] = [];
  lines.push("🧪 Bypass Engine Result");
  lines.push("──────────────────────");
  lines.push(`📇 Contract: ${shortenAddress(result.contractAddress)}`);
  lines.push(`🚪 Gate type: ${result.gateType}`);
  lines.push(`🧩 Strategy: ${result.strategyId}`);
  if (result.state && result.state !== result.gateType) {
    lines.push(`🔎 On-chain state: ${result.state}`);
  }
  if (result.walletAddress) {
    lines.push(`👛 Wallet: ${shortenAddress(result.walletAddress)}`);
  }
  if (result.txHash) {
    lines.push(`✅ Tx: ${shortenAddress(result.txHash)}`);
  }
  if (result.publicMintAt) {
    lines.push(`⏰ Public window: ${result.publicMintAt.label}`);
  }
  if (result.probe && result.probe.length > 0) {
    lines.push(`🔍 Probe (${result.probe.length} view reads):`);
    for (const row of result.probe.slice(0, 10)) {
      lines.push(`   • ${row.name} = ${String(row.value).slice(0, 60)}`);
    }
    if (result.probe.length > 10) {
      lines.push(`   …and ${result.probe.length - 10} more`);
    }
  }
  if (result.error) lines.push(`❌ ${result.error}`);
  if (result.probeOnly) {
    lines.push("\n🧪 PROBE MODE — state mapped. No transaction was sent.");
    lines.push(
      "Run /bypass <addr> --dry to simulate, or --probe --schedule to arm the window."
    );
  } else if (result.dryRun) {
    lines.push("\n🧪 DRY RUN — simulation only. No transaction was sent.");
    lines.push("Run without --dry to actually mint.");
  }
  lines.push(
    result.success
      ? "\n✅ Bypass executed successfully!"
      : "\n⚠️ Bypass could not be executed."
  );
  return lines.join("\n");
}
