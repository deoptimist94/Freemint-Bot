import { type Hex } from "viem";
import { executeSell } from "./portfolio.js";
import { getWalletPrivateKey, getWallets } from "./wallet.js";

export interface AutoSellConfig {
  enabled: boolean;
  minPayoutEth: number; // Minimum bid payout to trigger auto-sell
}

// In-memory auto-sell configuration per user (telegramId -> config)
const userAutoSellConfigs = new Map<bigint, AutoSellConfig>();

// Per-token failure cooldown so transient errors don't hammer the marketplace API.
const FAILURE_COOLDOWN_MS = 10 * 60_000;
const failureCooldowns = new Map<string, number>(); // `${walletId}:${contract}:${tokenId}` -> timestamp

export function getAutoSellConfig(userId: bigint): AutoSellConfig {
  return (
    userAutoSellConfigs.get(userId) ?? {
      enabled: false,
      minPayoutEth: 0.001,
    }
  );
}

export function setAutoSellConfig(
  userId: bigint,
  enabled: boolean,
  minPayoutEth?: number
): void {
  const current = getAutoSellConfig(userId);
  userAutoSellConfigs.set(userId, {
    enabled,
    minPayoutEth: minPayoutEth !== undefined ? minPayoutEth : current.minPayoutEth,
  });
}

export async function processAutoSellForToken(
  userId: bigint,
  contractAddress: string,
  tokenId: string,
  topBidEth: number,
  walletId: string
): Promise<{ success: boolean; payoutEth?: number; txHash?: string; error?: string }> {
  const config = getAutoSellConfig(userId);

  if (!config.enabled) {
    return { success: false, error: "Auto-sell is disabled" };
  }

  if (topBidEth <= 0 || topBidEth < config.minPayoutEth) {
    return {
      success: false,
      error: `Top bid (${topBidEth} ETH) is below your minimum threshold (${config.minPayoutEth} ETH)`,
    };
  }

  const cooldownKey = `${walletId}:${contractAddress.toLowerCase()}:${tokenId}`;
  const lastFailure = failureCooldowns.get(cooldownKey) ?? 0;
  if (Date.now() - lastFailure < FAILURE_COOLDOWN_MS) {
    return { success: false, error: "Sell attempt cooling down after a previous failure" };
  }

  try {
    const privateKey = await getWalletPrivateKey(walletId);
    const hexKey = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;

    const result = await executeSell(hexKey, contractAddress, tokenId);

    if (!result.success) {
      failureCooldowns.set(cooldownKey, Date.now());
    }

    return result;
  } catch (err) {
    failureCooldowns.set(cooldownKey, Date.now());
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
