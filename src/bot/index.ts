import { Bot } from "grammy";
import { handleCallback, handleText } from "./handlers.js";
import { backToMainKeyboard } from "./keyboards.js";
import { whoisCommand, bypassCommand, bypassCallback } from "./command.js";

export function createBot(): Bot {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN is not set in environment variables");

  const bot = new Bot(token);

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "👋 Welcome to Freemint-Bot!\n\n" +
        "I scan Base-chain NFT contracts for free mints, audit security, " +
        "bypass mint gates and track your portfolio.\n\n" +
        "Commands:\n" +
        "/whois <contract> — contract intelligence report\n" +
        "/bypass <contract> — run the bypass engine\n\n" +
        "Use the menu below to get started.",
      { reply_markup: backToMainKeyboard() }
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "🤖 Freemint-Bot help\n\n" +
        "/whois <contract address> — security, verified status, mint functions\n" +
        "/bypass <contract address> — analyze gates & attempt a bypass\n" +
        "/portfolio — view and sell your Base NFTs\n\n" +
        "Tip: after /whois, tap 🚀 Attempt Bypass to run the engine instantly.",
      { reply_markup: backToMainKeyboard() }
    );
  });

  bot.command("whois", (ctx) => whoisCommand(ctx));
  bot.command("bypass", (ctx) => bypassCommand(ctx));

  // Route bypass_* callbacks BEFORE the generic callback handler
  bot.on("callback_query:data", async (ctx, next) => {
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

// Allow running as entrypoint: node src/bot/index.js
const isMain =
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  createBot().start();
}
