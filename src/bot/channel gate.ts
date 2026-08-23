// src/bot/channelGate.ts
// Optional hard gate: users must be members of REQUIRED_CHANNEL before they
// can use the bot. Fully disabled unless REQUIRED_CHANNEL is set.
//
// Env vars:
//   REQUIRED_CHANNEL     - "@channel_username" or numeric chat id (e.g. -1001234567890)
//   CHANNEL_INVITE_LINK  - join URL shown on the gate button. For private
//                          channels use the t.me/+<hash> invite link.
//                          Defaults to https://t.me/<name> when unset.
//   GATE_OWNER_IDS       - optional comma-separated Telegram user ids that
//                          bypass the gate (e.g. bot owner, for testing).
//
// Setup: add the bot as an ADMINISTRATOR of the channel (no rights needed) so
// getChatMember can query membership. If the bot can't reach the channel, the
// gate fails OPEN (logs a warning) so a misconfig never bricks the bot.
import type { Context, NextFunction } from "grammy";
import { backToMainKeyboard } from "./keyboards.js";

const GATE_CHECK_CB = "gate_check";

const MEMBERSHIP_TTL_MS = 5 * 60 * 1000; // re-check membership every 5 min
const PROMPT_COOLDOWN_MS = 60 * 1000; // don't spam the gate prompt

interface GateCacheEntry {
  joined: boolean;
  at: number;
  promptedAt: number;
}

const gateCache = new Map<number, GateCacheEntry>();

function isGateEnabled(): boolean {
  return !!process.env.REQUIRED_CHANNEL?.trim();
}

function getGateConfig(): { chatId: string; inviteLink: string } | null {
  const chatId = process.env.REQUIRED_CHANNEL?.trim();
  if (!chatId) return null;
  let inviteLink = process.env.CHANNEL_INVITE_LINK?.trim() ?? "";
  if (!inviteLink) {
    const name = chatId.startsWith("@") ? chatId.slice(1) : chatId;
    inviteLink = `https://t.me/${name}`;
  }
  return { chatId, inviteLink };
}

function getBypassIds(): Set<number> {
  const ids = new Set<number>();
  for (const part of (process.env.GATE_OWNER_IDS ?? "").split(",")) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n > 0) ids.add(n);
  }
  return ids;
}

function statusIsJoined(status: string, isMember?: boolean): boolean {
  return (
    status === "member" ||
    status === "administrator" ||
    status === "creator" ||
    (status === "restricted" && isMember !== false)
  );
}

async function checkMembership(ctx: Context, userId: number): Promise<boolean> {
  const config = getGateConfig();
  if (!config) return true;
  const chatId = /^-?\d+$/.test(config.chatId)
    ? Number(config.chatId)
    : config.chatId;
  try {
    const member = await ctx.api.getChatMember(chatId, userId);
    return statusIsJoined(
      member.status,
      (member as { is_member?: boolean }).is_member
    );
  } catch (err) {
    // Fail-open on API/network errors so a hiccup never bricks the bot.
    // If this logs repeatedly, verify the bot is an admin of the channel.
    console.error(
      "[channelGate] membership check failed (fail-open):",
      err
    );
    return true;
  }
}

function gatePromptText(inviteLink: string): string {
  return (
    "⛔ **Join our channel first**\n\n" +
    "You must be a member of the channel to use this bot.\n" +
    "Tap **📢 Join Channel**, then come back and hit **✅ I've joined**."
  );
}

async function sendGatePrompt(ctx: Context, entry: GateCacheEntry): Promise<void> {
  const config = getGateConfig();
  if (!config) return;
  entry.promptedAt = Date.now();
  const replyMarkup = {
    inline_keyboard: [
      [{ text: "📢 Join Channel", url: config.inviteLink }],
      [{ text: "✅ I've joined", callback_data: GATE_CHECK_CB }],
    ],
  };
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery().catch(() => undefined);
  }
  await ctx
    .reply(gatePromptText(config.inviteLink), {
      reply_markup: replyMarkup,
      parse_mode: "Markdown",
    })
    .catch(() => undefined);
}

async function handleGateCheck(ctx: Context, userId: number): Promise<void> {
  const joined = await checkMembership(ctx, userId);
  const now = Date.now();
  gateCache.set(userId, { joined, at: now, promptedAt: now });
  if (joined) {
    await ctx
      .answerCallbackQuery({ text: "✅ Access granted — welcome!" })
      .catch(() => undefined);
    await ctx
      .reply(
        "✅ **You're in!** Access granted — use the menu below to get started.",
        { reply_markup: backToMainKeyboard(), parse_mode: "Markdown" }
      )
      .catch(() => undefined);
    return;
  }
  await ctx
    .answerCallbackQuery({ text: "❌ Still not a member — tap Join Channel first." })
    .catch(() => undefined);
}

export function isGateCallback(data: string): boolean {
  return data === GATE_CHECK_CB;
}

export function channelGateMiddleware(): (
  ctx: Context,
  next: NextFunction
) => Promise<void> {
  return async (ctx, next) => {
    if (!isGateEnabled()) return next();

    const userId = ctx.from?.id;
    if (userId === undefined) return next();

    if (getBypassIds().has(userId)) return next();

    const cbData = ctx.callbackQuery?.data;
    if (cbData && isGateCallback(cbData)) {
      await handleGateCheck(ctx, userId);
      return;
    }

    const now = Date.now();
    const cached = gateCache.get(userId);
    if (cached && now - cached.at < MEMBERSHIP_TTL_MS) {
      if (cached.joined) return next();
      if (now - cached.promptedAt < PROMPT_COOLDOWN_MS) {
        if (ctx.callbackQuery) {
          await ctx
            .answerCallbackQuery({ text: "⛔ Join our channel first" })
            .catch(() => undefined);
        }
        return;
      }
      await sendGatePrompt(ctx, cached);
      return;
    }

    const joined = await checkMembership(ctx, userId);
    const entry: GateCacheEntry = {
      joined,
      at: now,
      promptedAt: cached?.promptedAt ?? 0,
    };
    gateCache.set(userId, entry);
    if (joined) return next();
    await sendGatePrompt(ctx, entry);
  };
}
