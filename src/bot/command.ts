import { Context, InlineKeyboard } from "grammy";
import {
  isValidAddress,
  normalizeAddressInput,
  shortenAddress,
} from "../core/chain.js";
import { runWhois, formatWhoisReport } from "../core/whois.js";
import { executeBypass } from "../core/bypassEngine.js";
import type { BypassResult } from "../core/bypassEngine.js";
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
      "❌ Usage: /bypass <contract address> [--dry] [--probe] [--schedule]\n\n" +
        "--dry: simulate only, no transaction is sent.\n" +
        "--probe: map contract state & mint surface (no transaction).\n" +
        "--schedule: arm an auto-mint at the detected public window.\n\n" +
        "Examples:\n" +
        "/bypass 0xcd555B393D18c6253CfdDa3Cc591E508D1Ff750E --dry\n" +
        "/bypass 0xcd555B393D18c6253CfdDa3Cc591E508D1Ff750E --probe\n" +
        "/bypass 0xcd555B393D18c6253CfdDa3Cc591E508D1Ff750E --probe --schedule",
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

  const userId = BigInt(ctx.from?.id ?? 0);
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
          `\n\n🔔 **Auto-mint armed** — the engine will fire at the public window and report the outcome here.\n` +
          `🧾 Job ID: \`${armed.id}\``;
      } else {
        text +=
          `\n\n⏰ No usable public window was detected — nothing armed. ` +
          `Run \`--probe\` first to inspect state.`;
      }
    }

    await ctx.reply(text, {
      reply_markup: backToMainKeyboard(),
      parse_mode: "Markdown",
    });
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

  const chatId = ctx.callbackQuery?.message?.chat?.id;
  if (chatId === undefined) {
    await ctx.reply(formatBypassResult(result), {
      reply_markup: backToMainKeyboard(),
    });
    return;
  }

  try {
    await ctx.api.editMessageText(
      chatId,
      progress.message_id,
      formatBypassResult(result),
      { reply_markup: backToMainKeyboard() }
    );
  } catch (err) {
    // Telegram 400 "message is not modified" — safe to ignore
    if (err instanceof Error && /message is not modified/i.test(err.message)) {
      return;
    }
    await ctx.reply(formatBypassResult(result), {
      reply_markup: backToMainKeyboard(),
    });
  }
}

// ---------------------------------------------------------------------------
// Auto-mint scheduler (in-memory)
// ---------------------------------------------------------------------------
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
const MIN_DELAY_MS = 10_000; // never fire sooner than 10s after arming
const MAX_DELAY_MS = 48 * 60 * 60 * 1000; // never wait longer than 48h

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
          `🔔 **Scheduled mint fired**\n\n${formatBypassResult(fireResult)}`,
          { parse_mode: "Markdown" }
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
      lines.push(`   • ${row.name} = \`${String(row.value).slice(0, 60)}\``);
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
