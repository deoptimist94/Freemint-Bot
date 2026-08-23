// In-memory sell-target cache.
//
// The sell flow resolves a `sell_<tokenId>_<walletId>` callback by re-fetching
// every wallet's portfolio live. Any transient Alchemy failure then produces
// the confusing "Token not found in your wallets" toast. This cache is
// registered by the floor watcher and the portfolio view (which already hold
// the exact item), so the dump/confirm path resolves instantly and only falls
// back to a live lookup when the entry is missing or stale.

export interface CachedSellTarget {
  walletId: string;
  contractAddress: string;
  tokenId: string;
  collectionName: string;
  openseaUrl: string;
  floorPriceEth: number;
  topBidEth: number;
  cachedAt: number;
}

const TTL_MS = 30 * 60_000;
const MAX_PER_USER = 500;
const MAX_USERS = 200;

const cache = new Map<string, Map<string, CachedSellTarget>>();
const userOrder: string[] = [];

export function setSellTarget(
  userId: bigint,
  tokenId: string,
  target: Omit<CachedSellTarget, "cachedAt">
): void {
  const key = userId.toString();
  let userMap = cache.get(key);
  if (!userMap) {
    userMap = new Map();
    cache.set(key, userMap);
    userOrder.push(key);
    while (userOrder.length > MAX_USERS) {
      const oldest = userOrder.shift();
      if (oldest) cache.delete(oldest);
    }
  }
  userMap.set(tokenId, { ...target, cachedAt: Date.now() });
  if (userMap.size > MAX_PER_USER) {
    let oldestToken: string | undefined;
    let oldestAt = Infinity;
    for (const [tid, t] of userMap) {
      if (t.cachedAt < oldestAt) {
        oldestAt = t.cachedAt;
        oldestToken = tid;
      }
    }
    if (oldestToken !== undefined) userMap.delete(oldestToken);
  }
}

export function getSellTarget(userId: bigint, tokenId: string): CachedSellTarget | undefined {
  const userMap = cache.get(userId.toString());
  if (!userMap) return undefined;
  const target = userMap.get(tokenId);
  if (!target) return undefined;
  if (Date.now() - target.cachedAt > TTL_MS) {
    userMap.delete(tokenId);
    return undefined;
  }
  return target;
}
