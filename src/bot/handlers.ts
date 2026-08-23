import { type Context, InlineKeyboard } from "grammy";
import {
  generateNewWallet,
  importWallet,
  getWallets,
  toggleWallet,
  deleteWallet,
  getWalletPrivateKey,
} from "../core/wallet.js";
import {
  isValidAddress,
  shortenAddress,
  normalizeAddressInput,
} from "../core/chain.js";
import { scanContract } from "../core/scanner.js";
import {
  batchMint,
  getUserMintQuantity,
  setUserMintQuantity,
} from "../core/mint.js";
import {
  fetchWalletPortfolio,
  executeSell,
  type PortfolioItem,
} from "../core/portfolio.js";
import { getSellTarget, setSellTarget } from "../core/sellCache.js";
import { sweepDustToMaster } from "../core/sweeper.js";
import { sweepAllNFTsToMaster } from "../core/nftSweeper.js";
import { fundSubWallets } from "../core/funder.js";
import { getEthUsdPrice } from "../core/price.js";
import { checkGasSafety, setUserGasCeiling } from "../core/gasGuard.js";
import { getAutoSellConfig, setAutoSellConfig } from "../core/autoSeller.js";
import {
  addToWatchlist,
  removeFromWatchlist,
  getWatchlistWithContracts,
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
  mainMenuKeyboard,
  walletsKeyboard,
  deleteWalletKeyboard,
  exportWalletsKeyboard,
  watchlistKeyboard,
  confirmMintKeyboard,
  backToMainKeyboard,
  backToWalletsKeyboard,
  fundAmountKeyboard,
  trackingMenuKeyboard,
  trackedWalletsListKeyboard,
  maxSpendSettingsKeyboard,
  settingsMenuKeyboard,
  autoSellSettingsKeyboard,
  quantitySettingsKeyboard,
  gasSettingsKeyboard,
} from "./keyboards.js";

// ---------------------------------------------------------------------------
// Pending-input state (per user)
// ---------------------------------------------------------------------------
const pendingScans = new Map<number, boolean>();
const pendingMints = new Map<number, boolean>();
const pendingImports = new Map<number, boolean>();
const pendingFunds = new Map<number, boolean>();
const pendingTracked = new Map<number, boolean>();

function userIdNumber(ctx: Context): number {
  return ctx.from?.id ?? 0;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type EditOptions = {
  parse_mode?: "Markdown" | "HTML";
  reply_markup?: unknown;
  link_preview_options?: { is_disabled?: boolean };
};

async function editOrReply(ctx: Context, text: string, options?: EditOptions): Promise<void> {
  const message = ctx.callbackQuery?.message as
    | { chat?: { id?: number | string }; message_id?: number }
    | undefined;
  const chatId = message?.chat?.id;
  const messageId = message?.message_id;
  if (chatId !== undefined && messageId !== undefined) {
    try {
      await ctx.api.editMessageText(chatId, messageId, text, options as any);
      return;
    } catch (err) {
      if (err instanceof Error && /message is not modified/i.test(err.message)) {
        return;
      }
    }
  }
  await ctx.reply(text, options as any).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Menu views
// ---------------------------------------------------------------------------
async function showMainMenu(ctx: Context, telegramId: bigint): Promise<void> {
  const autoMint = await getAutoMintStatus(telegramId);
  await editOrReply(ctx, `🏠 **Main Menu**\n\nAuto-mint: ${autoMint ? "✅ ON" : "⭕ OFF"}`, {
    reply_markup: mainMenuKeyboard(autoMint),
    parse_mode: "Markdown",
  });
}

async function showWallets(ctx: Context, telegramId: bigint): Promise<void> {
  const wallets = await getWallets(telegramId);
  let text = `👛 **Your Wallets**\n\n`;
  if (wallets.length === 0) {
    text += `No wallets yet. Create one below.`;
  } else {
    const balances = await fetchAllWalletsBalances(wallets);
    for (const b of balances) {
      const wallet = wallets.find((w) => w.address === b.address);
      const icon = wallet?.isActive ? "✅" : "⭕";
      text += `${icon} **${wallet?.label ?? "Wallet"}**\n`;
      text += `   \`${shortenAddress(b.address)}\` — ${b.ethBalance} ETH (~$${b.usdBalance})\n`;
    }
    text += `\nTap a wallet to toggle active, or 📋 Copy for the full address.`;
  }
  await editOrReply(ctx, text, {
    reply_markup: walletsKeyboard(wallets),
    parse_mode: "Markdown",
  });
}

async function showDeleteWallet(ctx: Context, telegramId: bigint): Promise<void> {
  const wallets = await getWallets(telegramId);
  await editOrReply(ctx, `🗑 **Delete a wallet**`, {
    reply_markup: deleteWalletKeyboard(wallets),
    parse_mode: "Markdown",
  });
}

async function showFundMenu(ctx: Context, telegramId: bigint): Promise<void> {
  const ethPrice = await getEthUsdPrice();
  const wallets = await getWallets(telegramId);
  const master = wallets[0];
  let text = `💰 **Refuel / Distribute Gas**\n\nSend gas to the master wallet below, then distribute to every sub-wallet:`;
  if (master) text += `\n\nMaster (send gas here):\n\`${master.address}\``;
  text += `\n\nChoose an amount to send to EACH sub-wallet:`;
  await editOrReply(ctx, text, {
    reply_markup: fundAmountKeyboard(ethPrice),
    parse_mode: "Markdown",
  });
}

const MAX_ITEMS_PER_WALLET = 15;
const MAX_SELL_BUTTONS_PER_WALLET = 8;
const MAX_TEXT_LENGTH = 3500;

// Telegram Markdown: escape user-controlled strings (collection names, labels)
// so dynamic values can't break entity parsing and kill the whole message.
function mdEscape(text: string): string {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

export async function showPortfolio(ctx: Context, telegramId: bigint): Promise<void> {
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: "⏳ Loading portfolio..." }).catch(() => undefined);
  }
  const wallets = await getWallets(telegramId);
  if (wallets.length === 0) {
    await editOrReply(ctx, `💼 No wallets yet. Create one first.`, {
      reply_markup: backToMainKeyboard(),
      parse_mode: "Markdown",
    });
    return;
  }

  // Fetch every wallet in parallel; each fetch is internally time-bounded
  // (single Alchemy page + concurrent floor lookups with a hard budget).
  const results = await Promise.allSettled(
    wallets.map(async (wallet) => ({
      wallet,
      portfolio: await fetchWalletPortfolio(wallet.address),
    }))
  );

  let totalValue = 0;
  const lines: string[] = [];
  const kb = new InlineKeyboard();
  let hasButtons = false;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const wallet = wallets[i];
    if (r.status === "rejected") {
      lines.push(`👛 **${mdEscape(wallet.label)}** — ⚠️ portfolio error`);
      continue;
    }
    const { portfolio } = r.value;
    if (portfolio.error) {
      lines.push(`👛 **${mdEscape(wallet.label)}** — ⚠️ ${mdEscape(portfolio.error)}`);
      continue;
    }
    totalValue += portfolio.totalFloorValueEth;
    if (portfolio.items.length === 0) {
      lines.push(`👛 **${mdEscape(wallet.label)}** — no NFTs found`);
      continue;
    }

    const shown = portfolio.items.slice(0, MAX_ITEMS_PER_WALLET);
    lines.push(`👛 **${mdEscape(wallet.label)}** (\`${wallet.address}\`)`);
    for (const item of shown) {
      lines.push(
        `   🖼 #${item.tokenId} — ${mdEscape(item.collectionName || item.name)} (floor ${item.floorPriceEth} ETH)`
      );
      // Register the exact item so a later Sell tap resolves instantly and
      // never fails with "Token not found in your wallets" on a transient API hiccup.
      setSellTarget(telegramId, item.tokenId, {
        walletId: wallet.id,
        contractAddress: item.contractAddress,
        tokenId: item.tokenId,
        collectionName: item.collectionName || item.name,
        openseaUrl: item.openseaUrl,
        floorPriceEth: item.floorPriceEth,
        topBidEth: item.topBidEth,
      });
    }
    const extra = portfolio.items.length - shown.length;
    if (extra > 0) lines.push(`   …and ${extra} more`);

    let buttons = 0;
    for (const item of shown) {
      if (buttons >= MAX_SELL_BUTTONS_PER_WALLET) break;
      const cb = `sell_${item.tokenId}_${wallet.id}`;
      if (cb.length <= 64) {
        kb.text(`💰 Sell #${item.tokenId}`, cb);
        hasButtons = true;
        buttons++;
      } else {
        kb.url(`Sell #${item.tokenId} on OpenSea`, item.openseaUrl);
        hasButtons = true;
        buttons++;
      }
    }
    kb.row();
  }

  // Build the message and, if needed, drop trailing item lines until it fits
  // comfortably under Telegram's 4096-char hard limit. Dropping whole lines
  // keeps the Markdown balanced so entity parsing can never fail.
  let text = `💼 **Portfolio**\n\n${lines.join("\n")}\n\n**Total floor value: \`${totalValue}\` ETH**`;
  if (hasButtons) text += `\n\nSell instantly into the top bid with the buttons below.`;
  while (text.length > MAX_TEXT_LENGTH && lines.length > 0) {
    lines.pop();
    text = `💼 **Portfolio**\n\n${lines.join("\n")}\n\n**Total floor value: \`${totalValue}\` ETH**`;
    if (hasButtons) text += `\n\nSell instantly into the top bid with the buttons below.`;
  }

  if (hasButtons) kb.row();
  kb.text("🔁 Refresh", "portfolio").text("🏠 Main Menu", "main_menu");

  await editOrReply(ctx, text, { reply_markup: kb, parse_mode: "Markdown" });
}

async function showSettings(ctx: Context): Promise<void> {
  await editOrReply(ctx, `🛡 **Settings**\n\nConfigure auto-sell, mint quantity and the gas ceiling.`, {
    reply_markup: settingsMenuKeyboard(),
    parse_mode: "Markdown",
  });
}

async function showGasSettings(ctx: Context, telegramId: bigint): Promise<void> {
  const gas = await checkGasSafety(telegramId);
  await editOrReply(
    ctx,
    `⛽ **Gas Price Ceiling Guard**\n\nCurrent network gas: \`${gas.currentGwei.toFixed(4)}\` Gwei\nYour ceiling: \`${gas.maxGwei}\` Gwei\n\nSet a new ceiling below:`,
    { reply_markup: gasSettingsKeyboard(gas.maxGwei), parse_mode: "Markdown" }
  );
}

async function showQtySettings(ctx: Context, telegramId: bigint): Promise<void> {
  const qty = getUserMintQuantity(telegramId);
  await editOrReply(ctx, `🔢 **Mint Multiplier**\n\nMints per wallet per contract: \`${qty}\``, {
    reply_markup: quantitySettingsKeyboard(qty),
    parse_mode: "Markdown",
  });
}

async function showAutoSellSettings(ctx: Context, telegramId: bigint): Promise<void> {
  const config = getAutoSellConfig(telegramId);
  const ethPrice = await getEthUsdPrice();
  await editOrReply(
    ctx,
    `⚡ **Auto-Sell / Take-Profit**\n\nEnabled: ${config.enabled ? "✅" : "⭕"}\nMin payout: \`${config.minPayoutEth}\` ETH`,
    {
      reply_markup: autoSellSettingsKeyboard(config.enabled, config.minPayoutEth, ethPrice),
      parse_mode: "Markdown",
    }
  );
}

async function showMaxSpendSettings(ctx: Context, telegramId: bigint): Promise<void> {
  const config = await getSniperConfig(telegramId);
  await editOrReply(
    ctx,
    `💵 **Max Spend per Copy-Mint**\n\nCurrent: \`${config.maxSpendEth}\` ETH\n\nChoose a cap for auto copy-mints:`,
    { reply_markup: maxSpendSettingsKeyboard(config.maxSpendEth), parse_mode: "Markdown" }
  );
}

async function showHelpText(ctx: Context): Promise<void> {
  await editOrReply(
    ctx,
    `📖 **Freemint-Bot Guide**\n\n` +
      `• 💼 **Wallets** — generate, import, copy full addresses, export keys\n` +
      `• 🎯 **Tracking** — copy-mint whales, set max spend\n` +
      `• 🖼 **Portfolio** — view NFTs & sell into the top bid\n` +
      `• 🔍 **Scan Contract** — security audit before any mint\n` +
      `• 🚀 **Manual Mint** — mint a scanned contract\n` +
      `• 👁 **Watchlist** — track contracts\n` +
      `• 🛡 **Settings** — auto-sell, mint qty, gas ceiling\n\n` +
      `Commands: /whois <addr> · /bypass <addr> · /portfolio`,
    { reply_markup: backToMainKeyboard(), parse_mode: "Markdown" }
  );
}

async function showTrackingMenu(ctx: Context, telegramId: bigint): Promise<void> {
  const config = await getSniperConfig(telegramId);
  const tracked = await getTrackedWallets(telegramId);
  await editOrReply(
    ctx,
    `🎯 **Sniper / Copy-Trade Tracking**\n\nAuto-copy: ${config.autoCopy ? "✅ ON" : "⭕ OFF"}\nMax spend: \`${config.maxSpendEth}\` ETH\nTracked wallets: \`${tracked.length}\``,
    {
      reply_markup: trackingMenuKeyboard(config.autoCopy, config.maxSpendEth, tracked.length),
      parse_mode: "Markdown",
    }
  );
}

async function showTrackedWallets(ctx: Context, telegramId: bigint): Promise<void> {
  const tracked = await getTrackedWallets(telegramId);
  await editOrReply(ctx, `🎯 **Tracked Wallets (${tracked.length})**`, {
    reply_markup: trackedWalletsListKeyboard(tracked),
    parse_mode: "Markdown",
  });
}

async function showWatchlist(ctx: Context, telegramId: bigint): Promise<void> {
  const contracts = await getWatchlistWithContracts(telegramId);
  let text: string;
  if (contracts.length === 0) {
    text = `📋 **Your Watchlist is empty.**\n\nSend me any contract address to scan it, then add it to your watchlist.`;
  } else {
    text = `Tracking ${contracts.length} contract(s):\n\n`;
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
// Wallet actions
// ---------------------------------------------------------------------------
async function handleNewWallet(ctx: Context, telegramId: bigint): Promise<void> {
  try {
    const wallet = await generateNewWallet(telegramId);
    const wallets = await getWallets(telegramId);
    await editOrReply(
      ctx,
      `✅ **New Wallet Created**\n\n📍 \`${wallet.address}\`\n📋 Label: ${wallet.label}\n\nLong-press the address to copy it.`,
      { reply_markup: walletsKeyboard(wallets), parse_mode: "Markdown" }
    );
  } catch (err) {
    await editOrReply(ctx, `❌ ${errorMessage(err)}`, { reply_markup: backToMainKeyboard() });
  }
}

async function handleDeleteWallet(ctx: Context, telegramId: bigint, data: string): Promise<void> {
  const walletId = data.replace(/^del_/, "");
  await deleteWallet(walletId);
  const wallets = await getWallets(telegramId);
  await editOrReply(ctx, `🗑 Wallet deleted.`, {
    reply_markup: walletsKeyboard(wallets),
    parse_mode: "Markdown",
  });
}

async function handleToggleWallet(ctx: Context, telegramId: bigint, data: string): Promise<void> {
  const walletId = data.replace(/^toggle_/, "");
  await toggleWallet(walletId);
  const wallets = await getWallets(telegramId);
  await editOrReply(ctx, `🔄 Wallet toggled.`, {
    reply_markup: walletsKeyboard(wallets),
    parse_mode: "Markdown",
  });
}

async function handleCopyAddress(ctx: Context, telegramId: bigint, data: string): Promise<void> {
  const walletId = data.replace(/^copyaddr_/, "");
  const wallets = await getWallets(telegramId);
  const w = wallets.find((x) => x.id === walletId);
  if (!w) {
    await ctx.answerCallbackQuery({ text: "Wallet not found" });
    return;
  }
  await ctx.answerCallbackQuery({ text: "Address sent below 👇" });
  await ctx.reply(
    `📋 **${w.label}** — full address (long-press to copy):\n\n\`${w.address}\``,
    { parse_mode: "Markdown", reply_markup: backToWalletsKeyboard() }
  );
}

async function showExportKeys(ctx: Context, telegramId: bigint): Promise<void> {
  const wallets = await getWallets(telegramId);
  if (wallets.length === 0) {
    await editOrReply(ctx, `No wallets to export.`, { reply_markup: backToMainKeyboard() });
    return;
  }
  await editOrReply(ctx, `🗝 **Export Private Keys**\n\nChoose a wallet to reveal its key.`, {
    reply_markup: exportWalletsKeyboard(wallets),
    parse_mode: "Markdown",
  });
}

async function handleExportWallet(ctx: Context, data: string): Promise<void> {
  const walletId = data.replace(/^export_/, "");
  try {
    const privateKey = await getWalletPrivateKey(walletId);
    await editOrReply(
      ctx,
      `🔑 **Private Key**\n\n\`${privateKey}\`\n\n⚠️ Never share this with anyone.`,
      { reply_markup: backToMainKeyboard(), parse_mode: "Markdown" }
    );
  } catch (err) {
    await editOrReply(ctx, `❌ ${errorMessage(err)}`, { reply_markup: backToMainKeyboard() });
  }
}

// ---------------------------------------------------------------------------
// Fund / sweep
// ---------------------------------------------------------------------------
async function runFund(ctx: Context, telegramId: bigint, amount: number): Promise<void> {
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: "⏳ Funding sub-wallets..." }).catch(() => undefined);
  }
  try {
    const result = await fundSubWallets(telegramId, amount);
    let text = `✅ **Funding Complete**\n\nDistributed: \`${result.totalDistributedEth}\` ETH\n\n`;
    for (const r of result.results) {
      text += r.error
        ? `❌ ${r.walletLabel} — ${r.error}\n`
        : `✅ ${r.walletLabel} — ${r.fundedEth} ETH\n`;
    }
    await editOrReply(ctx, text, { reply_markup: backToMainKeyboard(), parse_mode: "Markdown" });
  } catch (err) {
    await editOrReply(ctx, `❌ **Funding failed**\n\n${errorMessage(err)}`, {
      reply_markup: backToMainKeyboard(),
      parse_mode: "Markdown",
    });
  }
}

async function runSweepDust(ctx: Context, telegramId: bigint): Promise<void> {
  const wallets = await getWallets(telegramId);
  if (wallets.length < 2) {
    await ctx.answerCallbackQuery({ text: "Need a master + at least one sub-wallet" });
    return;
  }
  await ctx.answerCallbackQuery({ text: "⏳ Sweeping dust..." });
  try {
    const result = await sweepDustToMaster(telegramId, wallets[0].address);
    let text = `🧹 **Dust Sweep Complete**\n\nTotal swept: \`${result.totalSweptEth}\` ETH\n\n`;
    for (const r of result.results) {
      text += r.error ? `❌ ${r.walletLabel} — ${r.error}\n` : `✅ ${r.walletLabel} — ${r.sweptEth} ETH\n`;
    }
    await editOrReply(ctx, text, { reply_markup: backToMainKeyboard(), parse_mode: "Markdown" });
  } catch (err) {
    await editOrReply(ctx, `❌ **Sweep failed**\n\n${errorMessage(err)}`, {
      reply_markup: backToMainKeyboard(),
    });
  }
}

async function runSweepNfts(ctx: Context, telegramId: bigint): Promise<void> {
  const wallets = await getWallets(telegramId);
  if (wallets.length < 2) {
    await ctx.answerCallbackQuery({ text: "Need a master + at least one sub-wallet" });
    return;
  }
  await ctx.answerCallbackQuery({ text: "⏳ Sweeping NFTs..." });
  try {
    const result = await sweepAllNFTsToMaster(telegramId, wallets[0].address);
    let text = `🗃 **NFT Sweep Complete**\n\nMoved: \`${result.totalMoved}\` NFTs\n\n`;
    for (const r of result.results) {
      text += r.error
        ? `❌ ${r.collectionName || r.fromWallet} #${r.tokenId} — ${r.error}\n`
        : `✅ ${r.collectionName || r.fromWallet} #${r.tokenId}\n`;
    }
    await editOrReply(ctx, text, { reply_markup: backToMainKeyboard(), parse_mode: "Markdown" });
  } catch (err) {
    await editOrReply(ctx, `❌ **Sweep failed**\n\n${errorMessage(err)}`, {
      reply_markup: backToMainKeyboard(),
    });
  }
}

// ---------------------------------------------------------------------------
// Sell flow (callback: sell_<tokenId>_<walletId>)
// ---------------------------------------------------------------------------
function parseSellPayload(data: string): { tokenId: string; walletId: string } {
  const idx = data.lastIndexOf("_");
  if (idx === -1) return { tokenId: "", walletId: "" };
  return { tokenId: data.slice(0, idx), walletId: data.slice(idx + 1) };
}

interface SellTarget {
  wallet: { id: string; address: string; label: string; isActive: boolean };
  item: PortfolioItem;
}

async function resolveSellTarget(telegramId: bigint, tokenId: string): Promise<SellTarget | null> {
  const wallets = await getWallets(telegramId);

  // 1) Fast path: the portfolio view and floor alerts already registered the
  //    exact item, so a Sell tap resolves instantly — no live re-fetch that can
  //    fail with a transient Alchemy error and produce "Token not found".
  const cached = getSellTarget(telegramId, tokenId);
  if (cached) {
    const wallet = wallets.find((w) => w.id === cached.walletId);
    if (wallet) {
      return {
        wallet,
        item: {
          contractAddress: cached.contractAddress,
          tokenId: cached.tokenId,
          name: cached.collectionName,
          collectionName: cached.collectionName,
          floorPriceEth: cached.floorPriceEth,
          topBidEth: cached.topBidEth,
          openseaUrl: cached.openseaUrl,
        },
      };
    }
    // Wallet was deleted — fall through to a live lookup.
  }

  // 2) Live fallback across all wallets (each fetch is time-bounded).
  for (const wallet of wallets) {
    try {
      const portfolio = await fetchWalletPortfolio(wallet.address);
      const item = portfolio.items.find((i) => i.tokenId === tokenId);
      if (item) {
        setSellTarget(telegramId, tokenId, {
          walletId: wallet.id,
          contractAddress: item.contractAddress,
          tokenId: item.tokenId,
          collectionName: item.collectionName || item.name,
          openseaUrl: item.openseaUrl,
          floorPriceEth: item.floorPriceEth,
          topBidEth: item.topBidEth,
        });
        return { wallet, item };
      }
    } catch {
      // try next wallet
    }
  }
  return null;
}

async function handleSell(ctx: Context, telegramId: bigint, data: string): Promise<void> {
  const { tokenId, walletId } = parseSellPayload(data);
  if (!tokenId || !walletId) {
    await ctx.answerCallbackQuery({ text: "Invalid sell payload" });
    return;
  }
  const target = await resolveSellTarget(telegramId, tokenId);
  if (!target) {
    await ctx.answerCallbackQuery({ text: "Token not found in your wallets" });
    return;
  }

  const confirmCb = `confirm_sell_${tokenId}_${walletId}`;
  const cancelCb = `cancel_sell_${tokenId}_${walletId}`;
  const kb = new InlineKeyboard();
  if (confirmCb.length <= 64 && cancelCb.length <= 64) {
    kb.text("✅ Confirm Sell", confirmCb).text("❌ Cancel", cancelCb).row();
  }
  kb.url("🔗 View on OpenSea", target.item.openseaUrl);

  await ctx.answerCallbackQuery();
  const bidLine =
    target.item.topBidEth > 0
      ? `Top bid: \`${target.item.topBidEth}\` ETH`
      : `Top bid: \`None\` — if there is no live bid, the dump will fail with \"No active bids\".`;
  await editOrReply(
    ctx,
    `💼 **Confirm Sell**\n\nCollection: ${mdEscape(target.item.collectionName || target.item.name)}\nToken: \`#${tokenId}\`\nFloor: \`${target.item.floorPriceEth}\` ETH\n${bidLine}\n\nSell into the top bid (accepting any price)?`,
    { reply_markup: kb, parse_mode: "Markdown" }
  );
}

async function handleConfirmSell(ctx: Context, telegramId: bigint, data: string): Promise<void> {
  const { tokenId, walletId } = parseSellPayload(data);
  if (!tokenId || !walletId) {
    await ctx.answerCallbackQuery({ text: "Invalid sell payload" });
    return;
  }
  const target = await resolveSellTarget(telegramId, tokenId);
  if (!target) {
    await ctx.answerCallbackQuery({ text: "Token no longer held" });
    return;
  }
  await ctx.answerCallbackQuery({ text: "⏳ Selling..." });
  try {
    const privateKey = await getWalletPrivateKey(walletId);
    const result = await executeSell(privateKey, target.item.contractAddress, tokenId);
    if (result.success) {
      await editOrReply(
        ctx,
        `✅ **Sold!**\n\nCollection: ${target.item.collectionName || target.item.name}\nToken: \`#${tokenId}\`\nPayout: \`${result.payoutEth ?? 0}\` ETH\n\n[View receipt](https://basescan.org/tx/${result.txHash})`,
        {
          reply_markup: backToMainKeyboard(),
          parse_mode: "Markdown",
          link_preview_options: { is_disabled: true },
        }
      );
    } else {
      await editOrReply(ctx, `❌ **Sell failed**\n\n${result.error}`, {
        reply_markup: backToMainKeyboard(),
        parse_mode: "Markdown",
      });
    }
  } catch (err) {
    await editOrReply(ctx, `❌ **Sell failed**\n\n${errorMessage(err)}`, {
      reply_markup: backToMainKeyboard(),
      parse_mode: "Markdown",
    });
  }
}

async function handleCancelSell(ctx: Context, data: string): Promise<void> {
  const { tokenId } = parseSellPayload(data);
  await ctx.answerCallbackQuery({ text: "Sale cancelled" });
  await editOrReply(ctx, `❌ Sale of #${tokenId} cancelled.`, {
    reply_markup: backToMainKeyboard(),
  });
}

// ---------------------------------------------------------------------------
// Settings / tracking actions
// ---------------------------------------------------------------------------
async function handleFundCallback(ctx: Context, telegramId: bigint, data: string): Promise<void> {
  const amount = parseFloat(data.replace(/^fund_/, ""));
  if (!Number.isFinite(amount) || amount <= 0) {
    await ctx.answerCallbackQuery({ text: "Invalid amount" });
    return;
  }
  await runFund(ctx, telegramId, amount);
}

async function handleSetGas(ctx: Context, telegramId: bigint, data: string): Promise<void> {
  const maxGwei = parseFloat(data.replace(/^setgas_/, ""));
  if (!Number.isFinite(maxGwei) || maxGwei <= 0) {
    await ctx.answerCallbackQuery({ text: "Invalid gas ceiling" });
    return;
  }
  setUserGasCeiling(telegramId, maxGwei);
  await ctx.answerCallbackQuery({ text: `Gas ceiling set to ${maxGwei} Gwei` });
  await showGasSettings(ctx, telegramId);
}

async function handleSetQty(ctx: Context, telegramId: bigint, data: string): Promise<void> {
  const qty = parseInt(data.replace(/^setqty_/, ""), 10);
  if (!Number.isFinite(qty) || qty < 1) {
    await ctx.answerCallbackQuery({ text: "Invalid quantity" });
    return;
  }
  setUserMintQuantity(telegramId, qty);
  await ctx.answerCallbackQuery({ text: `Mint quantity set to ${qty}` });
  await showQtySettings(ctx, telegramId);
}

async function handleAutoSellToggle(ctx: Context, telegramId: bigint): Promise<void> {
  const config = getAutoSellConfig(telegramId);
  setAutoSellConfig(telegramId, !config.enabled);
  await showAutoSellSettings(ctx, telegramId);
}

async function handleAutoSellMin(ctx: Context, telegramId: bigint, data: string): Promise<void> {
  const min = parseFloat(data.replace(/^set_as_/, ""));
  if (!Number.isFinite(min) || min <= 0) {
    await ctx.answerCallbackQuery({ text: "Invalid min payout" });
    return;
  }
  const config = getAutoSellConfig(telegramId);
  setAutoSellConfig(telegramId, config.enabled, min);
  await ctx.answerCallbackQuery({ text: `Min payout set to ${min} ETH` });
  await showAutoSellSettings(ctx, telegramId);
}

async function handleSetMaxSpend(ctx: Context, telegramId: bigint, data: string): Promise<void> {
  const max = parseFloat(data.replace(/^setspend_/, ""));
  if (!Number.isFinite(max) || max < 0) {
    await ctx.answerCallbackQuery({ text: "Invalid max spend" });
    return;
  }
  const config = await getSniperConfig(telegramId);
  await setSniperConfig(telegramId, config.autoCopy, max);
  await ctx.answerCallbackQuery({ text: `Max spend set to ${max} ETH` });
  await showTrackingMenu(ctx, telegramId);
}

async function handleToggleAutoCopy(ctx: Context, telegramId: bigint): Promise<void> {
  const config = await getSniperConfig(telegramId);
  await setSniperConfig(telegramId, !config.autoCopy, config.maxSpendEth);
  await showTrackingMenu(ctx, telegramId);
}

async function handleRemoveTracked(ctx: Context, telegramId: bigint, data: string): Promise<void> {
  const address = data.replace(/^del_tracked_/, "").toLowerCase();
  await removeTrackedWallet(telegramId, address);
  await showTrackedWallets(ctx, telegramId);
}

async function handleAutoMint(ctx: Context, telegramId: bigint, enabled: boolean): Promise<void> {
  await setAutoMintEnabled(telegramId, enabled);
  await ctx.answerCallbackQuery({ text: enabled ? "Auto-mint ON" : "Auto-mint OFF" });
  await showMainMenu(ctx, telegramId);
}

async function handleRemoveWatch(ctx: Context, telegramId: bigint, data: string): Promise<void> {
  const address = data.replace(/^rmwatch_/, "");
  await removeFromWatchlist(telegramId, address);
  await showWatchlist(ctx, telegramId);
}

async function handleScanAddress(ctx: Context, telegramId: bigint, data: string): Promise<void> {
  const address = normalizeAddressInput(data.replace(/^scan_/, ""));
  await performScan(ctx, telegramId, address);
}

async function handleMintAddress(ctx: Context, telegramId: bigint, data: string): Promise<void> {
  const address = normalizeAddressInput(data.replace(/^mint_/, ""));
  await performMint(ctx, telegramId, address);
}

async function handleConfirmMint(ctx: Context, telegramId: bigint, data: string): Promise<void> {
  const address = normalizeAddressInput(data.replace(/^confirm_mint_/, ""));
  await performMint(ctx, telegramId, address);
}

// ---------------------------------------------------------------------------
// Pending-input prompts
// ---------------------------------------------------------------------------
async function promptImport(ctx: Context): Promise<void> {
  pendingImports.set(userIdNumber(ctx), true);
  await editOrReply(
    ctx,
    `🔑 **Import a Wallet**\n\nSend me a private key (64 hex chars, with or without \`0x\`).\n\n⚠️ Keys are encrypted at rest.`,
    { reply_markup: backToMainKeyboard(), parse_mode: "Markdown" }
  );
}

async function promptCustomFund(ctx: Context): Promise<void> {
  pendingFunds.set(userIdNumber(ctx), true);
  await editOrReply(
    ctx,
    `💰 **Custom Fund Amount**\n\nSend the ETH amount to distribute to each sub-wallet (e.g. \`0.01\`).`,
    { reply_markup: backToMainKeyboard(), parse_mode: "Markdown" }
  );
}

async function promptScan(ctx: Context): Promise<void> {
  pendingScans.set(userIdNumber(ctx), true);
  await editOrReply(
    ctx,
    `🔍 **Scan a Contract**\n\nSend me a contract address (e.g. \`0x...\`).`,
    { reply_markup: backToMainKeyboard(), parse_mode: "Markdown" }
  );
}

async function promptMint(ctx: Context): Promise<void> {
  pendingMints.set(userIdNumber(ctx), true);
  await editOrReply(
    ctx,
    `🚀 **Manual Mint**\n\nSend me a contract address to mint from.`,
    { reply_markup: backToMainKeyboard(), parse_mode: "Markdown" }
  );
}

async function promptAddTracked(ctx: Context): Promise<void> {
  pendingTracked.set(userIdNumber(ctx), true);
  await editOrReply(
    ctx,
    `🎯 **Add Tracked Wallet**\n\nSend a wallet address to track for copy-mints.`,
    { reply_markup: backToMainKeyboard(), parse_mode: "Markdown" }
  );
}

// ---------------------------------------------------------------------------
// Callback dispatcher (most-specific prefixes first)
// ---------------------------------------------------------------------------
export async function handleCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  if (!data) return;
  const telegramId = BigInt(ctx.from?.id ?? 0);

  switch (data) {
    case "main_menu":
      return showMainMenu(ctx, telegramId);
    case "wallets":
      return showWallets(ctx, telegramId);
    case "new_wallet":
      return handleNewWallet(ctx, telegramId);
    case "import_key":
      return promptImport(ctx);
    case "export_keys":
      return showExportKeys(ctx, telegramId);
    case "delete_wallet":
      return showDeleteWallet(ctx, telegramId);
    case "fund_menu":
      return showFundMenu(ctx, telegramId);
    case "fund_custom":
      return promptCustomFund(ctx);
    case "sweep_dust":
      return runSweepDust(ctx, telegramId);
    case "sweep_nfts":
      return runSweepNfts(ctx, telegramId);
    case "portfolio":
      return showPortfolio(ctx, telegramId);
    case "settings":
      return showSettings(ctx);
    case "menu_gas_guard":
      return showGasSettings(ctx, telegramId);
    case "menu_mint_qty":
      return showQtySettings(ctx, telegramId);
    case "menu_autosell":
      return showAutoSellSettings(ctx, telegramId);
    case "menu_help_text":
      return showHelpText(ctx);
    case "toggle_autosell":
      return handleAutoSellToggle(ctx, telegramId);
    case "watchlist":
      return showWatchlist(ctx, telegramId);
    case "scan_contract":
      return promptScan(ctx);
    case "manual_mint":
      return promptMint(ctx);
    case "menu_tracking":
      return showTrackingMenu(ctx, telegramId);
    case "toggle_autocopy":
      return handleToggleAutoCopy(ctx, telegramId);
    case "menu_max_spend":
      return showMaxSpendSettings(ctx, telegramId);
    case "add_tracked_prompt":
      return promptAddTracked(ctx);
    case "list_tracked_wallets":
      return showTrackedWallets(ctx, telegramId);
    case "auto_on":
      return handleAutoMint(ctx, telegramId, true);
    case "auto_off":
      return handleAutoMint(ctx, telegramId, false);
  }

  if (data.startsWith("confirm_sell_")) return handleConfirmSell(ctx, telegramId, data);
  if (data.startsWith("cancel_sell_")) return handleCancelSell(ctx, data);
  if (data.startsWith("sell_")) return handleSell(ctx, telegramId, data);
  if (data.startsWith("copyaddr_")) return handleCopyAddress(ctx, telegramId, data);
  if (data.startsWith("del_tracked_")) return handleRemoveTracked(ctx, telegramId, data);
  if (data.startsWith("export_")) return handleExportWallet(ctx, data);
  if (data.startsWith("del_")) return handleDeleteWallet(ctx, telegramId, data);
  if (data.startsWith("toggle_")) return handleToggleWallet(ctx, telegramId, data);
  if (data.startsWith("set_as_")) return handleAutoSellMin(ctx, telegramId, data);
  if (data.startsWith("setspend_")) return handleSetMaxSpend(ctx, telegramId, data);
  if (data.startsWith("setqty_")) return handleSetQty(ctx, telegramId, data);
  if (data.startsWith("setgas_")) return handleSetGas(ctx, telegramId, data);
  if (data.startsWith("fund_")) return handleFundCallback(ctx, telegramId, data);
  if (data.startsWith("rmwatch_")) return handleRemoveWatch(ctx, telegramId, data);
  if (data.startsWith("confirm_mint_")) return handleConfirmMint(ctx, telegramId, data);
  if (data.startsWith("scan_")) return handleScanAddress(ctx, telegramId, data);
  if (data.startsWith("mint_")) return handleMintAddress(ctx, telegramId, data);

  await ctx.answerCallbackQuery({ text: "Unknown action" }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Text handler (pending inputs + fallback scan)
// ---------------------------------------------------------------------------
export async function handleText(ctx: Context): Promise<void> {
  const uid = userIdNumber(ctx);
  const telegramId = BigInt(uid);
  const text = (ctx.message?.text ?? "").trim();
  if (!text) return;

  if (pendingImports.get(uid)) {
    pendingImports.delete(uid);
    await performImport(ctx, telegramId, text);
    return;
  }

  if (pendingFunds.get(uid)) {
    pendingFunds.delete(uid);
    const amount = parseFloat(text);
    if (!Number.isFinite(amount) || amount <= 0) {
      await ctx.reply("❌ Invalid amount. Send a number like `0.01`.", { parse_mode: "Markdown" });
      return;
    }
    await runFund(ctx, telegramId, amount);
    return;
  }

  if (pendingTracked.get(uid)) {
    pendingTracked.delete(uid);
    const address = normalizeAddressInput(text);
    if (!isValidAddress(address)) {
      await ctx.reply("❌ Invalid address. Send a valid Base (EVM) address.", {
        reply_markup: backToMainKeyboard(),
      });
      return;
    }
    try {
      await addTrackedWallet(telegramId, address);
      await ctx.reply(`✅ Tracked wallet \`${address}\` added.`, { parse_mode: "Markdown" });
      await showTrackedWallets(ctx, telegramId);
    } catch (err) {
      await ctx.reply(`❌ ${errorMessage(err)}`, { reply_markup: backToMainKeyboard() });
    }
    return;
  }

  if (pendingScans.get(uid)) {
    pendingScans.delete(uid);
    const address = normalizeAddressInput(text);
    if (!isValidAddress(address)) {
      await ctx.reply("❌ Invalid address. Send a valid Base (EVM) address.", {
        reply_markup: backToMainKeyboard(),
      });
      return;
    }
    await performScan(ctx, telegramId, address);
    return;
  }

  if (pendingMints.get(uid)) {
    pendingMints.delete(uid);
    const address = normalizeAddressInput(text);
    if (!isValidAddress(address)) {
      await ctx.reply("❌ Invalid address. Send a valid Base (EVM) address.", {
        reply_markup: backToMainKeyboard(),
      });
      return;
    }
    await performMint(ctx, telegramId, address);
    return;
  }

  // Fallback: any pasted address is scanned.
  const address = normalizeAddressInput(text);
  if (isValidAddress(address)) {
    await performScan(ctx, telegramId, address);
    return;
  }

  await ctx.reply("❓ Send a valid contract address or use the menu buttons.", {
    reply_markup: backToMainKeyboard(),
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
    text += `Verified: ${result.isVerified ? "✅ Yes" : "⚠️ Bytecode only"}\n`;
    text += `🛡 **Security Status:** ${
      result.security.isSafe ? "✅ SAFE / CLEAN" : "🚨 HIGH RISK / HONEYPOT"
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
      let card = `${statusIcon} **${r.label}** — ${r.success ? "Minted!" : "Failed"}\n`;
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
      `📊 **Mint Summary**\n\nContract: \`${shortenAddress(address)}\`\n✅ Success: ${result.totalSuccess}\n❌ Failed: ${result.totalFailed}\nTotal Attempts: ${result.results.length}`,
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
