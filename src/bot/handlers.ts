import { type Context, InlineKeyboard } from "grammy";
import { getAddress, type Address, type Hex } from "viem";
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
import { analyzeBypassOptions, executeBypass } from "../core/bypassEngine.js";
import { whoisContract } from "../core/whois.js";
import { 
  batchMint, 
  getUserMintQuantity, 
  setUserMintQuantity 
} from "../core/mint.js";
import { 
  fetchWalletPortfolio, 
  executeSell 
} from "../core/portfolio.js";
import { 
  fetchCollectionFloor, 
  executeAutoListing 
} from "../core/autoLister.js";
import { sweepDustToMaster } from "../core/sweeper.js";
import { sweepAllNFTsToMaster } from "../core/nftSweeper.js";
import { fundSubWallets } from "../core/funder.js";
import { getEthUsdPrice, usdToEth } from "../core/price.js";
import { 
  checkGasSafety, 
  setUserGasCeiling 
} from "../core/gasGuard.js";
import { 
  getAutoSellConfig, 
  setAutoSellConfig 
} from "../core/autoSeller.js";
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
  maxSpendSettingsKeyboard,
} from "./keyboards.js";

interface SessionState {
  action: "import_key" | "scan" | "manual_mint" | "fund_custom" | "add_tracked" | "none";
  contractAddress?: string;
}

const sessions = new Map<bigint, SessionState>();

function getSession(userId: bigint): SessionState {
  if (!sessions.has(userId)) {
    sessions.set(userId, { action: "none" });
  }
  return sessions.get(userId)!;
}

function setSession(userId: bigint, state: SessionState) {
  sessions.set(userId, state);
}

function clearSession(userId: bigint) {
  sessions.set(userId, { action: "none" });
}

const MAIN_MENU_TEXT = `🤖 **Base Auto-Mint Bot**

Welcome! Manage your wallets, scan contracts, and auto-mint free NFTs on Base.

Select an option below:`;

export async function showMainMenu(ctx: Context) {
  const telegramId = BigInt(ctx.from!.id);
  const autoMint = await getAutoMintStatus(telegramId);
  await ctx.reply(MAIN_MENU_TEXT, {
    reply_markup: mainMenuKeyboard(autoMint),
    parse_mode: "Markdown",
  });
}

export async function startCommand(ctx: Context) {
  const telegramId = BigInt(ctx.from!.id);
  await ensureUser(telegramId);
  await showMainMenu(ctx);
}

export async function helpCommand(ctx: Context) {
  const text = `🛡 **Base Auto-Mint Bot — Help**

**Commands:**
/start — Show main menu
/help — Show this help

**Features:**
• 💼 Manage multiple wallets (generate, import, toggle, delete)
• 🎯 Whale Tracking & Copy-Mint — Mirror trades and mints from tracked addresses
• 💰 Auto-Sell — Automatically fills open bids when targets are reached
• 🏷 Auto-Listing — List NFTs instantly at live secondary market floor prices
• 🛡 Security Scanner — Automatic honeypot & drainer detection
• 🔢 Mint Multiplier — Set 1x to 10x mints per wallet per drop
• ⛽ Gas Guard — Automatically blocks mints if Base L2 gas surges
• ⛽ Refuel Gas — Distribute ETH from Wallet 1 to all sub-wallets
• 🧹 Sweep Dust — Consolidate left-over ETH from sub-wallets back to Wallet 1
• 📦 Sweep NFTs — Consolidate all minted NFTs into Wallet 1
• 🖼 Portfolio — View your minted NFTs, live floor prices, and instant-sell buttons
• 🔍 Scan any Base contract for free-mint functions

**Chain:** Base (Chain ID: 8453)`;

  await ctx.reply(text, {
    reply_markup: backToMainKeyboard(),
    parse_mode: "Markdown",
  });
}

export async function handleCallback(ctx: Context) {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const telegramId = BigInt(ctx.from!.id);
  await ctx.answerCallbackQuery();

  // Main menu
  if (data === "main_menu") {
    clearSession(telegramId);
    await ctx.editMessageText(MAIN_MENU_TEXT, {
      reply_markup: mainMenuKeyboard(await getAutoMintStatus(telegramId)),
      parse_mode: "Markdown",
    });
    return;
  }

  // Tracking / Copy-Mint menu
  if (data === "menu_tracking") {
    clearSession(telegramId);
    const config = await getSniperConfig(telegramId);
    const tracked = await getTrackedWallets(telegramId);
    await ctx.editMessageText(
      `🎯 **Whale Tracking & Copy-Mint Sniper**\n\n` +
      `Status: **${config.autoCopy ? "✅ Active" : "❌ Disabled"}**\n` +
      `Max Spend Filter: **${config.maxSpendEth === 0 ? "Free Mints Only" : `${config.maxSpendEth} ETH`}**\n` +
      `Tracked Wallets: **${tracked.length} address(es)**\n\n` +
      `When active, any NFT mint or buy executed by your tracked wallets will be automatically mirrored.`,
      {
        reply_markup: trackingMenuKeyboard(config.autoCopy, config.maxSpendEth, tracked.length),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  // Toggle auto-copy status
  if (data === "toggle_autocopy") {
    const config = await getSniperConfig(telegramId);
    const newStatus = !config.autoCopy;
    await setSniperConfig(telegramId, newStatus, config.maxSpendEth);
    const tracked = await getTrackedWallets(telegramId);
    await ctx.editMessageText(
      `🎯 **Whale Tracking & Copy-Mint Sniper**\n\n` +
      `Status: **${newStatus ? "✅ Active" : "❌ Disabled"}**\n` +
      `Max Spend Filter: **${config.maxSpendEth === 0 ? "Free Mints Only" : `${config.maxSpendEth} ETH`}**\n` +
      `Tracked Wallets: **${tracked.length} address(es)**\n\n` +
      `When active, any NFT mint or buy executed by your tracked wallets will be automatically mirrored.`,
      {
        reply_markup: trackingMenuKeyboard(newStatus, config.maxSpendEth, tracked.length),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  // Max spend menu
  if (data === "menu_max_spend") {
    clearSession(telegramId);
    const config = await getSniperConfig(telegramId);
    await ctx.editMessageText(
      `💵 **Max Spend per Mint / Buy**\n\nChoose the maximum amount of ETH your sub-wallets are allowed to spend when copying a tracked trade:`,
      {
        reply_markup: maxSpendSettingsKeyboard(config.maxSpendEth),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  // Set max spend value
  if (data.startsWith("setspend_")) {
    const val = parseFloat(data.slice(9));
    const config = await getSniperConfig(telegramId);
    await setSniperConfig(telegramId, config.autoCopy, val);
    const tracked = await getTrackedWallets(telegramId);
    await ctx.editMessageText(
      `✅ Max spend updated to **${val === 0 ? "Free Mints Only" : `${val} ETH`}**!`,
      {
        reply_markup: trackingMenuKeyboard(config.autoCopy, val, tracked.length),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  // Prompt to add tracked wallet
  if (data === "add_tracked_prompt") {
    setSession(telegramId, { action: "add_tracked" });
    await ctx.editMessageText(
      `➕ **Add Tracked Wallet**\n\nPlease send the wallet address (0x...) of the whale or smart trader you want to track, optionally followed by a label.\n\nExample: \`0x123...abc Smart Whale\``,
      {
        reply_markup: new InlineKeyboard().text("🔙 Back", "menu_tracking"),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  // List tracked wallets
  if (data === "list_tracked_wallets") {
    clearSession(telegramId);
    const tracked = await getTrackedWallets(telegramId);
    if (tracked.length === 0) {
      await ctx.editMessageText(`📋 **Tracked Wallets**\n\nYou are not tracking any wallets yet.`, {
        reply_markup: new InlineKeyboard().text("➕ Add Tracked Wallet", "add_tracked_prompt").row().text("🔙 Back", "menu_tracking"),
        parse_mode: "Markdown",
      });
      return;
    }

    let text = `📋 **Your Tracked Wallets (${tracked.length})**\n\n`;
    for (const tw of tracked) {
      text += `• **${tw.label || "Whale"}**: \`${tw.address}\`\n`;
    }

    await ctx.editMessageText(text, {
      reply_markup: trackedWalletsListKeyboard(tracked),
      parse_mode: "Markdown",
    });
    return;
  }

  // Remove specific tracked wallet
  if (data.startsWith("del_tracked_")) {
    const address = data.slice(12);
    await removeTrackedWallet(telegramId, address);
    const tracked = await getTrackedWallets(telegramId);
    
    let text = `📋 **Your Tracked Wallets (${tracked.length})**\n\n`;
    if (tracked.length === 0) {
      text += `You are not tracking any wallets yet.`;
    } else {
      for (const tw of tracked) {
        text += `• **${tw.label || "Whale"}**: \`${tw.address}\`\n`;
      }
    }

    await ctx.editMessageText(text, {
      reply_markup: trackedWalletsListKeyboard(tracked),
      parse_mode: "Markdown",
    });
    return;
  }

  // Settings menu
  if (data === "settings") {
    clearSession(telegramId);
    await ctx.editMessageText(
      `🛡 **Bot Settings & Controls**\n\nConfigure take-profit triggers, quantity multipliers, gas limits, and preferences:`,
      {
        reply_markup: settingsMenuKeyboard(),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  // Auto-sell settings menu
  if (data === "menu_autosell") {
    clearSession(telegramId);
    const config = getAutoSellConfig(telegramId);
    const ethPrice = await getEthUsdPrice();
    await ctx.editMessageText(
      `💰 **Auto-Sell / Take-Profit Router**\n\n` +
      `Status: **${config.enabled ? "✅ Active" : "❌ Disabled"}**\n` +
      `Minimum Payout Threshold: **${config.minPayoutEth} ETH (~$${(config.minPayoutEth * ethPrice).toFixed(2)})**\n\n` +
      `When active, any minted NFT that receives an open market bid at or above this threshold is sold automatically into liquidity.\n\n` +
      `Configure settings below:`,
      {
        reply_markup: autoSellSettingsKeyboard(config.enabled, config.minPayoutEth, ethPrice),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  // Toggle auto-sell status
  if (data === "toggle_autosell") {
    const current = getAutoSellConfig(telegramId);
    const newStatus = !current.enabled;
    setAutoSellConfig(telegramId, newStatus);
    const ethPrice = await getEthUsdPrice();
    await ctx.editMessageText(
      `💰 **Auto-Sell / Take-Profit Router**\n\n` +
      `Status: **${newStatus ? "✅ Active" : "❌ Disabled"}**\n` +
      `Minimum Payout Threshold: **${current.minPayoutEth} ETH (~$${(current.minPayoutEth * ethPrice).toFixed(2)})**\n\n` +
      `When active, any minted NFT that receives an open market bid at or above this threshold is sold automatically into liquidity.\n\n` +
      `Configure settings below:`,
      {
        reply_markup: autoSellSettingsKeyboard(newStatus, current.minPayoutEth, ethPrice),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  // Set min auto-sell threshold
  if (data.startsWith("set_as_")) {
    const val = parseFloat(data.slice(7));
    const current = getAutoSellConfig(telegramId);
    setAutoSellConfig(telegramId, current.enabled, val);
    const ethPrice = await getEthUsdPrice();
    await ctx.editMessageText(
      `✅ Auto-sell payout threshold set to **${val} ETH (~$${(val * ethPrice).toFixed(2)})**!`,
      {
        reply_markup: autoSellSettingsKeyboard(current.enabled, val, ethPrice),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  // Multiplier menu
  if (data === "menu_mint_qty") {
    clearSession(telegramId);
    const currentQty = getUserMintQuantity(telegramId);
    await ctx.editMessageText(
      `🔢 **Mint Multiplier (Per Wallet)**\n\n` +
      `Current Setting: **${currentQty}x per wallet**\n\n` +
      `When a new free drop arrives, each active wallet will attempt to mint this many times.\n\n` +
      `Select your preferred multiplier:`,
      {
        reply_markup: quantitySettingsKeyboard(currentQty),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  // Set multiplier value
  if (data.startsWith("setqty_")) {
    const qty = parseInt(data.slice(7), 10);
    setUserMintQuantity(telegramId, qty);
    await ctx.editMessageText(
      `✅ Mint multiplier updated to **${qty}x per wallet**!`,
      {
        reply_markup: quantitySettingsKeyboard(qty),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  // Gas guard sub-menu
  if (data === "menu_gas_guard") {
    clearSession(telegramId);
    const gasCheck = await checkGasSafety(telegramId);
    await ctx.editMessageText(
      `⛽ **Gas Price Ceiling Guard**\n\n` +
      `Current Base Gas Price: \`${gasCheck.currentGwei.toFixed(4)} Gwei\`\n` +
      `Your Configured Ceiling: \`${gasCheck.maxGwei} Gwei\`\n\n` +
      `If the network gas exceeds your limit, mints will safely abort to avoid high fees.\n\n` +
      `Select your maximum gas ceiling:`,
      {
        reply_markup: gasSettingsKeyboard(gasCheck.maxGwei),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  // Set gas ceiling
  if (data.startsWith("setgas_")) {
    const val = parseFloat(data.slice(7));
    setUserGasCeiling(telegramId, val);
    await ctx.editMessageText(
      `✅ Gas ceiling updated to **${val} Gwei**!\n\nThe bot will skip mints if network gas rises above this level.`,
      {
        reply_markup: gasSettingsKeyboard(val),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  // Settings help text
  if (data === "menu_help_text") {
    clearSession(telegramId);
    await helpCommand(ctx);
    return;
  }

  // Portfolio screen
  if (data === "portfolio") {
    clearSession(telegramId);
    await showPortfolioScreen(ctx, telegramId);
    return;
  }

  // Sweep all NFTs to Wallet 1
  if (data === "sweep_nfts") {
    clearSession(telegramId);
    const wallets = await getWallets(telegramId);
    if (wallets.length < 2) {
      await ctx.reply("❌ You need at least 2 wallets to consolidate NFTs.", {
        reply_markup: backToWalletsKeyboard(),
      });
      return;
    }

    const masterVault = wallets[0].address;
    await ctx.reply(`📦 *Consolidating all sub-wallet NFTs into ${wallets[0].label} (\`${shortenAddress(masterVault)}\`)...*`, {
      parse_mode: "Markdown",
    });

    try {
      const sweep = await sweepAllNFTsToMaster(telegramId, masterVault);
      if (sweep.totalMoved === 0) {
        await ctx.reply("ℹ️ No NFTs found in sub-wallets to sweep.", {
          reply_markup: portfolioKeyboard(),
        });
        return;
      }

      let report = `✅ **NFT Consolidation Completed!**\n\n📦 **Total Moved:** \`${sweep.totalMoved} NFT(s)\`\n📥 **Destination:** \`${shortenAddress(masterVault)}\`\n\n`;

      for (const res of sweep.results) {
        if (res.txHash) {
          report += `• **${res.collectionName}** (#${res.tokenId}) from ${res.fromWallet} ([Tx](https://basescan.org/tx/${res.txHash}))\n`;
        } else {
          report += `• Failed #${res.tokenId} (${res.error})\n`;
        }
      }

      await ctx.reply(report, {
        parse_mode: "Markdown",
        link_preview_options: { is_disabled: true },
        reply_markup: portfolioKeyboard(),
      });
    } catch (err) {
      await ctx.reply(`❌ NFT sweep failed: ${errorMessage(err)}`, {
        reply_markup: portfolioKeyboard(),
      });
    }
    return;
  }

  // Instant sell execution (Panic Sell / Liquidate Now)
  if (data.startsWith("sell_")) {
    const parts = data.split("_");
    const contractAddr = parts[1];
    const tokenId = parts[2];
    const walletId = parts[3];

    await ctx.reply(`⚡ Checking liquidity & executing instant sell for token #${tokenId}...`);

    try {
      const privateKey = await getWalletPrivateKey(walletId);
      const hexKey = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;

      const result = await executeSell(hexKey, contractAddr, tokenId);

      if (result.success) {
        await ctx.reply(
          `🎉 **NFT SOLD SUCCESSFULLY!**\n\n` +
          `💰 Payout: \`${result.payoutEth} ETH\`\n` +
          `🔗 [View BaseScan Receipt](https://basescan.org/tx/${result.txHash})`,
          { parse_mode: "Markdown" }
        );
      } else {
        await ctx.reply(`❌ Instant sell failed: ${result.error || "No active market bids available"}`);
      }
    } catch (err) {
      await ctx.reply(`❌ Sell execution failed: ${errorMessage(err)}`);
    }
    return;
  }

  // Instant marketplace listing execution
  if (data.startsWith("list_")) {
    const parts = data.split("_");
    const contractAddr = parts[1];
    const tokenId = parts[2];
    const walletId = parts[3];

    await ctx.reply(`🏷 Fetching floor price & building marketplace listing for token #${tokenId}...`);

    try {
      const floorData = await fetchCollectionFloor(contractAddr);
      if (floorData.floorPriceEth <= 0) {
        await ctx.reply(`❌ Cannot list item: No active floor price found on secondary markets yet.`);
        return;
      }

      const privateKey = await getWalletPrivateKey(walletId);
      const hexKey = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;

      const result = await executeAutoListing(hexKey, contractAddr, tokenId, floorData.floorPriceEth);

      if (result.success) {
        await ctx.reply(
          `🎉 **NFT LISTED SUCCESSFULLY ON MARKETPLACE!**\n\n` +
          `🏷 List Price: \`${floorData.floorPriceEth} ETH\`\n` +
          `🔗 [View BaseScan Receipt](https://basescan.org/tx/${result.txHash})`,
          { parse_mode: "Markdown" }
        );
      } else {
        await ctx.reply(`❌ Listing failed: ${result.error || "Unable to broadcast transaction"}`);
      }
    } catch (err) {
      await ctx.reply(`❌ Listing execution failed: ${errorMessage(err)}`);
    }
    return;
  }

  // Gas funding menu
  if (data === "fund_menu") {
    clearSession(telegramId);
    const wallets = await getWallets(telegramId);
    if (wallets.length < 2) {
      await ctx.reply("❌ You need at least 2 wallets (Wallet 1 + sub-wallets) to distribute gas.", {
        reply_markup: backToWalletsKeyboard(),
      });
      return;
    }

    const ethPrice = await getEthUsdPrice();

    await ctx.editMessageText(
      `⛽ **Distribute Gas to All Sub-Wallets**\n\n` +
      `Master: **${wallets[0].label}** (\`${shortenAddress(wallets[0].address)}\`)\n` +
      `Target Recipients: **${wallets.length - 1} sub-wallets**\n` +
      `ETH/USD Price: **$${ethPrice.toLocaleString()}**\n\n` +
      `Select a preset or tap **Custom Amount**:`,
      {
        reply_markup: fundAmountKeyboard(ethPrice),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  // Custom fund amount prompt
  if (data === "fund_custom") {
    setSession(telegramId, { action: "fund_custom" });
    await ctx.editMessageText(
      `✍️ **Enter Custom Funding Amount**\n\n` +
      `Type the amount you want to send to each sub-wallet:\n\n` +
      `• In USD: e.g. \`$1.50\` or \`2 usd\`\n` +
      `• In ETH: e.g. \`0.0004 eth\``,
      {
        reply_markup: backToWalletsKeyboard(),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  // Fund preset execution
  if (data.startsWith("fund_")) {
    const amountStr = data.slice(5);
    const amountEth = parseFloat(amountStr);

    await ctx.reply(`🚀 *Distributing ${amountEth} ETH to each sub-wallet...*`, {
      parse_mode: "Markdown",
    });

    try {
      const fund = await fundSubWallets(telegramId, amountEth);
      let report = `✅ **Gas Distribution Completed!**\n\n💰 **Total Dispatched:** \`${fund.totalDistributedEth.toFixed(5)} ETH\`\n\n`;

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

  // Wallets screen
  if (data === "wallets") {
    clearSession(telegramId);
    await showWalletsScreen(ctx, telegramId);
    return;
  }

  // Sweep ETH dust
  if (data === "sweep_dust") {
    clearSession(telegramId);
    const wallets = await getWallets(telegramId);
    if (wallets.length < 2) {
      await ctx.reply("❌ You need at least 2 wallets to consolidate funds.", {
        reply_markup: backToWalletsKeyboard(),
      });
      return;
    }

    const masterWallet = wallets[0].address;
    await ctx.reply(`🧹 *Consolidating all wallet balances into ${wallets[0].label} (\`${shortenAddress(masterWallet)}\`)...*`, {
      parse_mode: "Markdown",
    });

    try {
      const sweep = await sweepDustToMaster(telegramId, masterWallet);
      let report = `✅ **Sweep Completed!**\n\n💰 **Total Collected:** \`${sweep.totalSweptEth.toFixed(6)} ETH\`\n📥 **Destination:** \`${shortenAddress(masterWallet)}\`\n\n`;

      for (const res of sweep.results) {
        if (res.txHash) {
          report += `• **${res.walletLabel}**: Swept \`${res.sweptEth.toFixed(6)} ETH\` ([Tx](https://basescan.org/tx/${res.txHash}))\n`;
        } else if (res.error && res.error !== "0 balance") {
          report += `• **${res.walletLabel}**: Skipped (${res.error})\n`;
        }
      }

      await ctx.reply(report, {
        parse_mode: "Markdown",
        link_preview_options: { is_disabled: true },
        reply_markup: backToWalletsKeyboard(),
      });
    } catch (err) {
      await ctx.reply(`❌ Sweep failed: ${errorMessage(err)}`, {
        reply_markup: backToWalletsKeyboard(),
      });
    }
    return;
  }

  // New wallet
  if (data === "new_wallet") {
    clearSession(telegramId);
    try {
      const wallet = await generateNewWallet(telegramId);
      await ctx.reply(
        `✅ New wallet generated!\n\n📋 Label: ${wallet.label}\n📍 Address: \`${wallet.address}\`\n\nThis wallet is now active (✅) and ready to mint.`,
        { parse_mode: "Markdown", reply_markup: backToWalletsKeyboard() }
      );
    } catch (error) {
      await ctx.reply(`❌ Failed to generate wallet: ${errorMessage(error)}`, {
        reply_markup: backToMainKeyboard(),
      });
    }
    return;
  }

  // Import key
  if (data === "import_key") {
    setSession(telegramId, { action: "import_key" });
    await ctx.editMessageText(
      `📥 **Import Wallet by Private Key**\n\nPlease paste your private key directly in the chat.\n\nFormat: 64 hex characters (with or without 0x prefix)\n\n⚠️ Your key will be encrypted with AES-256-GCM before storage.`,
      { parse_mode: "Markdown", reply_markup: backToMainKeyboard() }
    );
    return;
  }

  // Export keys
  if (data === "export_keys") {
    clearSession(telegramId);
    await showExportScreen(ctx, telegramId);
    return;
  }

  // Delete wallet
  if (data === "delete_wallet") {
    clearSession(telegramId);
    await showDeleteScreen(ctx, telegramId);
    return;
  }

  // Toggle wallet
  if (data.startsWith("toggle_")) {
    const walletId = data.slice(7);
    const updated = await toggleWallet(walletId);
    if (updated) {
      await showWalletsScreen(ctx, telegramId);
    } else {
      await ctx.reply("❌ Wallet not found.", { reply_markup: backToWalletsKeyboard() });
    }
    return;
  }

  // Delete specific wallet
  if (data.startsWith("del_")) {
    const walletId = data.slice(4);
    const deleted = await deleteWallet(walletId);
    if (deleted) {
      await ctx.reply("✅ Wallet deleted successfully.", {
        reply_markup: backToWalletsKeyboard(),
      });
    } else {
      await ctx.reply("❌ Wallet not found.", { reply_markup: backToWalletsKeyboard() });
    }
    return;
  }

  // Export specific wallet key
  if (data.startsWith("export_")) {
    const walletId = data.slice(7);
    try {
      const privateKey = await getWalletPrivateKey(walletId);
      const wallets = await getWallets(telegramId);
      const wallet = wallets.find((w) => w.id === walletId);
      const label = wallet?.label || "Unknown";

      await ctx.reply(
        `🔑 **PRIVATE KEY**\n\nWallet: ${label}\nAddress: \`${wallet?.address || ""}\`\nPrivate Key: \`${privateKey}\`\n\n⚠️ Please delete this message manually after saving your key safely.`,
        { parse_mode: "Markdown" }
      );

      await ctx.reply("Saved your key? You can return to your wallets below:", {
        reply_markup: backToWalletsKeyboard(),
      });
    } catch (error) {
      await ctx.reply(`❌ Failed to export key: ${errorMessage(error)}`, {
        reply_markup: backToWalletsKeyboard(),
      });
    }
    return;
  }

  // Scan contract
  if (data === "scan_contract") {
    setSession(telegramId, { action: "scan" });
    await ctx.editMessageText(
      `🔍 **Scan Contract**\n\nPlease paste a contract address (0x...) directly in the chat to scan it for free-mint functions.`,
      { parse_mode: "Markdown", reply_markup: backToMainKeyboard() }
    );
    return;
  }

  // Watchlist
  if (data === "watchlist") {
    clearSession(telegramId);
    await showWatchlistScreen(ctx, telegramId);
    return;
  }

  // Auto-mint toggle
  if (data === "auto_on" || data === "auto_off") {
    const enabled = data === "auto_on";
    await setAutoMintEnabled(telegramId, enabled);
    await ctx.editMessageText(
      `${MAIN_MENU_TEXT}\n\n✅ Auto-Mint is now ${enabled ? "ON" : "OFF"}.`,
      {
        reply_markup: mainMenuKeyboard(enabled),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  // Manual mint
  if (data === "manual_mint") {
    setSession(telegramId, { action: "manual_mint" });
    await ctx.editMessageText(
      `🚀 **Manual Mint**\n\nPlease paste a contract address (0x...) to mint from all your active (✅) wallets.`,
      { parse_mode: "Markdown", reply_markup: backToMainKeyboard() }
    );
    return;
  }

  // Scan from watchlist
  if (data.startsWith("scan_")) {
    const addr = data.slice(5);
    clearSession(telegramId);
    await performScan(ctx, telegramId, addr);
    return;
  }

  // Mint from watchlist
  if (data.startsWith("mint_")) {
    const addr = data.slice(5);
    clearSession(telegramId);
    await performMint(ctx, telegramId, addr);
    return;
  }

  // Remove from watchlist
  if (data.startsWith("rmwatch_")) {
    const addr = data.slice(8);
    await removeFromWatchlist(telegramId, addr);
    await showWatchlistScreen(ctx, telegramId);
    return;
  }

  // Confirm mint
  if (data.startsWith("confirm_mint_")) {
    const addr = data.slice(13);
    clearSession(telegramId);
    await performMint(ctx, telegramId, addr);
    return;
  }
}

export async function handleText(ctx: Context) {
  if (!ctx.message || !ctx.message.text) return;
  if (!ctx.from) return;

  const telegramId = BigInt(ctx.from.id);
  const text = ctx.message.text.trim();
  const session = getSession(telegramId);

  // Handle adding tracked whale wallet via text input
  if (session.action === "add_tracked") {
    clearSession(telegramId);
    const parts = text.split(/\s+/);
    const address = parts[0];
    const label = parts.slice(1).join(" ") || "Tracked Whale";

    if (!isValidAddress(address)) {
      await ctx.reply("❌ Invalid wallet address. Please enter a valid 0x address.", {
        reply_markup: new InlineKeyboard().text("🔙 Back", "menu_tracking"),
      });
      return;
    }

    await addTrackedWallet(telegramId, address, label);
    const tracked = await getTrackedWallets(telegramId);
    const config = await getSniperConfig(telegramId);

    await ctx.reply(
      `✅ **Successfully added tracked wallet!**\n\nAddress: \`${address}\`\nLabel: ${label}\n\nYour sniper is ready.`,
      {
        reply_markup: trackingMenuKeyboard(config.autoCopy, config.maxSpendEth, tracked.length),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  // Handle custom gas funding input
  if (session.action === "fund_custom") {
    clearSession(telegramId);
    let amountEth = 0;
    const clean = text.toLowerCase().replace("$", "").replace("usd", "").replace("eth", "").trim();
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

    await ctx.reply(`🚀 *Distributing ${amountEth} ETH (~$${numericVal.toFixed(2)}) to each sub-wallet...*`, {
      parse_mode: "Markdown",
    });

    try {
      const fund = await fundSubWallets(telegramId, amountEth);
      let report = `✅ **Gas Distribution Completed!**\n\n💰 **Total Dispatched:** \`${fund.totalDistributedEth.toFixed(5)} ETH\`\n\n`;

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

  // Contract address auto-scan
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

  // Private key import
  if (isValidPrivateKey(text)) {
    if (session.action === "import_key") {
      clearSession(telegramId);
      await performImport(ctx, telegramId, text);
      return;
    }
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

async function showPortfolioScreen(ctx: Context, telegramId: bigint) {
  const wallets = await getWallets(telegramId);

  if (wallets.length === 0) {
    const text = `🖼 **My Portfolio**\n\nNo wallets found. Generate or import a wallet first.`;
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { reply_markup: backToMainKeyboard(), parse_mode: "Markdown" });
    } else {
      await ctx.reply(text, { reply_markup: backToMainKeyboard(), parse_mode: "Markdown" });
    }
    return;
  }

  let text = `📊 **Base NFT Portfolio & Valuation**\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  let combinedFloorEth = 0;
  let totalNftsHeld = 0;
  const sellButtons: Array<Array<{ text: string; callback_data: string }>> = [];

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const portfolio = await fetchWalletPortfolio(w.address);
    const shortAddr = shortenAddress(w.address);

    let walletFloorEth = 0;
    for (const item of portfolio.items) {
      const floorData = await fetchCollectionFloor(item.contractAddress);
      item.floorPriceEth = floorData.floorPriceEth;
      item.topBidEth = floorData.topBidEth;
      if (floorData.collectionName && floorData.collectionName !== "Base NFT Collection") {
        item.collectionName = floorData.collectionName;
      }
      walletFloorEth += item.floorPriceEth;
    }

    text += `👛 **${w.label}** (\`${shortAddr}\`):\n`;
    text += `📦 Holdings: ${portfolio.totalNfts} NFT(s)\n`;
    text += `💎 Est. Floor Value: ${walletFloorEth.toFixed(4)} ETH\n`;

    if (portfolio.items.length > 0) {
      for (const item of portfolio.items.slice(0, 3)) {
        const floorDisplay = item.floorPriceEth > 0 ? `${item.floorPriceEth} ETH` : "Unlisted";
        const bidDisplay = item.topBidEth > 0 ? `${item.topBidEth} ETH` : "None";
        text += `  • **${item.collectionName}** (#${item.tokenId})\n`;
        text += `    Floor: \`${floorDisplay}\` | Bid: \`${bidDisplay}\`\n`;
        text += `    🔗 [OpenSea](${item.openseaUrl})\n`;

        sellButtons.push([
          { 
            text: `💰 Liquidate #${item.tokenId} (${item.topBidEth > 0 ? `${item.topBidEth} ETH` : "Dump"})`, 
            callback_data: `sell_${item.contractAddress}_${item.tokenId}_${w.id}` 
          },
          {
            text: `🏷 List at Floor`,
            callback_data: `list_${item.contractAddress}_${item.tokenId}_${w.id}`
          }
        ]);
      }
    } else {
      text += `  _No NFTs found in this wallet._\n`;
    }
    text += `\n`;

    combinedFloorEth += walletFloorEth;
    totalNftsHeld += portfolio.totalNfts;
  }

  text += `━━━━━━━━━━━━━━━━━━━━\n`;
  text += `🏷 **Total NFTs Across Wallets:** ${totalNftsHeld}\n`;
  text += `💰 **Combined Floor Value:** ${combinedFloorEth.toFixed(4)} ETH`;

  const kb = portfolioKeyboard();
  for (const btnRow of sellButtons) {
    kb.row(...btnRow.map((b) => InlineKeyboard.text(b.text, b.callback_data)));
  }

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, {
      reply_markup: kb,
      parse_mode: "Markdown",
      link_preview_options: { is_disabled: true },
    });
  } else {
    await ctx.reply(text, {
      reply_markup: kb,
      parse_mode: "Markdown",
      link_preview_options: { is_disabled: true },
    });
  }
}

async function showWalletsScreen(ctx: Context, telegramId: bigint) {
  const wallets = await getWallets(telegramId);

  if (wallets.length === 0) {
    await ctx.editMessageText(
      `💼 **My Wallets**\n\nNo wallets yet. Generate a new wallet or import an existing one.`,
      {
        reply_markup: new InlineKeyboard()
          .text("➕ Generate New", "new_wallet").row()
          .text("📥 Import Key", "import_key").row()
          .text("🏠 Main Menu", "main_menu"),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  const balances = await fetchAllWalletsBalances(wallets);

  let text = `💼 **My Wallets & Gas Balances**\n`;
  text += `Total: ${wallets.length} | Active: ${wallets.filter((w) => w.isActive).length}\n\n`;
  text += `Click a wallet to toggle its active state:\n`;
  text += `✅ = allowed to mint | ❌ = disabled\n\n`;

  wallets.forEach((w, index) => {
    const bal = balances.find((b) => b.address.toLowerCase() === w.address.toLowerCase()) || {
      ethBalance: "0.0000",
      usdBalance: "0.00",
    };
    const statusIcon = w.isActive ? "✅" : "❌";
    text += `${statusIcon} **W${index}**: \`${shortenAddress(w.address)}\`\n`;
    text += `   💰 **$${bal.usdBalance}** | \`${bal.ethBalance} ETH\`\n\n`;
  });

  await ctx.editMessageText(text, {
    reply_markup: walletsKeyboard(wallets),
    parse_mode: "Markdown",
  });
}

async function showDeleteScreen(ctx: Context, telegramId: bigint) {
  const wallets = await getWallets(telegramId);

  if (wallets.length === 0) {
    await ctx.editMessageText("No wallets to delete.", {
      reply_markup: backToWalletsKeyboard(),
    });
    return;
  }

  await ctx.editMessageText(
    `🗑 **Delete Wallet**\n\nClick a wallet to permanently delete it. This cannot be undone!`,
    {
      reply_markup: deleteWalletKeyboard(wallets),
      parse_mode: "Markdown",
    }
  );
}

async function showExportScreen(ctx: Context, telegramId: bigint) {
  const wallets = await getWallets(telegramId);

  if (wallets.length === 0) {
    await ctx.editMessageText("No wallets to export.", {
      reply_markup: backToWalletsKeyboard(),
    });
    return;
  }

  await ctx.editMessageText(
    `🔑 **Export Keys**\n\n⚠️ **WARNING:** Exported keys will be shown in plain text. Save them immediately and delete the message.\n\nClick a wallet to reveal its private key:`,
    {
      reply_markup: exportWalletsKeyboard(wallets),
      parse_mode: "Markdown",
    }
  );
}

async function showWatchlistScreen(ctx: Context, telegramId: bigint) {
  const items = await getWatchlist(telegramId);
  const contracts = items.map((w) => w.contractAddress);

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

  await ctx.editMessageText(text, {
    reply_markup: watchlistKeyboard(contracts),
    parse_mode: "Markdown",
  });
}

async function performScan(ctx: Context, telegramId: bigint, address: string) {
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
    text += `🛡 **Security Status:** ${result.security.isSafe ? "✅ SAFE / CLEAN" : "🚨 HIGH RISK / HONEYPOT"}\n`;
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

async function performMint(ctx: Context, telegramId: bigint, address: string) {
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

async function performImport(ctx: Context, telegramId: bigint, privateKey: string) {
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// /bypass <contractAddress> — read-only whitelist-gate analysis (zero gas)
// ---------------------------------------------------------------------------
async function bypassCommand(ctx: Context) {
  const telegramId = BigInt(ctx.from?.id ?? 0);
  const parts = (ctx.message?.text ?? "").trim().split(/\s+/);
  const rawAddr = parts[1];

  if (!rawAddr || !isValidAddress(rawAddr)) {
    await ctx.reply(
      "Usage: `/bypass <contract_address>`\n\n" +
      "Example: `/bypass 0xcd555B393D18c6253CfdDa3Cc591E508D1Ff750E`\n\n" +
      "Read-only analysis (zero gas). Lists bypass strategies. To execute one:\n" +
      "`/bypassexec <contract_address> <strategyId>`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const contractAddress = rawAddr.startsWith("0x") ? rawAddr : `0x${rawAddr}`;

  // Probe from the user's first active wallet so simulations match reality.
  const wallets = await getWallets(telegramId);
  const attacker = (wallets.length > 0
    ? getAddress(wallets[0].address)
    : "0x0000000000000000000000000000000000000001") as Address;

  await ctx.reply(`🔍 Analyzing whitelist gate for \`${shortenAddress(contractAddress)}\`...`, {
    parse_mode: "Markdown",
  });

  try {
    const report = await analyzeBypassOptions(contractAddress, attacker);

    let msg = `🧬 **Whitelist Gate Analysis**\n\n`;
    msg += `Contract: \`${report.contractAddress}\`\n`;
    msg += `Gate Type: \`${report.fingerprint.gateType}\`\n`;

    if (report.fingerprint.merkleRootPresent && report.fingerprint.merkleRootValue) {
      msg += `🌳 Merkle Root: \`${report.fingerprint.merkleRootValue}\`\n`;
    }
    if (report.fingerprint.openAdminSetters.length > 0) {
      msg += `🚨 Open admin setters (callable by ANYONE):\n`;
      for (const s of report.fingerprint.openAdminSetters) {
        msg += `• \`${s.signature}\`\n`;
      }
    }
    for (const note of report.fingerprint.notes.slice(0, 5)) {
      msg += `ℹ️ ${note}\n`;
    }
    msg += `\n`;

    msg += `**Strategies:**\n`;
    for (const s of report.strategies) {
      const icon = s.executable ? "✅" : "❌";
      msg += `${icon} \`${s.id}\` — ${s.name}\n`;
    }

    const execStrat = report.strategies.find((s) => s.executable && s.id !== "mint_open");
    msg += `\n_To execute, reply:_\n`;
    msg += `\`/bypassexec ${report.contractAddress} ${execStrat ? execStrat.id : "mint_open"}\``;

    await ctx.reply(msg, {
      parse_mode: "Markdown",
      link_preview_options: { is_disabled: true },
    });
  } catch (error) {
    await ctx.reply(`❌ Bypass analysis failed: ${errorMessage(error)}`, {
      reply_markup: backToMainKeyboard(),
    });
  }
}

// ---------------------------------------------------------------------------
// /bypassexec <contractAddress> <strategyId> — confirmed execution + audit log
// ---------------------------------------------------------------------------
async function bypassExecCommand(ctx: Context) {
  const telegramId = BigInt(ctx.from?.id ?? 0);
  const parts = (ctx.message?.text ?? "").trim().split(/\s+/);
  const rawAddr = parts[1];
  const strategyId = parts[2];

  if (!rawAddr || !strategyId || !isValidAddress(rawAddr)) {
    await ctx.reply(
      "Usage: `/bypassexec <contract_address> <strategyId>`\n\n" +
      "Run `/bypass <contract_address>` first to list available strategy IDs.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const contractAddress = rawAddr.startsWith("0x") ? rawAddr : `0x${rawAddr}`;

  await ctx.reply(
    `⚡ Executing bypass \`${strategyId}\` on \`${shortenAddress(contractAddress)}\` across active wallets...\n\n` +
    `_Security gate + per-wallet simulation run before every transaction._`,
    { parse_mode: "Markdown" }
  );

  try {
    const outcome = await executeBypass(telegramId, contractAddress, strategyId);

    let msg = `📊 **Bypass Execution Report**\n\n`;
    msg += `Contract: \`${outcome.contractAddress}\`\n`;
    msg += `Strategy: \`${outcome.strategyId}\`\n\n`;

    for (const r of outcome.results) {
      const icon = r.success ? "✅" : "❌";
      msg += `${icon} **${r.walletLabel}** — ${r.success ? "Success" : "Failed"}\n`;
      msg += `Wallet: \`${shortenAddress(r.walletAddress)}\`\n`;
      if (r.txHash) msg += `TX: [${shortenAddress(r.txHash, 8, 8)}](https://basescan.org/tx/${r.txHash})\n`;
      if (r.error) msg += `Error: ${r.error}\n`;
      msg += `\n`;
    }

    await ctx.reply(msg, {
      parse_mode: "Markdown",
      reply_markup: backToMainKeyboard(),
      link_preview_options: { is_disabled: true },
    });
  } catch (error) {
    await ctx.reply(`❌ Bypass execution failed: ${errorMessage(error)}`, {
      reply_markup: backToMainKeyboard(),
    });
  }
}

// ---------------------------------------------------------------------------
// /whois <contractAddress> — find the project behind a contract
// ---------------------------------------------------------------------------
async function whoisCommand(ctx: Context) {
  const parts = (ctx.message?.text ?? "").trim().split(/\s+/);
  const rawAddr = parts[1];

  if (!rawAddr || !isValidAddress(rawAddr)) {
    await ctx.reply(
      "Usage: `/whois <contract_address>`\n\nExample: `/whois 0xcd555B393D18c6253CfdDa3Cc591E508D1Ff750E`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const contractAddress = rawAddr.startsWith("0x") ? rawAddr : `0x${rawAddr}`;

  await ctx.reply(`🔎 Looking up \`${shortenAddress(contractAddress)}\`...`, { parse_mode: "Markdown" });

  try {
    const report = await whoisContract(contractAddress);

    let msg = `🕵️ **Contract Lookup**\n\n`;
    msg += `Contract: \`${report.contractAddress}\`\n`;
    if (report.contractName) msg += `Name: \`${report.contractName}\`\n`;
    if (report.symbol) msg += `Symbol: \`${report.symbol}\`\n`;
    if (report.collectionName) msg += `Collection: \`${report.collectionName}\`\n`;
    if (report.externalUrl) msg += `🌐 Project: ${report.externalUrl}\n`;
    if (report.metadataUrl) msg += `📦 Metadata: ${report.metadataUrl}\n`;
    if (report.openseaUrl) msg += `🖼 OpenSea: ${report.openseaUrl}\n`;
    for (const note of report.notes) msg += `ℹ️ ${note}\n`;

    await ctx.reply(msg, {
      parse_mode: "Markdown",
      reply_markup: backToMainKeyboard(),
      link_preview_options: { is_disabled: true },
    });
  } catch (error) {
    await ctx.reply(`❌ Lookup failed: ${errorMessage(error)}`, {
      reply_markup: backToMainKeyboard(),
    });
  }
}
