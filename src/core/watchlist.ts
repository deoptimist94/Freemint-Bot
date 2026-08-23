import { prisma } from "../db/client.js";
import { getDefaultChainId, type ChainId } from "./chains.js";
import { getContextChain } from "./chainContext.js";

function resolveChain(chain?: ChainId): ChainId {
  return chain ?? getContextChain() ?? getDefaultChainId();
}

export async function addToWatchlist(
  userId: bigint,
  contractAddress: string,
  chain?: ChainId
) {
  const normalized = contractAddress.toLowerCase();
  const c = resolveChain(chain);
  return prisma.watchlist.upsert({
    where: {
      userId_contractAddress_chain: {
        userId,
        contractAddress: normalized,
        chain: c,
      },
    },
    update: {},
    create: { userId, contractAddress: normalized, chain: c },
  });
}

export async function removeFromWatchlist(
  userId: bigint,
  contractAddress: string,
  chain?: ChainId
) {
  const normalized = contractAddress.toLowerCase();
  if (chain) {
    return prisma.watchlist.deleteMany({
      where: { userId, contractAddress: normalized, chain },
    });
  }
  return prisma.watchlist.deleteMany({
    where: { userId, contractAddress: normalized },
  });
}

export async function getWatchlist(userId: bigint, chain?: ChainId) {
  return prisma.watchlist.findMany({
    where: chain ? { userId, chain } : { userId },
    orderBy: { addedAt: "desc" },
  });
}

export async function isInWatchlist(
  userId: bigint,
  contractAddress: string,
  chain?: ChainId
): Promise<boolean> {
  const normalized = contractAddress.toLowerCase();
  const c = resolveChain(chain);
  const item = await prisma.watchlist.findUnique({
    where: {
      userId_contractAddress_chain: {
        userId,
        contractAddress: normalized,
        chain: c,
      },
    },
  });
  return item !== null;
}

export async function getAutoMintUsers() {
  return prisma.user.findMany({
    where: { autoMintEnabled: true },
  });
}

export async function setAutoMintEnabled(telegramId: bigint, enabled: boolean) {
  await prisma.user.upsert({
    where: { telegramId },
    update: { autoMintEnabled: enabled },
    create: { telegramId, autoMintEnabled: enabled },
  });
}

export async function getAutoMintStatus(telegramId: bigint): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { telegramId } });
  return user?.autoMintEnabled ?? false;
}

export async function getWatchlistWithContracts(
  userId: bigint,
  chain?: ChainId
) {
  const items = await getWatchlist(userId, chain);
  return items.map((w) => w.contractAddress);
}
