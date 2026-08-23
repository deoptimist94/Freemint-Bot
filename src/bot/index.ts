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
import { chainCommand, chainCallback } from "./chainCommand.js";
import {
  channelGateMiddleware,
  gateStatusReport,
  isGateOwner,
} from "./channelGate.js";
import { getBotStats, formatStatsLine } from "../core/stats.js";
import { ensureUser } from "../core/wallet.js";
import { withChainContext } from "../core/chainContext.js";
import { getUserChainSelection } from "../core/userChain.js";
import type { ChainId } from "../core/chains.js";

export function createBot(): Bot {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN is not set in environment variables");

  const bot = new Bot(token);

  // Channel membership gate — registered FIRST so it runs before every
  // command/handler and blocks non-members from using the bot at all.
  // No-op when REQUIRED_CHANNEL is not set.
  bot.use(channelGateMiddleware());

  // Resolve the user's /chain preference for every update and run the whole
  // update inside that chain context, so scan/whois/bypass/watch/portfolio
  // all operate on the chosen chain without touching their call sites.
  // NOTE: "both" currently executes on Base (primary). True dual-chain
  // stacking (scan/whois on both, one watcher per chain, per-chain portfolio
  // grouping) lands in the next update — it needs the action-layer wiring.
  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (fromId === undefined) {
      await next();
      return;
    }
    try {
      const selection = await getUserChainSelection(BigInt(fromId));
      const chain: ChainId =
        selection === "robinhood" ? "robinhood" : "base";
      await withChainContext(chain, () => next());
    } catch (err) {
      console.error("Chain context error:", err);
      await next();
    }
  });

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
        "I scan Base & Robinhood Chain NFT contracts for free mints, audit security, " +
        "bypass mint gates and track your portfolio.\n\n" +
        "Commands:\n" +
        "/chain — choose Base / Robinhood / Both chains\n" +
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
        "/chain — pick which chain(s) you operate on (Base / Robinhood / Both)\n" +
        "/whois <contract address> — security, verified status, mint functions\n" +
        "/bypass <contract address> — analyze gates & attempt a bypass\n" +
        "/bypass <contract> --watch — poll-and-fire FCFS mint watcher\n" +
        "/portfolio — view and sell your NFTs\n" +
        "/guide — full user guide with examples\n\n" +
        "Tip: after /whois, tap 🚀 Attempt Bypass to run the engine instantly.",
      { reply_markup: backToMainKeyboard() }
    );
  });

  bot.command("guide", (ctx) => guideCommand(ctx));
  bot.command("chain", (ctx) => chainCommand(ctx));
  bot.command("whois", (ctx) => whoisCommand(ctx));
  bot.command("bypass", (ctx) => bypassCommand(ctx));
  bot.command("portfolio", async (ctx) => {
    const telegramId = BigInt(ctx.from?.id ?? 0);
    await showPortfolio(ctx, telegramId);
  });

  // Owner-only diagnostic for the channel gate (see channelGate.ts).
  bot.command("gate_status", async (ctx) => {
    const userId = ctx.from?.id ?? 0;
    if (!isGateOwner(userId)) {
      await ctx
        .reply(
          "🔒 /gate_status is restricted to the bot owner.\nAdd your Telegram user id to GATE_OWNER_IDS and redeploy."
        )
        .catch(() => undefined);
      return;
    }
    const report = await gateStatusReport(ctx);
    await ctx.reply(report).catch(() => undefined);
  });

  bot.on("callback_query:data", async (ctx, next) => {
    if (ctx.callbackQuery.data.startsWith("chain_set_")) {
      await chainCallback(ctx);
      return;
    }
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
