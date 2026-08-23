import type { Context } from "grammy";
import {
  getUserChainSelection,
  setUserChainSelection,
  selectionLabel,
  sanitizeSelection,
  type ChainSelection,
} from "../core/userChain.js";

export function chainKeyboard(selection: ChainSelection): {
  inline_keyboard: {
    text: string;
    callback_data: string;
  }[][];
} {
  const mark = (s: ChainSelection): string => (s === selection ? "✅ " : "");
  return {
    inline_keyboard: [
      [
        {
          text: `${mark("base")}Base ⛽`,
          callback_data: "chain_set_base",
        },
      ],
      [
        {
          text: `${mark("robinhood")}Robinhood Chain 🏹`,
          callback_data: "chain_set_robinhood",
        },
      ],
      [
        {
          text: `${mark("both")}Both chains`,
          callback_data: "chain_set_both",
        },
      ],
      [{ text: "← Back to main menu", callback_data: "main_menu" }],
    ],
  };
}

export async function chainCommand(ctx: Context): Promise<void> {
  const telegramId = BigInt(ctx.from?.id ?? 0);
  const selection = await getUserChainSelection(telegramId);
  await ctx.reply(
    "🌐 Chain selection\n\n" +
      "Choose which chain(s) Freemint-Bot operates on for you:\n" +
      "⛽ Base — full support (scan, audit, bypass, mint, portfolio, sell)\n" +
      "🏹 Robinhood Chain — scanning, watching, minting & portfolio (sell coming soon)\n" +
      "Both — run every action on both chains.\n\n" +
      `Current: ${selectionLabel(selection)}`,
    { reply_markup: chainKeyboard(selection) }
  );
}

export async function chainCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const telegramId = BigInt(ctx.from?.id ?? 0);
  const selection = sanitizeSelection(data.replace("chain_set_", ""));
  await setUserChainSelection(telegramId, selection);
  await ctx.answerCallbackQuery(`Chain set to ${selectionLabel(selection)}`);
  await ctx
    .editMessageReplyMarkup(chainKeyboard(selection))
    .catch(() => undefined);
}
