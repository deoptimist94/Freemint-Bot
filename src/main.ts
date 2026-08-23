import "dotenv/config";
import { createBot } from "./bot/index.js";
import { startHealthServer } from "./server/health.js";
import { startAutoMintLoop } from "./core/autoMint.js";
import { prisma } from "./db/client.js";
import { DropListener, type DropEvent } from "./core/listener.js";
import {
  scanContract,
  getBestMintFunction,
  simulateMint,
} from "./core/scanner.js";
import { startFloorWatcher } from "./core/floorWatcher.js";
import { pollTrackedWalletsForUser } from "./core/sniperEngine.js";
import { getWallets } from "./core/wallet.js";
import { getAutoMintStatus } from "./core/watchlist.js";
import { batchMint } from "./core/mint.js";
import { withChainContext } from "./core/chainContext.js";
import { type ChainId, getChainConfig } from "./core/chains.js";
import {
  getChainsForSelection,
  getPrimaryChain,
  getUserChainSelection,
} from "./core/userChain.js";

async function main() {
  console.log("🚀 Starting Auto-Mint Bot (Base + Robinhood)...");

  const required = ["BOT_TOKEN", "ENCRYPTION_KEY"];
  for (const key of required) {
    if (!process.env[key]) {
      console.error(`❌ Missing required environment variable: ${key}`);
      process.exit(1);
    }
  }

  try {
    await prisma.$connect();
    console.log("✅ Database connected");
  } catch (error) {
    console.error("❌ Database connection failed:", error);
    process.exit(1);
  }

  const bot = createBot();
  startHealthServer(bot);
  startAutoMintLoop(bot);
  startFloorWatcher(bot, 300);

  // Copy-trade every ~12s — sniperEngine now polls per-user chain selection internally
  setInterval(async () => {
    try {
      const configs = await prisma.sniperConfig.findMany({
        where: { autoCopy: true },
      });
      for (const cfg of configs) {
        await pollTrackedWalletsForUser(cfg.userId, async (msg) => {
          try {
            const targetChatId =
              typeof cfg.userId === "bigint" ? Number(cfg.userId) : cfg.userId;
            await bot.api.sendMessage(targetChatId, msg, { parse_mode: "Markdown" });
          } catch (e) {
            console.error("Failed to send copy-mint notification:", e);
          }
        });
      }
    } catch (err) {
      console.error("Error in background copy-mint poller:", err);
    }
  }, 12_000);

  // Real-time free-mint sniffer → STRICT filter before alert (one pipeline per chain)
  const handleDrop = (chain: ChainId) => async (drop: DropEvent) => {
    const { badge, name, explorerBaseUrl } = getChainConfig(chain);
    try {
      // scanContract has no chain parameter — run it inside the chain context so
      // its internal getDefaultChainId()/getPublicClient() calls resolve to this chain.
      const scan = await withChainContext(chain, () =>
        scanContract(drop.contractAddress)
      );

      // Hard gates: real NFT + free mint + safe
      if (!scan.isContract || !scan.isNft) {
        console.log(`⏭ Drop ignored (not NFT) [${chain}]: ${drop.contractAddress}`);
        return;
      }
      if (!scan.security?.isSafe) {
        console.log(`⏭ Drop ignored (unsafe) [${chain}]: ${drop.contractAddress}`);
        return;
      }
      if (!scan.mintFunctions.length) {
        console.log(`⏭ Drop ignored (no free mint) [${chain}]: ${drop.contractAddress}`);
        return;
      }

      const fn = getBestMintFunction(scan.mintFunctions) || scan.mintFunctions[0];

      // Prove mint is LIVE right now (filters closed / sold-out / non-NFT mints)
      const probeWallets = await getWallets(
        (
          await (prisma as any).user.findFirst({
            where: { wallets: { some: {} } },
            include: { wallets: true },
          })
        )?.telegramId ?? 0n
      ).catch(() => [] as Awaited<ReturnType<typeof getWallets>>);

      const probeFrom =
        probeWallets[0]?.address ||
        "0x0000000000000000000000000000000000000001";

      const sim = await withChainContext(chain, () =>
        simulateMint(scan.contractAddress, probeFrom, fn)
      );
      if (!sim.success) {
        console.log(
          `⏭ Drop ignored (simulation revert — mint closed or gated) [${chain}]: ${drop.contractAddress} — ${sim.error?.slice(0, 120)}`
        );
        return;
      }

      const activeUsers = (await (prisma as any).user.findMany({
        include: { wallets: true },
      })) as Array<any>;

      for (const user of activeUsers) {
        if (!user.wallets?.length) continue;

        // Only alert users whose chain selection covers this chain.
        const selection = await getUserChainSelection(BigInt(user.telegramId));
        if (!getChainsForSelection(selection).includes(chain)) continue;

        const targetChatId =
          typeof user.telegramId === "bigint"
            ? Number(user.telegramId)
            : user.telegramId;

        // Mint button only when the drop chain is the user's primary chain
        // (for "both" users a Robinhood drop must not mint on Base).
        const canMintNow = getPrimaryChain(selection) === chain;
        const alertMessage =
          `🚨 *NEW FREE MINT DETECTED!* — ${badge} ${name}\n\n` +
          `📦 *Contract:* \`${scan.contractAddress}\`\n` +
          `⚙️ *Function:* \`${fn.name}(${fn.args.join(",")})\`\n` +
          `🔍 *Verified:* ${scan.isVerified ? "✅ Yes" : "⚠️ Bytecode"}\n` +
          `🧪 *Live sim:* ✅ passes\n\n` +
          (canMintNow
            ? `_Tap below to mint with your active wallets:_`
            : `_Set your chain to ${name} (${badge}) with /chain, then use /mint ${scan.contractAddress}._`);

        await bot.api
          .sendMessage(targetChatId, alertMessage, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                ...(canMintNow
                  ? [
                      [
                        {
                          text: "🚀 Batch Mint Now",
                          callback_data: `mint_${scan.contractAddress}`,
                        },
                      ],
                    ]
                  : []),
                [
                  {
                    text: chain === "base" ? "🔗 View on BaseScan" : "🔗 View on Blockscout",
                    url: `${explorerBaseUrl}/address/${scan.contractAddress}`,
                  },
                ],
              ],
            },
          })
          .catch((sendErr) =>
            console.error(`Alert error for user ${user.telegramId}:`, sendErr)
          );

        // Optional: auto-fire when user has Auto-Mint ON
        try {
          const autoOn = await getAutoMintStatus(BigInt(user.telegramId));
          if (autoOn) {
            console.log(`⚡ Auto-minting discovery for ${user.telegramId} on ${chain} ${scan.contractAddress}`);
            const result = await withChainContext(chain, () =>
              batchMint(BigInt(user.telegramId), scan.contractAddress)
            );
            let msg =
              `⚡ *Auto-Mint (discovery)* — ${badge} ${name}\n\nContract: \`${scan.contractAddress}\`\n` +
              `✅ ${result.totalSuccess} · ❌ ${result.totalFailed}`;
            await bot.api
              .sendMessage(targetChatId, msg, { parse_mode: "Markdown" })
              .catch(() => undefined);
          }
        } catch (autoErr) {
          console.error("Discovery auto-mint error:", autoErr);
        }
      }
    } catch (err) {
      console.error(`Auto-discovery pipeline error (${chain}):`, err);
    }
  };

  const dropListener = new DropListener("base", handleDrop("base"));
  dropListener.start();

  // Robinhood discovery is opt-in via env: the watchBlocks subscription needs an RPC.
  const robinhoodEnabled = !!(
    process.env.ROBINHOOD_RPC_URL || process.env.ROBINHOOD_ALCHEMY_API_KEY
  );
  const robinhoodListener = robinhoodEnabled
    ? new DropListener("robinhood", handleDrop("robinhood"))
    : null;
  if (robinhoodListener) {
    robinhoodListener.start();
  } else {
    console.log(
      "⏭ Robinhood discovery disabled (set ROBINHOOD_RPC_URL or ROBINHOOD_ALCHEMY_API_KEY to enable)."
    );
  }

  const handleShutdown = async (signal: string) => {
    console.log(`🛑 Shutting down (${signal})...`);
    dropListener.stop();
    robinhoodListener?.stop();
    await bot.stop();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => handleShutdown("SIGINT"));
  process.on("SIGTERM", () => handleShutdown("SIGTERM"));

  try {
    await bot.start({
      onStart: (botInfo) => {
        console.log(`✅ Bot started: @${botInfo.username}`);
      },
    });
  } catch (error) {
    console.error("❌ Failed to start bot:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
