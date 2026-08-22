import { type Bot } from "grammy";
import { prisma } from "../db/client.js";
import { fetchWalletPortfolio } from "./portfolio.js";
import { shortenAddress } from "./chain.js";
import { getAutoSellConfig, processAutoSellForToken } from "./autoSeller.js";

const knownFloors = new Map<string, number>();
const knownFloorsOrder: string[] = [];
const MAX_FLOOR_ENTRIES = 5000;

const soldTokens = new Set<string>();
const soldTokensOrder: string[] = [];
const MAX_SOLD_ENTRIES = 5000;

function setFloor(key: string, value: number): void {
  if (!knownFloors.has(key)) {
    knownFloors.set(key, value);
    knownFloorsOrder.push(key);
    while (knownFloorsOrder.length > MAX_FLOOR_ENTRIES) {
      const oldest = knownFloorsOrder.shift();
      if (oldest) knownFloors.delete(oldest);
    }
  } else {
    knownFloors.set(key, value);
  }
}

function markSold(key: string): void {
  if (soldTokens.has(key)) return;
  soldTokens.add(key);
  soldTokensOrder.push(key);
  while (soldTokensOrder.length > MAX_SOLD_ENTRIES) {
    const oldest = soldTokensOrder.shift();
    if (oldest) soldTokens.delete(oldest);
  }
}

export function startFloorWatcher(bot: Bot<any>, intervalSeconds: number = 300) {
  console.log(`📈 NFT Floor Price & Auto-Sell Watcher active (interval: ${intervalSeconds}s)...`);

  const runCheck = async () => {
    try {
      const users = (await (prisma as any).user.findMany({
        include: { wallets: true },
      })) as Array<any>;

      for (const user of users) {
        if (!user.wallets || user.wallets.length === 0) continue;

        const userIdBigInt = BigInt(user.telegramId);
        const targetChatId =
          typeof user.telegramId === "bigint" ? Number(user.telegramId) : user.telegramId;

        const autoSellConfig = getAutoSellConfig(userIdBigInt);

        for (const wallet of user.wallets) {
          // One bad wallet (RPC/API hiccup) must not abort the rest of the user's cycle.
          try {
            const portfolio = await fetchWalletPortfolio(wallet.address);
            if (portfolio.items.length === 0) continue;

            for (const item of portfolio.items) {
              const tokenKey = `${item.contractAddress.toLowerCase()}:${item.tokenId}`;
              if (soldTokens.has(tokenKey)) continue;

              const lastFloor = knownFloors.get(tokenKey) ?? 0;
              const currentFloor = item.floorPriceEth;
              const currentBid = item.topBidEth;

              // 1. Auto-Sell Trigger
              if (autoSellConfig.enabled && currentBid >= autoSellConfig.minPayoutEth) {
                const sellResult = await processAutoSellForToken(
                  userIdBigInt,
                  item.contractAddress,
                  item.tokenId,
                  currentBid,
                  wallet.id
                );

                if (sellResult.success) {
                  markSold(tokenKey);
                  await bot.api
                    .sendMessage(
                      targetChatId,
                      `⚡ **AUTO-SELL EXECUTED!**\n\n` +
                        `🎨 **Collection:** ${item.collectionName} (#${item.tokenId})\n` +
                        `👛 **Wallet:** ${wallet.label}\n` +
                        `💰 **Payout Realized:** \`${sellResult.payoutEth} ETH\`\n` +
                        `🔗 [View BaseScan Receipt](https://basescan.org/tx/${sellResult.txHash})`,
                      { parse_mode: "Markdown" }
                    )
                    .catch((err) => console.error("Auto-sell alert error:", err));
                  continue;
                }
              }

              // 2. Manual value alert when floor appears/rises (real data only —
              //    portfolio returns 0 floor for collections with no market data).
              if (currentFloor > 0 && currentFloor > lastFloor) {
                setFloor(tokenKey, currentFloor);

                const alertMsg =
                  `🔥 *NFT VALUE DETECTED!*\n\n` +
                  `🎨 *Collection:* ${item.collectionName}\n` +
                  `🔢 *Token ID:* \`#${item.tokenId}\`\n` +
                  `👛 *Wallet:* ${wallet.label} (\`${shortenAddress(wallet.address)}\`)\n\n` +
                  `💎 *Current Floor Price:* \`${currentFloor} ETH\`\n` +
                  `💰 *Top Instant Bid:* \`${currentBid > 0 ? `${currentBid} ETH` : "None"}\`\n\n` +
                  `_Tap below to liquidate immediately into the active bid:_`;

                // Telegram hard limit: callback_data must be ≤ 64 bytes. Build a
                // short `sell_<tokenId>_<walletId>` callback and verify the whole
                // button set fits; otherwise fall back to a plain OpenSea link.
                const sellCb = `sell_${item.tokenId}_${wallet.id}`;
                const confirmCb = `confirm_sell_${item.tokenId}_${wallet.id}`;
                const cancelCb = `cancel_sell_${item.tokenId}_${wallet.id}`;
                const canUseCallbacks =
                  sellCb.length <= 64 &&
                  confirmCb.length <= 64 &&
                  cancelCb.length <= 64;

                const inlineKeyboard = canUseCallbacks
                  ? [
                      [
                        {
                          text: `💰 Liquidate Now #${item.tokenId} (${currentBid > 0 ? `${currentBid} ETH` : "Dump"})`,
                          callback_data: sellCb,
                        },
                      ],
                      [{ text: "🔗 View on OpenSea", url: item.openseaUrl }],
                    ]
                  : [[{ text: "🔗 View on OpenSea", url: item.openseaUrl }]];

                await bot.api
                  .sendMessage(targetChatId, alertMsg, {
                    parse_mode: "Markdown",
                    reply_markup: { inline_keyboard: inlineKeyboard },
                  })
                  .catch((sendErr) => console.error(`Floor alert send error:`, sendErr));
              } else if (currentFloor > 0) {
                setFloor(tokenKey, currentFloor);
              }
            }
          } catch (err) {
            console.error(`Floor watcher wallet error (${wallet.address}):`, err);
          }
        }
      }
    } catch (err) {
      console.error("Floor watcher cycle error:", err);
    }
  };

  setTimeout(runCheck, 15_000);
  setInterval(runCheck, intervalSeconds * 1000);
}
