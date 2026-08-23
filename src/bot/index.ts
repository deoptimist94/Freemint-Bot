import { Bot } from "grammy";
import { handleCallback, handleText, showPortfolio } from "./handlers.js";
import { backToMainKeyboard } from "./keyboards.js";
import {
  whoisCommand,
  bypassCommand,
  bypassCallback,
  watchStopCallback,
  guideCommand,
} from "./command.js";
import { getBotStats, formatStatsLine } from "../core/stats.js";
import { ensureUser } from "../core/wallet.js";

export function createBot(): Bot {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN is not set in environment variables");

  const bot = new Bot(token);

  bot.command("start", async (ctx) => {
    const telegramId = BigInt(ctx.from?.id ?? 0);
    await ensureUser(telegramId).catch((err) =>
      console.error("ensureUser error:", err)
    );

    let statsLine = "";
    try {
      const stats = await getBotStats();
      statsLine = `\n\n📊 ${formatStatsLine(stats)}`;
    } catch (err) {
      console.error("Stats error:", err);
    }

    await ctx.reply(
      "👋 Welcome to Freemint-Bot!\n\n" +
        "I scan Base-chain NFT contracts for free mints, audit security, " +
        "bypass mint gates and track your portfolio.\n\n" +
        "Commands:\n" +
        "/whois <contract> — contract intelligence report\n" +
        "/bypass <contract> — run the bypass engine\n" +
        "/portfolio — view NFTs across your wallets\n" +
        "/guide — full user guide\n\n" +
        "Use the menu below to get started." +
        statsLine,
      { reply_markup: backToMainKeyboard() }
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "🤖 Freemint-Bot help\n\n" +
        "/whois <contract address> — security, verified status, mint functions\n" +
        "/bypass <contract address> — analyze gates & attempt a bypass\n" +
        "/bypass <contract> --watch — poll-and-fire FCFS mint watcher\n" +
        "/portfolio — view and sell your Base NFTs\n" +
        "/guide — full user guide with examples\n\n" +
        "Tip: after /whois, tap 🚀 Attempt Bypass to run the engine instantly.",
      { reply_markup: backToMainKeyboard() }
    );
  });

  bot.command("guide", (ctx) => guideCommand(ctx));
  bot.command("whois", (ctx) => whoisCommand(ctx));
  bot.command("bypass", (ctx) => bypassCommand(ctx));
  bot.command("portfolio", async (ctx) => {
    const telegramId = BigInt(ctx.from?.id ?? 0);
    await showPortfolio(ctx, telegramId);
  });

  bot.on("callback_query:data", async (ctx, next) => {
    if (ctx.callbackQuery.data.startsWith("watch_stop_")) {
      await watchStopCallback(ctx);
      return;
    }
    if (ctx.callbackQuery.data.startsWith("bypass_")) {
      await bypassCallback(ctx);
      return;
    }
    await next();
  });
  bot.on("callback_query:data", handleCallback);
  bot.on("message:text", handleText);

  bot.catch((err) => {
    console.error("Bot error:", err);
  });

  return bot;
}
