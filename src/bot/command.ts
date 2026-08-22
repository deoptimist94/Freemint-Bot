import { Context, InlineKeyboard } from "grammy";
import {
  isValidAddress,
  normalizeAddressInput,
  shortenAddress,
} from "../core/chain.js";
import { runWhois, formatWhoisReport } from "../core/whois.js";
import { executeBypass, BypassResult } from "../core/bypassEngine.js";
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
    await ctx.reply("❌ Invalid contract address. Please send a valid Base (EVM) address.", {
      reply_markup: backToMainKeyboard(),
    });
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
      "❌ Usage: /bypass <contract address>\n\nExample:\n/bypass 0xcd555B393D18c6253CfdDa3Cc591E508D1Ff750E",
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

  const userId = BigInt(ctx.from?.id ?? 0);
  await ctx.reply("⏳ Running bypass engine... This can take up to a minute.");

  try {
    const result = await executeBypass(userId, address);
    await ctx.reply(formatBypassResult(result), {
      reply_markup: backToMainKeyboard(),
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
    if (err instanceof Error && /message is not modified/i.test(err.message)) return;
    await ctx.reply(formatBypassResult(result), {
      reply_markup: backToMainKeyboard(),
    });
  }
}

function formatBypassResult(result: BypassResult): string {
  const lines: string[] = [];
  lines.push("🧪 Bypass Engine Result");
  lines.push("──────────────────────");
  lines.push(`📇 Contract: ${shortenAddress(result.contractAddress)}`);
  lines.push(`🚪 Gate type: ${result.gateType}`);
  lines.push(`🧩 Strategy: ${result.strategyId}`);
  if (result.walletAddress) lines.push(`👛 Wallet: ${shortenAddress(result.walletAddress)}`);
  if (result.txHash) lines.push(`✅ Tx: ${shortenAddress(result.txHash)}`);
  if (result.error) lines.push(`❌ ${result.error}`);
  lines.push(result.success ? "\n✅ Bypass executed successfully!" : "\n⚠️ Bypass could not be executed.");
  return lines.join("\n");
}
