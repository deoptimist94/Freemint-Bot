import { formatGwei } from "viem";
import { getPublicClient } from "./chain.js";

// Default gas threshold in Gwei (0.1 Gwei is typical baseline for Base)
export const DEFAULT_MAX_GWEI = 0.1;

// In-memory gas ceiling per user (telegramId -> maxGwei)
const userGasCeilings = new Map<bigint, number>();

export function getUserGasCeiling(userId: bigint): number {
  return userGasCeilings.get(userId) ?? DEFAULT_MAX_GWEI;
}

export function setUserGasCeiling(userId: bigint, maxGwei: number): void {
  userGasCeilings.set(userId, maxGwei);
}

export async function checkGasSafety(userId: bigint): Promise<{
  safe: boolean;
  currentGwei: number;
  maxGwei: number;
}> {
  const publicClient = getPublicClient();
  const gasPriceWei = await publicClient.getGasPrice();
  const currentGwei = parseFloat(formatGwei(gasPriceWei));
  const maxGwei = getUserGasCeiling(userId);

  return {
    safe: currentGwei <= maxGwei,
    currentGwei,
    maxGwei,
  };
}

/**
 * Send-time enforcement: throws if gas is above the user's ceiling right now.
 * Call this immediately before `sendTransaction` so a gas spike between the
 * decision and the send cannot slip through.
 */
export async function assertGasSafe(userId: bigint): Promise<void> {
  const { safe, currentGwei, maxGwei } = await checkGasSafety(userId);
  if (!safe) {
    throw new Error(
      `Mint aborted at send time: gas ${currentGwei.toFixed(4)} Gwei exceeds your max of ${maxGwei} Gwei.`
    );
  }
}
