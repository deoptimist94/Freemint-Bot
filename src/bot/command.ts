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
import { withChainContext } from "../core/chainContext.js";
import {
  getUserChainSelection,
  sanitizeSelection,
  getChainsForSelection,
  getPrimaryChain,
  chainBadge,
  chainLabel,
  type ChainSelection,
} from "../core/userChain.js";
import type { ChainId } from "../core/chains.js";
import { backToMainKeyboard } from "./keyboards.js";

// --chain=base|robinhood|both — parsed from anywhere in the command line, so
// both `/bypass <addr> --chain=robinhood` and flag-first order work.
function parseChainFlag(parts: string[]): ChainSelection | undefined {
  const flag = parts.find((p) => p.startsWith("--chain="));
  if (!flag) return undefined;
  return sanitizeSelection(flag.slice("--chain=".length));
}

export async function whoisCommand(ctx: Context): Promise<void> {
  const parts = (ctx.message?.text ?? "").trim().split(/\s+/);
  const raw = parts.slice(1).find((p) => !p.startsWith("--"));

  if (!raw) {
    await ctx.reply(
      "❌ Usage: /whois <contract address> [--chain=base|robinhood|both]\n\n" +
        "Examples:\n" +
        "/whois 0xcd555B393D18c6253CfdDa3Cc591E508D1Ff750E\n" +
        "/whois 0xcd555B393D18c6253CfdDa3Cc591E508D1Ff750E --chain=robinhood",
      { reply_markup: backToMainKeyboard() }
    );
    return;
  }

  const address = normalizeAddressInput(raw);
  if (!address || !isValidAddress(address)) {
    await ctx.reply(
      "❌ Invalid contract address. Please send a valid EVM address.",
      { reply_markup: backToMainKeyboard() }
    );
    return;
  }

  const userId = BigInt(ctx.from?.id ?? 0);
  const selection = parseChainFlag(parts) ?? (await getUserChainSelection(userId));
  const chains = getChainsForSelection(selection);

  await ctx.reply("🔍 Running WHOIS on contract...");
  try {
    const reports: { chain: ChainId; report: Awaited<ReturnType<typeof runWhois>> }[] = [];
    for (const chain of chains) {
      const report = await withChainContext(chain, () => runWhois(address));
      reports.push({ chain, report });
    }

    let body: string;
    if (reports.length === 1) {
      body = formatWhoisReport(reports[0].report);
    } else {
      body = reports
        .map(
          ({ chain, report }) =>
            `🔗 ${chainBadge(chain)} ${chainLabel(chain)}\n\n${formatWhoisReport(report)}`
        )
        .join("\n\n─────\n\n");
    }

    const kb = new InlineKeyboard();
    for (const { chain, report } of reports) {
      kb.text(
        reports.length > 1
          ? `🚀 Attempt Bypass ${chainBadge(chain)} ${chainLabel(chain)}`
          : "🚀 Attempt Bypass",
        `bypass_${report.contractAddress}_${chain}`
      );
    }
    kb.row().text("🏠 Main Menu", "main_menu");
    await ctx.reply(body, { reply_markup: kb });
  } catch (err) {
    await ctx.reply(
      `❌ WHOIS failed: ${err instanceof Error ? err.message : String(err)}`,
      { reply_markup: backToMainKeyboard() }
    );
  }
}

export async function bypassCommand(ctx: Context): Promise<void> {
  const parts = (ctx.message?.text ?? "").trim().split(/\s+/);
  const raw = parts.slice(1).find((p) => !p.startsWith("--"));

  if (!raw) {
    await ctx.reply(
      "❌ Usage: /bypass <contract address> [flags]\n\n" +
        "Flags:\n" +
        "--dry — simulate only, no transaction\n" +
        "--probe — map contract state & mint surface\n" +
        "--schedule — arm auto-mint at the public window\n" +
        "--watch — poll-and-fire: fire instantly when the mint opens (FCFS)\n" +
        "--stop — stop active watcher(s) for this contract\n" +
        "--chain=base|robinhood|both — run on specific network(s); default: your /chain selection\n\n" +
        "Examples:\n" +
        "/bypass 0xcd555B393D18c6253CfdDa3Cc591E508D1Ff750E --dry\n" +
        "/bypass 0xcd555B393D18c6253CfdDa3Cc591E508D1Ff750E --chain=robinhood --dry\n" +
        "/bypass 0xcd555B393D18c6253CfdDa3Cc591E508D1Ff750E --chain=both --watch",
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

  const flags = parts.slice(1).filter((p) => p.startsWith("--"));
  const dryRun = flags.includes("--dry") || flags.includes("--simulate");
  const probeOnly = flags.includes("--probe");
  const schedule = flags.includes("--schedule");
  const watch = flags.includes("--watch");
  const stop = flags.includes("--stop");
  const userId = BigInt(ctx.from?.id ?? 0);

  const selection = parseChainFlag(parts) ?? (await getUserChainSelection(userId));
  const chains = getChainsForSelection(selection);

  if (stop) {
    // --stop kills the watcher(s) for this contract on every chain.
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

    const watchTargets = chains
      .map((c) => `${chainBadge(c)} ${chainLabel(c)}`)
      .join(", ");
    await ctx.reply(
      `👀 Watch mode armed — polling ${chains.length > 1 ? watchTargets : "the contract"} every 2.5s.\n\n` +
        "The engine will fire the instant the mint opens (FCFS).\n" +
        "Progress updates will be posted here. Use the ⏹ button or /bypass <addr> --stop to cancel.",
      { reply_markup: stopKeyboard() }
    );

    for (const chain of chains) {
      startWatchMint({
        userId,
        address,
        chain,
        notify: (msg) =>
          ctx.api
            .sendMessage(chatId, msg, { reply_markup: stopKeyboard() })
            .then(() => undefined)
            .catch(() => undefined),
      }).catch((err) =>
        ctx.api
          .sendMessage(
            chatId,
            `❌ Watch error (${chainLabel(chain)}): ${err instanceof Error ? err.message : String(err)}`,
            { reply_markup: backToMainKeyboard() }
          )
          .catch(() => undefined)
      );
    }
    return;
  }

  const statusLine = probeOnly
    ? "🧪 PROBE MODE — mapping contract state & mint surface. No transaction will be sent..."
    : dryRun
      ? "🧪 DRY RUN — simulating only, no transaction will be sent..."
      : "⏳ Running bypass engine... This can take up to a minute.";
  await ctx.reply(statusLine);

  try {
    const sections: string[] = [];
    for (const chain of chains) {
      const result = await withChainContext(chain, () =>
        executeBypass(userId, address, { dryRun, probeOnly })
      );
      let text = formatBypassResult(result, chain);
      if (schedule) {
        const armed = armAutoMint(ctx, userId, address, chain, result);
        if (armed) {
          text +=
            `\n\n🔔 Auto-mint armed (${chainBadge(chain)} ${chainLabel(chain)}) — the engine will fire at the public window and report the outcome here.\n` +
            `🧾 Job ID: ${armed.id}`;
        } else {
          text +=
            `\n\n⏰ No usable public window was detected (${chainBadge(chain)} ${chainLabel(chain)}) — nothing armed. ` +
            `Run --probe first to inspect state.`;
        }
      }
      sections.push(text);
    }
    const text = sections.join("\n\n─────\n\n");
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
  const rest = data.replace(/^bypass_/, "");
  let address: string;
  let chain: ChainId | undefined;
  if (rest.endsWith("_robinhood")) {
    chain = "robinhood";
    address = rest.slice(0, -11);
  } else if (rest.endsWith("_base")) {
    chain = "base";
    address = rest.slice(0, -5);
  } else {
    chain = undefined;
    address = rest;
  }
  address = normalizeAddressInput(address);
  if (!address || !isValidAddress(address)) {
    await ctx.answerCallbackQuery({ text: "❌ Invalid address in callback" });
    return;
  }

  const userId = BigInt(ctx.from?.id ?? 0);
  if (!chain) {
    // Legacy callback without a chain suffix — use the user's default.
    const selection = await getUserChainSelection(userId);
    chain = getPrimaryChain(selection);
  }

  await ctx.answerCallbackQuery({ text: "⏳ Running bypass engine..." });
  const progress = await ctx.reply("⏳ Bypass engine running...");

  let result: BypassResult;
  try {
    result = await withChainContext(chain, () => executeBypass(userId, address));
  } catch (err) {
    result = {
      success: false,
      contractAddress: address,
      gateType: "unknown",
      strategyId: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const text = formatBypassResult(result, chain);
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
  chain: ChainId;
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
  chain: ChainId,
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
      const fireResult = await withChainContext(chain, () =>
        executeBypass(userId, address)
      );
      await ctx.api
        .sendMessage(
          chatId,
          `🔔 Scheduled mint fired (${chainBadge(chain)} ${chainLabel(chain)})\n\n${formatBypassResult(fireResult, chain)}`
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

  scheduledJobs.set(id, { id, userId, address, chain, chatId, fireAt: at.atMs, timer });
  return { id };
}

function formatBypassResult(result: BypassResult, chain?: ChainId): string {
  const lines: string[] = [];
  lines.push("🧪 Bypass Engine Result");
  lines.push("──────────────────────");
  lines.push(`📇 Contract: ${shortenAddress(result.contractAddress)}`);
  if (chain) {
    lines.push(`🌐 Network: ${chainBadge(chain)} ${chainLabel(chain)}`);
  }
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

// ---------------------------------------------------------------------------
// /guide — public user guide (HTML, split into 3 messages, <4096 chars each)
// ---------------------------------------------------------------------------

const GUIDE_PARTS: readonly string[] = [
  `<b>🐝 Freemint-Bot — User Guide (1/3)</b>

<b>⚡ Quick Start — 60 seconds</b>
1. Press Start.
2. Tap ➕ New Wallet — the bot creates a Base wallet instantly (or 📥 Import Key to add your own).
3. Send a little ETH for gas (~0.0005 ETH is plenty; each tx costs about $0.001).
4. Tap 🖼 My Portfolio to see your NFTs.
5. You're ready to hunt free mints.

<b>🧭 Main Menu Map</b>
💼 My Wallets — manage wallets: toggle active, copy address, refuel, sweep, export, delete
➕ New Wallet — generate a fresh Base wallet
🎯 Tracking — watch other wallets and auto-copy their mints
🖼 My Portfolio — all NFTs across your wallets, floors, Sell buttons
🔍 Scan Contract — analyze any contract address
🚀 Manual Mint — mint a contract you already scanned
👁 Watchlist — your saved contracts for quick access
🛡 Settings / Gas — max gas price the bot may pay
⚡ Auto-Mint — master switch for automatic minting`,
  `<b>🐝 Freemint-Bot — User Guide (2/3)</b>

<b>🔍 Scanning and WHOIS</b>
Use the Scan button or /whois followed by a contract address.
You get:
✅ Verified — source verified on the explorer, or ⚠️ bytecode only
🛡 Security status — SAFE/CLEAN or 🚨 HIGH RISK / HONEYPOT, score /100
⛏ Free mint functions found
🚀 Attempt Bypass button — jumps straight into the bypass engine

⚠️ Never mint a contract the scanner marks UNSAFE.

<b>🧪 Bypass Engine — the minting power tool</b>
It simulates the mint BEFORE sending any transaction, so it tells you the gate type for free, zero gas.

Commands:
/bypass ADDRESS — full run: analyze gate, mint if open
/bypass ADDRESS --dry — simulate only, no transaction
/bypass ADDRESS --probe — map contract state (phase, price, supply)
/bypass ADDRESS --probe --schedule — auto-mint at the public window
/bypass ADDRESS --watch — poll-and-fire: mint the instant the gate opens
/bypass ADDRESS --stop — stop an active watcher

Gate types:
mint_open — live and free: the engine mints immediately
timed — opens at a set time (FCFS): use --watch or --schedule
paused — owner paused it; nothing works until unpaused
whitelist / allowlist — only listed wallets; cannot be forged on-chain
signature — needs a signed voucher; only the project can sign
payment — costs money; engine only does value-0 free mints
soldout / ended — max supply reached; it's over

<b>👀 Watch mode — for FCFS timed mints</b>
1. Run /bypass ADDRESS --watch before the mint opens.
2. The bot polls every 2.5 seconds and reports gate changes.
3. The moment the contract stops reverting, it sends the mint instantly and posts the TX link.
4. Stop with the ⏹ button or /bypass ADDRESS --stop.
Limits: 3 watchers per contract, 5 per user. Whitelist/signature/soldout gates auto-stop the watcher.

<b>🌐 Multi-Chain — Base + Robinhood Chain</b>
Use /chain to set your default network, or force one per command:
/whois ADDRESS --chain=robinhood
/bypass ADDRESS --chain=base
/bypass ADDRESS --chain=both — runs both networks in one go
/bypass ADDRESS --watch --chain=robinhood — watch on a specific chain
/bypass ADDRESS --schedule --chain=both — arms on every selected chain
Portfolio shows ⛽ Base and 🏹 Robinhood Chain items together. Sell is ⛽ Base-only for now — 🏹 items must be sold off-platform.`,
  `<b>🐝 Freemint-Bot — User Guide (3/3)</b>

<b>🖼 Portfolio</b>
NFTs are grouped by collection. Each group shows floor price and top bid, with a Sell button per collection (Sell is ⛽ Base-only; 🏹 Robinhood items are shown but must be sold off-platform). Use 🔄 Refresh to re-fetch, or 📦 Sweep All NFTs to Wallet 1 to consolidate. Floor shows 0 ETH when there are no live listings or the source is temporarily down — it retries automatically.

<b>💼 Wallets</b>
Generate — free instant Base wallet.
Import — paste a private key to manage an existing wallet.
Toggle ✅/❌ — only active wallets mint.
Refuel / Distribute Gas — top up wallets with preset or custom amounts.
Sweep All ETH Dust — collect leftover gas to your main wallet.
Export / Delete — backup keys or remove a wallet.
Keys are encrypted at rest; they never appear on screen unless you tap Export.

<b>🎯 Tracking and Sniper</b>
Add Tracked Wallet — watch any public wallet.
Auto-Copy — when a tracked wallet mints, the bot tries the same contract.
Max Spend — 0 ETH means free mints only.

<b>🛡 Settings / Gas</b>
Gas guard stops expensive mints: 0.02 Ultra Cheap · 0.05 Recommended · 0.10 Fast · 0.25 Aggressive. If network gas is above your cap, the mint aborts and tells you.

<b>❓ FAQ</b>
Q: "No free mint functions detected" — why?
A: The contract may require payment, be unverified, or not be an NFT. Don't mint it anyway.
Q: Mint failed with "Not whitelisted"?
A: The contract only allows listed wallets. No tool can forge that.
Q: Gas "too high"?
A: Network gas spiked above your cap. Raise it in Settings or wait.
Q: Same wallet for everything?
A: Yes, but per-wallet limits mean more wallets = more chances.
Q: Is my key safe?
A: Encrypted at rest. The bot only signs what you approve.

<b>⚠️ Safety rules</b>
1. Never share private keys or seed phrases — including with "support".
2. Only mint contracts the scanner marks SAFE/CLEAN.
3. Free mint ≠ safe mint. The audit is your friend.
4. The bot can't guarantee 1-second sellouts — that's the reality of FCFS.

Enjoy hunting free mints! 🐝`,
];

export async function guideCommand(ctx: Context): Promise<void> {
  for (let i = 0; i < GUIDE_PARTS.length; i++) {
    const isLast = i === GUIDE_PARTS.length - 1;
    await ctx.reply(GUIDE_PARTS[i], {
      parse_mode: "HTML",
      ...(isLast ? { reply_markup: backToMainKeyboard() } : {}),
    });
  }
}
