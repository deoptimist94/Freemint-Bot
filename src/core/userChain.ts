import type { ChainId } from "./chains.js";
import { prisma } from "../db/client.js";

export type ChainKey = "base" | "robinhood" | "both";
export type ChainSelection = ChainKey;

const VALID: readonly string[] = ["base", "robinhood", "both"];

export function sanitizeSelection(value: string | undefined | null): ChainSelection {
  if (value && VALID.includes(value)) return value as ChainSelection;
  return "base";
}

export async function getUserChainSelection(userId: bigint): Promise<ChainSelection> {
  try {
    const pref = await prisma.userPreference.findUnique({ where: { userId } });
    return sanitizeSelection(pref?.chain ?? process.env.CHAIN);
  } catch {
    return sanitizeSelection(process.env.CHAIN);
  }
}

export async function setUserChainSelection(
  userId: bigint,
  selection: ChainSelection
): Promise<void> {
  const chain = sanitizeSelection(selection);
  await prisma.userPreference.upsert({
    where: { userId },
    update: { chain },
    create: { userId, chain },
  });
}

export function getChainsForSelection(selection: ChainSelection): ChainId[] {
  return selection === "both" ? ["base", "robinhood"] : [selection];
}

export function getPrimaryChain(selection: ChainSelection): ChainId {
  return selection === "both" ? "base" : selection;
}

export function chainBadge(chain: ChainId): string {
  return chain === "robinhood" ? "🏹" : "⛽";
}

export function chainLabel(chain: ChainId): string {
  return chain === "robinhood" ? "Robinhood Chain" : "Base";
}

export function selectionLabel(selection: ChainSelection): string {
  return selection === "both"
    ? "⛽ Base + 🏹 Robinhood Chain"
    : `${chainBadge(selection)} ${chainLabel(selection)}`;
}
