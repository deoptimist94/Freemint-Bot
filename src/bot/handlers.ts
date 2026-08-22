import { type Context, InlineKeyboard } from "grammy";
import { type Hex, type Address } from "viem";
import {
  generateNewWallet,
  importWallet,
  getWallets,
  toggleWallet,
  deleteWallet,
  getWalletPrivateKey,
  ensureUser,
  type WalletInfo,
} from "../core/wallet.js";
import {
  isValidAddress,
  isValidPrivateKey,
  shortenAddress,
  normalizeAddressInput,
} from "../core/chain.js";
import { scanContract } from "../core/scanner.js";
import {
  batchMint,
  getUserMintQuantity,
  setUserMintQuantity,
} from "../core/mint.js";
import { fetchWalletPortfolio, executeSell } from "../core/portfolio.js";
import {
  fetchCollectionFloor,
  executeAutoListing,
} from "../core/autoLister.js";
import { sweepDustToMaster } from "../core/sweeper.js";
import { sweepAllNFTsToMaster } from "../core/nftSweeper.js";
import { fundSubWallets } from "../core/funder.js";
import { getEthUsdPrice, usdToEth } from "../core/price.js";
import { checkGasSafety, setUserGasCeiling } from "../core/gasGuard.js";
import { getAutoSellConfig, setAutoSellConfig } from "../core/autoSeller.js";
import {
  addToWatchlist,
  removeFromWatchlist,
  getWatchlist,
  setAutoMintEnabled,
  getAutoMintStatus,
} from "../core/watchlist.js";
import { fetchAllWalletsBalances } from "../core/walletBalance.js";
import {
  addTrackedWallet,
  removeTrackedWallet,
  getTrackedWallets,
  getSniperConfig,
  setSniperConfig,
} from "../core/sniperEngine.js";
import {
  analyzeBypassOptions,
  executeBypass,
} from "../core/bypassEngine.js";
import { lookupWhois, formatWhoisReport } from "../core/whois.js";
import {
  mainMenuKeyboard,
  walletsKeyboard,
  deleteWalletKeyboard,
  exportWalletsKeyboard,
  watchlistKeyboard,
  confirmMintKeyboard,
  backToMainKeyboard,
  backToWalletsKeyboard,
  portfolioKeyboard,
  fundAmountKeyboard,
  settingsMenuKeyboard,
  gasSettingsKeyboard,
  quantitySettingsKeyboard,
  autoSellSettingsKeyboard,
  trackingMenuKeyboard,
  trackedWalletsListKeyboard,
} from "./keyboards.js";

// ---------------------------------------------------------------------------
// Session (in-memory)
// ---------------------------------------------------------------------------
type SessionAction =
  | "idle"
  | "scan"
  | "manual_mint"
  | "import_key"
  | "fund_custom"
  | "add_tracked";

interface UserSession {
  action: SessionAction;
}

const sessions = new Map<string, UserSession>();

function sid(id: bigint): string {
  return id.toString();
}

function getSession(telegramId: bigint): UserSession {
  const key = sid(telegramId);
  let s = sessions.get(key);
  if (!s) {
    s = { action: "idle" };
    sessions.set(key, s);
  }
  return s;
}

function setSession(telegramId: bigint, patch: Partial<UserSession>): void {
  const cur = getSession(telegramId);
  sessions.set(sid(telegramId), { ...cur, ...patch });
}

function clearSession(telegramId: bigint): void {
  sessions.set(sid(telegramId), { action: "idle" });
}

// ---------------------------------------------------------------------------
// Safe Telegram edit — swallows "message is not modified"
// ---------------------------------------------------------------------------
async function safeEdit(
  ctx: Context,
  text: string,
  extra?: {
    reply_markup?: InlineKeyboard;
    parse_mode?: "Markdown" | "MarkdownV2" | "HTML";
    link_preview_options?: { is_disabled: boolean };
  }
): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctx.editMessageText(text, extra as any);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("message is not modified")) {
      try {
        await ctx.answerCallbackQuery({ text: "Already up to date" });
      } catch {
        /* ignore */
      }
      return;
    }
    throw err;
  }
}

async function editOrReply(
  ctx: Context,
  text: string,
  extra?: {
    reply_markup?: InlineKeyboard;
    parse_mode?: "Markdown" | "MarkdownV2" | "HTML";
    link_preview_options?: { is_disabled: boolean };
  }
): Promise<void> {
  if (ctx.callbackQuery) {
    await safeEdit(ctx, text, extra);
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctx.reply(text, extra as any);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
export async function startCommand(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  const telegramId = BigInt(ctx.from.id);
  await ensureUser(telegramId);
  clearSession(telegramId);
  await showMainMenu(ctx);
}

export async function helpCommand(ctx: Context): Promise<void> {
  const text =
    `📖 **Help**\n\n` +
    `• /start — main menu\n` +
    `• /help — this message\n` +
    `• /whois <0xAddress> — contract / EOA lookup\n` +
    `• /bypass <0xContract> — mint-gate / whitelist bypass analysis\n\n` +
    `Paste a contract address anytime to scan it.\n` +
    `Paste a private key to import a wallet (only when prompted or anytime).`;
  await ctx.reply(text, {
    parse_mode: "Markdown",
    reply_markup: backToMainKeyboard(),
  });
}

export async function whoisCommand(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const telegramId = BigInt(from.id);
  await ensureUser(telegramId);

  const parts = (ctx.message?.text ?? "").trim().split(/\s+/);
  const raw = parts[1];
  if (!raw) {
    await ctx.reply("Usage: `/whois <0xAddress>`", {
      parse_mode: "Markdown",
      reply_markup: backToMainKeyboard(),
    });
    return;
  }

  const address = normalizeAddressInput(raw);
  if (!isValidAddress(address)) {
    await ctx.reply("❌ Invalid address.", {
      reply_markup: backToMainKeyboard(),
    });
    return;
  }

  await ctx.reply(`🔎 Looking up \`${shortenAddress(address)}\`...`, {
    parse_mode: "Markdown",
  });

  try {
    const report = await lookupWhois(address);
    await ctx.reply(formatWhoisReport(report), {
      parse_mode: "Markdown",
      link_preview_options: { is_disabled: true },
      reply_markup: backToMainKeyboard(),
    });
  } catch (error) {
    await ctx.reply(`❌ Whois failed: ${errorMessage(error)}`, {
      reply_markup: backToMainKeyboard(),
    });
  }
}

export async function bypassCommand(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const telegramId = BigInt(from.id);
  await ensureUser(telegramId);

  const parts = (ctx.message?.text ?? "").trim().split(/\s+/);
  const raw = parts[1];
  if (!raw) {
    await ctx.reply("Usage: `/bypass <0xContract>`", {
      parse_mode: "Markdown",
      reply_markup: backToMainKeyboard(),
    });
    return;
  }

  const address = normalizeAddressInput(raw);
  if (!isValidAddress(address)) {
    await ctx.reply("❌ Invalid contract address.", {
      reply_markup: backToMainKeyboard(),
    });
    return;
  }

  const wallets = await getWallets(telegramId);
  const probe =
    wallets.find((w) => w.isActive)?.address ?? wallets[0]?.address;
  if (!probe) {
    await ctx.reply(
      "❌ Create a wallet first (New Wallet), then retry `/bypass`.",
      { reply_markup: backToMainKeyboard(), parse_mode: "Markdown" }
    );
    return;
  }

  await ctx.reply(
    `🛠 Analyzing mint gate on \`${shortenAddress(address)}\`...`,
    { parse_mode: "Markdown" }
  );

  try {
    const report = await analyzeBypassOptions(
      address,
      probe as Address
    );
    const fp = report.fingerprint;

    let text = `🛠 **Whitelist Bypass Analysis**\n\n`;
    text += `Contract: \`${report.contractAddress}\`\n`;
    text += `Gate: \`${fp.gateType}\`\n`;
    text += `Merkle root: ${fp.merkleRootPresent ? "yes" : "no"}\n`;
    if (fp.openAdminSetters.length) {
      text += `Open admin setters: ${fp.openAdminSetters
        .map((s) => s.name)
        .join(", ")}\n`;
    }
    if (fp.notes.length) {
      text += `\n**Notes:**\n`;
      for (const n of fp.notes) text += `• ${n}\n`;
    }
    text += `\n**Strategies:**\n`;

    const kb = new InlineKeyboard();
    for (const s of report.strategies) {
      const icon = s.executable ? "✅" : "⬜️";
      text += `${icon} \`${s.id}\` — ${s.name}\n_${s.description}_\n\n`;
      if (s.executable) {
        kb
          .text(
            `Run ${s.id}`,
            `bypass_run:${s.id}:${report.contractAddress}`
          )
          .row();
      }
    }
    kb.text("🏠 Main Menu", "main_menu");

    await ctx.reply(text, {
      parse_mode: "Markdown",
      reply_markup: kb,
      link_preview_options: { is_disabled: true },
    });
  } catch (error) {
    await ctx.reply(`❌ Bypass analysis failed: ${errorMessage(error)}`, {
      reply_markup: backToMainKeyboard(),
    });
  }
}

async function handleBypassRun(
  ctx: Context,
  telegramId: bigint,
  strategyId: string,
  contractAddress: string
): Promise<void> {
  try {
    await ctx.answerCallbackQuery({ text: "Executing bypass…" });
  } catch {
    /* ignore */
  }

  await ctx.reply(
    `⚡ Running \`${strategyId}\` on \`${shortenAddress(contractAddress)}\`…`,
    { parse_mode: "Markdown" }
  );

  try {
    const outcome = await executeBypass(
      telegramId,
      contractAddress,
      strategyId
    );
    for (const r of outcome.results) {
      const icon = r.success ? "✅" : "❌";
      let card = `${icon} **${r.walletLabel}**\n\`${shortenAddress(
        r.walletAddress
      )}\`\n`;
      if (r.txHash) {
        card += `TX: [view](https://basescan.org/tx/${r.txHash})\n`;
      }
      if (r.error) card += `Error: ${r.error}\n`;
      await ctx.reply(card, {
        parse_mode: "Markdown",
        link_preview_options: { is_disabled: true },
      });
    }
    await ctx.reply("Done.", { reply_markup: backToMainKeyboard() });
  } catch (error) {
    await ctx.reply(`❌ Bypass failed: ${errorMessage(error)}`, {
      reply_markup: backToMainKeyboard(),
    });
  }
}

// ---------------------------------------------------------------------------
// Main menu
// ---------------------------------------------------------------------------
async function showMainMenu(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  const telegramId = BigInt(ctx.from.id);
  await ensureUser(telegramId);
  const enabled = await getAutoMintStatus(telegramId);

  const text =
    `🤖 **Base Auto-Mint Bot**\n\n` +
    `Welcome! Manage your wallets, scan contracts, and auto-mint free NFTs on Base.\n\n` +
    `Select an option below:`;

  await editOrReply(ctx, text, {
    reply_markup: mainMenuKeyboard(enabled),
    parse_mode: "Markdown",
  });
}

// ---------------------------------------------------------------------------
// Callback router
// ---------------------------------------------------------------------------
export async function handleCallback(ctx: Context): Promise<void> {
  if (!ctx.callbackQuery?.data || !ctx.from) return;
  const data = ctx.callbackQuery.data;
  const telegramId = BigInt(ctx.from.id);
  await ensureUser(telegramId);

  try {
    await ctx.answerCallbackQuery();
  } catch {
    /* ignore stale */
  }

  // Bypass execute
  if (data.startsWith("bypass_run:")) {
    const rest = data.slice("bypass_run:".length);
    const splitAt = rest.indexOf(":");
    if (splitAt > 0) {
      const strategyId = rest.slice(0, splitAt);
      const contractAddress = rest.slice(splitAt + 1);
      await handleBypassRun(ctx, telegramId, strategyId, contractAddress);
    }
    return;
  }

  if (data === "main_menu") {
    clearSession(telegramId);
    await showMainMenu(ctx);
    return;
  }

  if (data === "wallets") {
    clearSession(telegramId);
    await showWalletsScreen(ctx, telegramId);
    return;
  }

  if (data === "new_wallet") {
    clearSession(telegramId);
    try {
      const w = await generateNewWallet(telegramId);
      await editOrReply(
        ctx,
        `✅ New wallet generated!\n\n📋 Label: ${w.label}\n📍 Address: \`${w.address}\`\n\nFund it with a little Base ETH for gas.`,
        { parse_mode: "Markdown", reply_markup: backToWalletsKeyboard() }
      );
    } catch (error) {
      await editOrReply(ctx, `❌ ${errorMessage(error)}`, {
        reply_markup: backToWalletsKeyboard(),
      });
    }
    return;
  }

  if (data === "import_key") {
    setSession(telegramId, { action: "import_key" });
    await safeEdit(
      ctx,
      `📥 **Import Wallet**\n\nPaste your private key (64 hex chars, with or without 0x).\n\n⚠️ Never share keys in public chats.`,
      { parse_mode: "Markdown", reply_markup: backToWalletsKeyboard() }
    );
    return;
  }

  if (data === "export_keys") {
    const wallets = await getWallets(telegramId);
    if (wallets.length === 0) {
      await safeEdit(ctx, "No wallets to export.", {
        reply_markup: backToWalletsKeyboard(),
      });
      return;
    }
    await safeEdit(
      ctx,
      `🔑 **Export Keys**\n\nSelect a wallet. The key will be sent as a new message — delete it after saving.`,
      {
        parse_mode: "Markdown",
        reply_markup: exportWalletsKeyboard(wallets),
      }
    );
    return;
  }

  if (data.startsWith("export_")) {
    const id = data.slice("export_".length);
    try {
      const pk = await getWalletPrivateKey(id);
      const wallets = await getWallets(telegramId);
      const w = wallets.find((x) => x.id === id);
      await ctx.reply(
        `🔑 **${w?.label ?? "Wallet"}**\n\`${w?.address ?? "?"}\`\n\n` +
          `Private key:\n\`${pk}\`\n\n⚠️ Delete this message after saving.`,
        { parse_mode: "Markdown" }
      );
    } catch (error) {
      await ctx.reply(`❌ Export failed: ${errorMessage(error)}`);
    }
    return;
  }

  if (data === "delete_wallet") {
    const wallets = await getWallets(telegramId);
    await safeEdit(ctx, "🗑 Select a wallet to delete:", {
      reply_markup: deleteWalletKeyboard(wallets),
    });
    return;
  }

  if (data.startsWith("del_")) {
    const id = data.slice(4);
    try {
      await deleteWallet(telegramId, id);
      await showWalletsScreen(ctx, telegramId);
    } catch (error) {
      await safeEdit(ctx, `❌ ${errorMessage(error)}`, {
        reply_markup: backToWalletsKeyboard(),
      });
    }
    return;
  }

  if (data.startsWith("toggle_")) {
    // toggle wallet active — not toggle_autocopy
    if (data === "toggle_autocopy") {
      const config = await getSniperConfig(telegramId);
      await setSniperConfig(telegramId, { autoCopy: !config.autoCopy });
      await showTrackingScreen(ctx, telegramId);
      return;
    }
    const id = data.slice("toggle_".length);
    try {
      await toggleWallet(telegramId, id);
      await showWalletsScreen(ctx, telegramId);
    } catch (error) {
      await safeEdit(ctx, `❌ ${errorMessage(error)}`, {
        reply_markup: backToWalletsKeyboard(),
      });
    }
    return;
  }

  if (data === "fund_menu") {
    const price = await getEthUsdPrice().catch(() => 0);
    await safeEdit(
      ctx,
      `⛽ **Refuel / Distribute Gas**\n\nSend Base ETH from Wallet 1 to all other active wallets.\nPick an amount:`,
      {
        parse_mode: "Markdown",
        reply_markup: fundAmountKeyboard(price || 3000),
      }
    );
    return;
  }

  if (data === "fund_custom") {
    setSession(telegramId, { action: "fund_custom" });
    await safeEdit(
      ctx,
      `✍️ Enter amount in ETH or USD (e.g. \`0.001\` or \`$2\`)`,
      { parse_mode: "Markdown", reply_markup: backToWalletsKeyboard() }
    );
    return;
  }

  if (data.startsWith("fund_")) {
    const amountStr = data.slice(5);
    const amountEth = parseFloat(amountStr);
    if (!isNaN(amountEth) && amountEth > 0) {
      await ctx.reply(`🚀 Distributing ${amountEth} ETH to each sub-wallet...`);
      try {
        const fund = await fundSubWallets(telegramId, amountEth);
        let report = `✅ **Gas Distribution Completed!**\n\n💰 Total: \`${fund.totalDistributedEth.toFixed(
          5
        )} ETH\`\n\n`;
        for (const res of fund.results) {
          if (res.txHash) {
            report += `• **${res.walletLabel}**: \`${res.fundedEth} ETH\` ([Tx](https://basescan.org/tx/${res.txHash}))\n`;
          } else {
            report += `• **${res.walletLabel}**: Failed (${res.error})\n`;
          }
        }
        await ctx.reply(report, {
          parse_mode: "Markdown",
          link_preview_options: { is_disabled: true },
          reply_markup: backToWalletsKeyboard(),
        });
      } catch (err) {
        await ctx.reply(`❌ Distribution failed: ${errorMessage(err)}`, {
          reply_markup: backToWalletsKeyboard(),
        });
      }
    }
    return;
  }

  if (data === "sweep_dust") {
    await ctx.reply("🧹 Sweeping ETH dust to Wallet 1...");
    try {
      const result = await sweepDustToMaster(telegramId);
      await ctx.reply(
        `✅ Sweep done.\n${typeof result === "object" ? JSON.stringify(result) : String(result)}`,
        { reply_markup: backToWalletsKeyboard() }
      );
    } catch (error) {
      await ctx.reply(`❌ Sweep failed: ${errorMessage(error)}`, {
        reply_markup: backToWalletsKeyboard(),
      });
    }
    return;
  }

  if (data === "sweep_nfts") {
    await ctx.reply("📦 Sweeping NFTs to Wallet 1...");
    try {
      const result = await sweepAllNFTsToMaster(telegramId);
      await ctx.reply(
        `✅ NFT sweep done.\n${typeof result === "object" ? JSON.stringify(result) : String(result)}`,
        { reply_markup: portfolioKeyboard() }
      );
    } catch (error) {
      await ctx.reply(`❌ NFT sweep failed: ${errorMessage(error)}`, {
        reply_markup: portfolioKeyboard(),
      });
    }
    return;
  }

  if (data === "portfolio") {
    clearSession(telegramId);
    await showPortfolioScreen(ctx, telegramId);
    return;
  }

  if (data === "watchlist") {
    clearSession(telegramId);
    await showWatchlistScreen(ctx, telegramId);
    return;
  }

  if (data === "scan_contract") {
    setSession(telegramId, { action: "scan" });
    await safeEdit(
      ctx,
      `🔍 **Scan Contract**\n\nPaste a contract address (0x...)`,
      { parse_mode: "Markdown", reply_markup: backToMainKeyboard() }
    );
    return;
  }

  if (data === "manual_mint") {
    setSession(telegramId, { action: "manual_mint" });
    await safeEdit(
      ctx,
      `🚀 **Manual Mint**\n\nPaste a contract address (0x...) to mint from all active (✅) wallets.`,
      { parse_mode: "Markdown", reply_markup: backToMainKeyboard() }
    );
    return;
  }

  if (data === "settings") {
    await showSettingsScreen(ctx, telegramId);
    return;
  }

  if (data === "menu_gas") {
    const gas = await checkGasSafety(telegramId);
    await safeEdit(
      ctx,
      `⛽ **Gas Ceiling**\n\nCurrent network: \`${gas.currentGwei.toFixed(
        4
      )} Gwei\`\nYour max: \`${gas.maxGwei} Gwei\``,
      {
        parse_mode: "Markdown",
        reply_markup: gasSettingsKeyboard(gas.maxGwei),
      }
    );
    return;
  }

  if (data.startsWith("setgas_")) {
    const v = parseFloat(data.slice(7));
    if (!isNaN(v)) {
      await setUserGasCeiling(telegramId, v);
      await safeEdit(ctx, `✅ Gas ceiling set to \`${v} Gwei\``, {
        parse_mode: "Markdown",
        reply_markup: settingsMenuKeyboard(),
      });
    }
    return;
  }

  if (data === "menu_qty") {
    const q = getUserMintQuantity(telegramId);
    await safeEdit(ctx, `🔢 **Mint quantity per wallet:** \`${q}\``, {
      parse_mode: "Markdown",
      reply_markup: quantitySettingsKeyboard(q),
    });
    return;
  }

  if (data.startsWith("setqty_")) {
    const v = parseInt(data.slice(7), 10);
    if (!isNaN(v) && v > 0) {
      setUserMintQuantity(telegramId, v);
      await safeEdit(ctx, `✅ Mint quantity set to \`${v}\``, {
        parse_mode: "Markdown",
        reply_markup: settingsMenuKeyboard(),
      });
    }
    return;
  }

  if (data === "menu_autosell") {
    const cfg = await getAutoSellConfig(telegramId);
    await safeEdit(
      ctx,
      `💰 **Auto-Sell**\n\nEnabled: ${cfg.enabled ? "ON" : "OFF"}\nTarget: ${cfg.targetEth ?? "—"} ETH`,
      {
        parse_mode: "Markdown",
        reply_markup: autoSellSettingsKeyboard(cfg),
      }
    );
    return;
  }

  if (data === "autosell_toggle") {
    const cfg = await getAutoSellConfig(telegramId);
    await setAutoSellConfig(telegramId, { enabled: !cfg.enabled });
    const next = await getAutoSellConfig(telegramId);
    await safeEdit(
      ctx,
      `💰 **Auto-Sell**\n\nEnabled: ${next.enabled ? "ON" : "OFF"}`,
      {
        parse_mode: "Markdown",
        reply_markup: autoSellSettingsKeyboard(next),
      }
    );
    return;
  }

  if (data === "menu_tracking") {
    await showTrackingScreen(ctx, telegramId);
    return;
  }

  if (data === "add_tracked_prompt") {
    setSession(telegramId, { action: "add_tracked" });
    await safeEdit(
      ctx,
      `➕ **Add Tracked Wallet**\n\nPaste: \`0xAddress\` optional label`,
      { parse_mode: "Markdown", reply_markup: backToMainKeyboard() }
    );
    return;
  }

  if (data === "list_tracked_wallets") {
    const tracked = await getTrackedWallets(telegramId);
    if (tracked.length === 0) {
      await safeEdit(ctx, "No tracked wallets yet.", {
        reply_markup: new InlineKeyboard()
          .text("➕ Add", "add_tracked_prompt")
          .row()
          .text("🏠 Main Menu", "main_menu"),
      });
      return;
    }
    await safeEdit(ctx, `📋 **Tracked Wallets (${tracked.length})**`, {
      parse_mode: "Markdown",
      reply_markup: trackedWalletsListKeyboard(tracked),
    });
    return;
  }

  if (data.startsWith("rmtrack_")) {
    const id = data.slice(8);
    await removeTrackedWallet(telegramId, id);
    await showTrackingScreen(ctx, telegramId);
    return;
  }

  if (data === "menu_max_spend") {
    const config = await getSniperConfig(telegramId);
    const kb = new InlineKeyboard()
      .text("Free only (0)", "setspend_0")
      .row()
      .text("0.001 ETH", "setspend_0.001")
      .text("0.005 ETH", "setspend_0.005")
      .row()
      .text("0.01 ETH", "setspend_0.01")
      .text("0.05 ETH", "setspend_0.05")
      .row()
      .text("🔙 Tracking", "menu_tracking");
    await safeEdit(
      ctx,
      `💵 **Max Spend**\n\nCurrent: \`${
        config.maxSpendEth === 0 ? "Free only" : config.maxSpendEth + " ETH"
      }\``,
      { parse_mode: "Markdown", reply_markup: kb }
    );
    return;
  }

  if (data.startsWith("setspend_")) {
    const v = parseFloat(data.slice(9));
    if (!isNaN(v) && v >= 0) {
      await setSniperConfig(telegramId, { maxSpendEth: v });
      await showTrackingScreen(ctx, telegramId);
    }
    return;
  }

  if (data === "auto_on") {
    await setAutoMintEnabled(telegramId, true);
    await showMainMenu(ctx);
    return;
  }

  if (data === "auto_off") {
    await setAutoMintEnabled(telegramId, false);
    await showMainMenu(ctx);
    return;
  }

  if (data.startsWith("scan_")) {
    const addr = data.slice(5);
    clearSession(telegramId);
    await performScan(ctx, telegramId, addr);
    return;
  }

  if (data.startsWith("mint_")) {
    const addr = data.slice(5);
    clearSession(telegramId);
    await performMint(ctx, telegramId, addr);
    return;
  }

  if (data.startsWith("rmwatch_")) {
    const addr = data.slice(8);
    await removeFromWatchlist(telegramId, addr);
    await showWatchlistScreen(ctx, telegramId);
    return;
  }

  if (data.startsWith("confirm_mint_")) {
    const addr = data.slice(13);
    clearSession(telegramId);
    await performMint(ctx, telegramId, addr);
    return;
  }
}

// ---------------------------------------------------------------------------
// Text router
// ---------------------------------------------------------------------------
export async function handleText(ctx: Context): Promise<void> {
  if (!ctx.message?.text || !ctx.from) return;

  const telegramId = BigInt(ctx.from.id);
  await ensureUser(telegramId);
  const text = ctx.message.text.trim();
  const session = getSession(telegramId);

  // Ignore slash commands here (grammy routes them separately)
  if (text.startsWith("/")) return;

  if (session.action === "add_tracked") {
    clearSession(telegramId);
    const parts = text.split(/\s+/);
    const address = parts[0];
    const label = parts.slice(1).join(" ") || "Tracked Whale";

    if (!isValidAddress(address)) {
      await ctx.reply(
        "❌ Invalid wallet address. Please enter a valid 0x address.",
        {
          reply_markup: new InlineKeyboard().text("🔙 Back", "menu_tracking"),
        }
      );
      return;
    }

    await addTrackedWallet(telegramId, address, label);
    const tracked = await getTrackedWallets(telegramId);
    const config = await getSniperConfig(telegramId);
    await ctx.reply(
      `✅ **Successfully added tracked wallet!**\n\nAddress: \`${address}\`\nLabel: ${label}\n\nYour sniper is ready.`,
      {
        reply_markup: trackingMenuKeyboard(
          config.autoCopy,
          config.maxSpendEth,
          tracked.length
        ),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  if (session.action === "fund_custom") {
    clearSession(telegramId);
    let amountEth = 0;
    const clean = text
      .toLowerCase()
      .replace("$", "")
      .replace("usd", "")
      .replace("eth", "")
      .trim();
    const numericVal = parseFloat(clean);

    if (isNaN(numericVal) || numericVal <= 0) {
      await ctx.reply("❌ Invalid amount entered. Please try again.", {
        reply_markup: backToWalletsKeyboard(),
      });
      return;
    }

    if (text.includes("$") || text.toLowerCase().includes("usd")) {
      amountEth = await usdToEth(numericVal);
    } else {
      amountEth = numericVal;
    }
    amountEth = Math.round(amountEth * 1e6) / 1e6;

    await ctx.reply(
      `🚀 *Distributing ${amountEth} ETH to each sub-wallet...*`,
      { parse_mode: "Markdown" }
    );

    try {
      const fund = await fundSubWallets(telegramId, amountEth);
      let report = `✅ **Gas Distribution Completed!**\n\n💰 **Total Dispatched:** \`${fund.totalDistributedEth.toFixed(
        5
      )} ETH\`\n\n`;
      for (const res of fund.results) {
        if (res.txHash) {
          report += `• **${res.walletLabel}**: Funded \`${res.fundedEth} ETH\` ([Tx](https://basescan.org/tx/${res.txHash}))\n`;
        } else {
          report += `• **${res.walletLabel}**: Failed (${res.error})\n`;
        }
      }
      await ctx.reply(report, {
        parse_mode: "Markdown",
        link_preview_options: { is_disabled: true },
        reply_markup: backToWalletsKeyboard(),
      });
    } catch (err) {
      await ctx.reply(`❌ Distribution failed: ${errorMessage(err)}`, {
        reply_markup: backToWalletsKeyboard(),
      });
    }
    return;
  }

  if (isValidAddress(text)) {
    const normalizedAddr = normalizeAddressInput(text);
    if (session.action === "manual_mint") {
      clearSession(telegramId);
      await performMint(ctx, telegramId, normalizedAddr);
      return;
    }
    if (session.action === "scan") {
      clearSession(telegramId);
      await performScan(ctx, telegramId, normalizedAddr);
      return;
    }
    clearSession(telegramId);
    await performScan(ctx, telegramId, normalizedAddr);
    return;
  }

  if (isValidPrivateKey(text)) {
    clearSession(telegramId);
    await performImport(ctx, telegramId, text);
    return;
  }

  if (session.action === "import_key") {
    await ctx.reply(
      "❌ That doesn't look like a valid private key. Expected 64 hex characters (with or without 0x prefix).",
      { reply_markup: backToMainKeyboard() }
    );
    return;
  }

  if (session.action === "scan" || session.action === "manual_mint") {
    await ctx.reply(
      "❌ That doesn't look like a valid contract address. Expected 0x followed by 40 hex characters.",
      { reply_markup: backToMainKeyboard() }
    );
    return;
  }

  await showMainMenu(ctx);
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
async function showWalletsScreen(
  ctx: Context,
  telegramId: bigint
): Promise<void> {
  const wallets = await getWallets(telegramId);
  let balances: Array<{ address: string; eth: string }> = [];
  try {
    balances = await fetchAllWalletsBalances(telegramId);
  } catch {
    /* optional */
  }

  let text = `💼 **My Wallets**\n\n`;
  if (wallets.length === 0) {
    text += `No wallets yet. Generate or import one.`;
  } else {
    for (const w of wallets) {
      const bal =
        balances.find(
          (b) => b.address.toLowerCase() === w.address.toLowerCase()
        )?.eth ?? "?";
      text += `${w.isActive ? "✅" : "❌"} **${w.label}** \`${shortenAddress(
        w.address
      )}\` — ${bal} ETH\n`;
    }
  }

  await editOrReply(ctx, text, {
    parse_mode: "Markdown",
    reply_markup: walletsKeyboard(wallets),
  });
}

async function showTrackingScreen(
  ctx: Context,
  telegramId: bigint
): Promise<void> {
  const tracked = await getTrackedWallets(telegramId);
  const config = await getSniperConfig(telegramId);

  const text =
    `🎯 **Whale Tracking & Copy Mint Sniper**\n\n` +
    `Status: ${config.autoCopy ? "✅ Enabled" : "❌ Disabled"}\n` +
    `Max Spend Filter: ${
      config.maxSpendEth === 0
        ? "Free Mints Only"
        : config.maxSpendEth + " ETH"
    }\n` +
    `Tracked Wallets: ${tracked.length} address(es)\n\n` +
    `When active, any NFT mint or buy executed by your tracked wallets will be automatically mirrored.`;

  await editOrReply(ctx, text, {
    parse_mode: "Markdown",
    reply_markup: trackingMenuKeyboard(
      config.autoCopy,
      config.maxSpendEth,
      tracked.length
    ),
  });
}

async function showSettingsScreen(
  ctx: Context,
  telegramId: bigint
): Promise<void> {
  const gas = await checkGasSafety(telegramId);
  const qty = getUserMintQuantity(telegramId);
  const text =
    `🛡 **Settings / Gas**\n\n` +
    `Gas ceiling: \`${gas.maxGwei} Gwei\` (now ${gas.currentGwei.toFixed(
      4
    )})\n` +
    `Mint qty / wallet: \`${qty}\``;

  await editOrReply(ctx, text, {
    parse_mode: "Markdown",
    reply_markup: settingsMenuKeyboard(),
  });
}

async function showPortfolioScreen(
  ctx: Context,
  telegramId: bigint
): Promise<void> {
  const wallets = await getWallets(telegramId);

  if (wallets.length === 0) {
    const text = `🖼 **My Portfolio**\n\nNo wallets found. Generate or import a wallet first.`;
    await editOrReply(ctx, text, {
      reply_markup: backToMainKeyboard(),
      parse_mode: "Markdown",
    });
    return;
  }

  let text = `📊 **Base NFT Portfolio & Valuation**\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  let combinedFloorEth = 0;
  let totalNftsHeld = 0;

  for (const w of wallets) {
    try {
      const portfolio = await fetchWalletPortfolio(w.address);
      const nfts = portfolio?.nfts ?? portfolio?.items ?? [];
      const floorSum =
        typeof portfolio?.totalFloorEth === "number"
          ? portfolio.totalFloorEth
          : Array.isArray(nfts)
          ? nfts.reduce(
              (acc: number, n: { floorEth?: number; floor?: number }) =>
                acc + (n.floorEth ?? n.floor ?? 0),
              0
            )
          : 0;

      const count = Array.isArray(nfts) ? nfts.length : 0;
      totalNftsHeld += count;
      combinedFloorEth += floorSum;

      text += `👜 **${w.label}** (\`${shortenAddress(w.address)}\`):\n`;
      text += `📦 Holdings: ${count} NFT(s)\n`;
      text += `💎 Est. Floor Value: ${floorSum.toFixed(4)} ETH\n`;
      if (count === 0) {
        text += `_No NFTs found in this wallet._\n`;
      } else if (Array.isArray(nfts)) {
        for (const n of nfts.slice(0, 8)) {
          const name =
            (n as { name?: string; collection?: string }).name ||
            (n as { collection?: string }).collection ||
            "NFT";
          const fl =
            (n as { floorEth?: number; floor?: number }).floorEth ??
            (n as { floor?: number }).floor ??
            0;
          text += `  • ${name} — ${Number(fl).toFixed(4)} ETH\n`;
        }
        if (nfts.length > 8) text += `  … +${nfts.length - 8} more\n`;
      }
      text += `\n`;
    } catch {
      text += `👜 **${w.label}** (\`${shortenAddress(
        w.address
      )}\`):\n_Failed to load portfolio._\n\n`;
    }
  }

  text += `━━━━━━━━━━━━━━━━━━━━\n`;
  text += `🏷 **Total NFTs Across Wallets:** ${totalNftsHeld}\n`;
  text += `💰 **Combined Floor Value:** ${combinedFloorEth.toFixed(4)} ETH`;

  await editOrReply(ctx, text, {
    reply_markup: portfolioKeyboard(),
    parse_mode: "Markdown",
    link_preview_options: { is_disabled: true },
  });
}

async function showWatchlistScreen(
  ctx: Context,
  telegramId: bigint
): Promise<void> {
  const contracts = await getWatchlist(telegramId);

  let text = `👁 **Watchlist**\n\n`;
  if (contracts.length === 0) {
    text += `Your watchlist is empty.\n\n`;
    text += `Paste a contract address in chat to scan it, then add it to your watchlist.`;
  } else {
    text += `Tracking ${contracts.length} contract(s):\n\n`;
    for (const c of contracts) {
      text += `• \`${c}\`\n`;
    }
    text += `\nUse the buttons below to scan, mint, or remove contracts.`;
  }

  await editOrReply(ctx, text, {
    reply_markup: watchlistKeyboard(contracts),
    parse_mode: "Markdown",
  });
}

// ---------------------------------------------------------------------------
// Scan / mint / import
// ---------------------------------------------------------------------------
async function performScan(
  ctx: Context,
  telegramId: bigint,
  address: string
): Promise<void> {
  await ctx.reply(`🔍 Scanning contract \`${shortenAddress(address)}\`...`, {
    parse_mode: "Markdown",
  });

  try {
    const result = await scanContract(address);

    if (!result.isContract) {
      await ctx.reply(
        `❌ No contract found at \`${shortenAddress(address)}\``,
        {
          reply_markup: backToMainKeyboard(),
          parse_mode: "Markdown",
        }
      );
      return;
    }

    let text = `🔍 **Contract Analysis & Security Audit**\n\n`;
    text += `Contract: \`${result.contractAddress}\`\n`;
    text += `Verified: ${
      result.isVerified ? "✅ Yes" : "⚠️ Bytecode only"
    }\n`;
    text += `🛡 **Security Status:** ${
      result.security.isSafe
        ? "✅ SAFE / CLEAN"
        : "🚨 HIGH RISK / HONEYPOT"
    }\n`;
    text += `Risk Score: \`${result.security.riskScore} / 100\`\n\n`;

    if (result.security.warnings.length > 0) {
      text += `⚠️ **Security Warnings:**\n`;
      for (const w of result.security.warnings) {
        text += `• ${w}\n`;
      }
      text += `\n`;
    }

    if (result.mintFunctions.length > 0 && result.security.isSafe) {
      text += `**Free Mint Functions Found:**\n`;
      for (const fn of result.mintFunctions) {
        text += `• ${fn.name}(${fn.args.join(", ")}) — ✅ Free\n`;
      }
      text += `\n🚀 Safe free mint confirmed!`;

      await addToWatchlist(telegramId, address);

      await ctx.reply(text, {
        reply_markup: confirmMintKeyboard(address),
        parse_mode: "Markdown",
      });
    } else {
      text += result.warning || "No free mint functions detected.";
      await ctx.reply(text, {
        reply_markup: backToMainKeyboard(),
        parse_mode: "Markdown",
      });
    }
  } catch (error) {
    await ctx.reply(`❌ Scan failed: ${errorMessage(error)}`, {
      reply_markup: backToMainKeyboard(),
    });
  }
}

async function performMint(
  ctx: Context,
  telegramId: bigint,
  address: string
): Promise<void> {
  const gasCheck = await checkGasSafety(telegramId);
  if (!gasCheck.safe) {
    await ctx.reply(
      `⚠️ **MINT ABORTED (HIGH GAS)**\n\n` +
        `Current Network Gas: \`${gasCheck.currentGwei.toFixed(4)} Gwei\`\n` +
        `Your Configured Max: \`${gasCheck.maxGwei} Gwei\`\n\n` +
        `The bot paused this mint to prevent burning high gas fees. You can adjust your limit in **🛡 Settings / Gas**`,
      {
        reply_markup: backToMainKeyboard(),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  const wallets = await getWallets(telegramId);
  const activeCount = wallets.filter((w) => w.isActive).length;

  if (activeCount === 0) {
    await ctx.reply(
      "❌ No active wallets. Toggle at least one wallet to ✅ before minting.",
      { reply_markup: backToWalletsKeyboard() }
    );
    return;
  }

  const multiplier = getUserMintQuantity(telegramId);

  await ctx.reply(
    `🚀 **Starting Mint**\n\n` +
      `Contract: \`${shortenAddress(address)}\`\n` +
      `Active Wallets: ${activeCount} (x${multiplier} each)\n` +
      `Gas Price: \`${gasCheck.currentGwei.toFixed(4)} Gwei\` (Safe ✅)\n\n` +
      `Minting in progress...`,
    { parse_mode: "Markdown" }
  );

  try {
    const result = await batchMint(telegramId, address);

    if (result.results.length === 0) {
      await ctx.reply(
        `❌ No free mint functions detected on this contract. Aborting.`,
        { reply_markup: backToMainKeyboard() }
      );
      return;
    }

    for (const r of result.results) {
      const statusIcon = r.success ? "✅" : "❌";
      let card = `${statusIcon} **${r.label}** — ${
        r.success ? "Minted!" : "Failed"
      }\n`;
      card += `Wallet: \`${shortenAddress(r.walletAddress)}\`\n`;

      if (r.txHash && r.basescanUrl) {
        card += `TX: [${shortenAddress(r.txHash, 8, 8)}](${r.basescanUrl})\n`;
      }
      if (r.error) {
        card += `Error: ${r.error}\n`;
      }

      await ctx.reply(card, {
        parse_mode: "Markdown",
        link_preview_options: { is_disabled: true },
      });
    }

    await ctx.reply(
      `📊 **Mint Summary**\n\nContract: \`${shortenAddress(
        address
      )}\`\n✅ Success: ${result.totalSuccess}\n❌ Failed: ${
        result.totalFailed
      }\nTotal Attempts: ${result.results.length}`,
      {
        reply_markup: backToMainKeyboard(),
        parse_mode: "Markdown",
      }
    );
  } catch (error) {
    await ctx.reply(`❌ Mint failed: ${errorMessage(error)}`, {
      reply_markup: backToMainKeyboard(),
    });
  }
}

async function performImport(
  ctx: Context,
  telegramId: bigint,
  privateKey: string
): Promise<void> {
  try {
    const wallet = await importWallet(telegramId, privateKey);
    await ctx.reply(
      `✅ Wallet imported successfully!\n\n📋 Label: ${wallet.label}\n📍 Address: \`${wallet.address}\`\n\nThis wallet is now active (✅) and ready to mint.`,
      {
        parse_mode: "Markdown",
        reply_markup: backToWalletsKeyboard(),
      }
    );
  } catch (error) {
    await ctx.reply(`❌ Import failed: ${errorMessage(error)}`, {
      reply_markup: backToWalletsKeyboard(),
    });
  }
}
