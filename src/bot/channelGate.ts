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
// getChatMember can query membership.
//
// Failure policy: TRANSIENT API/network errors fail OPEN (bot keeps working),
// but CONFIG errors (chat not found, bot not admin, private channel resolved
// by @username, ...) log a loud [channelGate] CONFIG ERROR line to Railway
// logs. Run /gate_status (owner only) for a one-shot diagnosis.
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

export function getBypassIds(): Set<number> {
  const ids = new Set<number>();
  for (const part of (process.env.GATE_OWNER_IDS ?? "").split(",")) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n > 0) ids.add(n);
  }
  return ids;
}

export function isGateOwner(userId: number): boolean {
  return getBypassIds().has(userId);
}

function statusIsJoined(status: string, isMember?: boolean): boolean {
  return (
    status === "member" ||
    status === "administrator" ||
    status === "creator" ||
    (status === "restricted" && isMember !== false)
  );
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { description?: unknown; message?: unknown };
    if (typeof e.description === "string" && e.description) return e.description;
    if (typeof e.message === "string" && e.message) return e.message;
  }
  return typeof err === "string" ? err : String(err ?? "unknown error");
}

function classifyError(msg: string): "config" | "transient" {
  if (
    /chat not found|user not found|not found|CHAT_ADMIN_REQUIRED|bot.*(kicked|was kicked)|username|forbidden|can't (find|access|use)|deactivated|400|migrated/i.test(
      msg
    )
  ) {
    return "config";
  }
  return "transient";
}

export function resolveChatId(chatId: string): string | number {
  return /^-?\d+$/.test(chatId) ? Number(chatId) : chatId;
}

async function checkMembership(
  ctx: Context,
  userId: number
): Promise<{ joined: boolean; detail: string }> {
  const config = getGateConfig();
  if (!config) return { joined: true, detail: "gate disabled" };
  try {
    const member = await ctx.api.getChatMember(
      resolveChatId(config.chatId),
      userId
    );
    const joined = statusIsJoined(
      member.status,
      (member as { is_member?: boolean }).is_member
    );
    return { joined, detail: member.status };
  } catch (err) {
    const msg = errorMessage(err);
    const kind = classifyError(msg);
    if (kind === "config") {
      console.error(
        "[channelGate] CONFIG ERROR — gate is NOT enforcing. Fix REQUIRED_CHANNEL or channel admin setup. Detail:",
        msg
      );
    } else {
      console.error(
        "[channelGate] membership check failed (transient, fail-open):",
        msg
      );
    }
    return { joined: true, detail: `ERROR: ${msg}` };
  }
}

function gatePromptText(inviteLink: string): string {
  return (
    "⛔ **Join our channel first**\n\n" +
    "You must be a member of the channel to use this bot.\n" +
    "Tap **📢 Join Channel**, then come back and hit **✅ I've joined**."
  );
}

async function sendGatePrompt(
  ctx: Context,
  entry: GateCacheEntry
): Promise<void> {
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
  const { joined } = await checkMembership(ctx, userId);
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

export async function gateStatusReport(ctx: Context): Promise<string> {
  const enabled = isGateEnabled();
  const config = getGateConfig();
  const userId = ctx.from?.id ?? 0;
  const lines: string[] = [];
  lines.push("🔐 Gate status");
  lines.push("");
  if (!enabled) {
    lines.push("Gate: DISABLED — REQUIRED_CHANNEL is not set.");
    lines.push("Set REQUIRED_CHANNEL on the service, then Redeploy.");
    return lines.join("\n");
  }
  lines.push(`REQUIRED_CHANNEL: ${config?.chatId ?? "(unset)"}`);
  lines.push(`Invite link in use: ${config?.inviteLink ?? "(none)"}`);
  lines.push(
    `CHANNEL_INVITE_LINK env: ${
      process.env.CHANNEL_INVITE_LINK?.trim() || "not set (using default)"
    }`
  );
  lines.push(
    `GATE_OWNER_IDS env: ${process.env.GATE_OWNER_IDS?.trim() || "not set"}`
  );
  lines.push("");
  if (!userId) {
    lines.push("No Telegram user id on this update.");
    return lines.join("\n");
  }
  lines.push(`You: ${userId}`);
  const res = await checkMembership(ctx, userId);
  if (res.detail.startsWith("ERROR:")) {
    lines.push(`Membership check: ❌ ${res.detail.slice(6)}`);
    lines.push("");
    lines.push("Most likely fixes:");
    lines.push("1. Public channel: the bot must be an ADMIN of the channel (Manage Channel → Administrators).");
    lines.push("2. Private channel: REQUIRED_CHANNEL must be the NUMERIC id (e.g. -1001234567890), NOT @username, and CHANNEL_INVITE_LINK must be a t.me/+ invite link.");
    lines.push("3. Get the numeric id: forward any channel message to @userinfobot.");
  } else {
    lines.push(
      `Membership check: ${res.joined ? "✅ joined" : "❌ not joined"} (status: ${res.detail})`
    );
    if (res.joined) {
      lines.push("Note: this account is a member/admin of the channel, so the gate lets it through. Test with an account that has never joined.");
    }
  }
  return lines.join("\n");
}

export function channelGateMiddleware(): (
  ctx: Context,
  next: NextFunction
) => Promise<void> {
  return async (ctx, next) => {
    if (!isGateEnabled()) return next();

    const userId = ctx.from?.id;
    if (userId === undefined) return next();

    if (isGateOwner(userId)) return next();

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

    const { joined } = await checkMembership(ctx, userId);
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
