import { createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { getPublicClient } from "./chain.js";

export interface FloorData {
  floorPriceEth: number;
  topBidEth: number;
  collectionName: string;
}

const ALCHEMY_NFT_V3 = "https://base-mainnet.g.alchemy.com/nft/v3";
const REQUEST_TIMEOUT_MS = 10_000;
const FLOOR_CACHE_TTL_MS = 5 * 60_000;
const LOG_THROTTLE_MS = 15 * 60_000;

const floorCache = new Map<string, { data: FloorData; expiresAt: number }>();
const logThrottle = new Map<string, number>();

function alchemyKey(): string {
  return (process.env.ALCHEMY_API_KEY || "").trim();
}

function throttledLog(key: string, message: string) {
  const now = Date.now();
  if ((logThrottle.get(key) ?? 0) <= now - LOG_THROTTLE_MS) {
    logThrottle.set(key, now);
    console.warn(message);
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) return null;
    const text = await res.text();
    try {
      return JSON.parse(text) as any;
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Live floor + collection name from Alchemy NFT API v3 (Base, free tier).
// Floors are returned in ETH (OpenSea aggregation, cached ~5-15 min by Alchemy).
export async function fetchCollectionFloor(contractAddress: string): Promise<FloorData> {
  const cached = floorCache.get(contractAddress);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const key = alchemyKey();
  if (!key) {
    return { floorPriceEth: 0, topBidEth: 0, collectionName: "Base NFT" };
  }

  const [floorJson, metaJson] = await Promise.all([
    fetchJson(`${ALCHEMY_NFT_V3}/${key}/getFloorPrice?contractAddress=${contractAddress}`),
    fetchJson(`${ALCHEMY_NFT_V3}/${key}/getContractMetadata?contractAddress=${contractAddress}`),
  ]);

  const data: FloorData = {
    floorPriceEth: Number(floorJson?.openSea?.floorPrice ?? 0),
    topBidEth: 0,
    collectionName:
      metaJson?.openSeaMetadata?.collectionName ||
      metaJson?.name ||
      "Base NFT",
  };

  if (!floorJson && !metaJson) {
    throttledLog(
      `floor:${contractAddress.toLowerCase()}`,
      `Alchemy floor fetch failed for ${contractAddress} (check ALCHEMY_API_KEY / rate limit)`
    );
  }

  floorCache.set(contractAddress, { data, expiresAt: Date.now() + FLOOR_CACHE_TTL_MS });
  return data;
}

// Never trust a raw API string blindly — only accept plain integers.
function safeTxValue(raw: unknown): bigint {
  try {
    if (typeof raw === "string" && /^\d+$/.test(raw)) return BigInt(raw);
    if (typeof raw === "number" && Number.isFinite(raw)) return BigInt(Math.floor(raw));
  } catch {
    /* fall through */
  }
  return 0n;
}

// Reservoir chain subdomains (api-base.reservoir.tools) are currently NXDOMAIN,
// so listing is routed via the unified host as best-effort. On failure it returns
// a clean error instead of spamming logs.
export async function executeAutoListing(
  privateKey: Hex,
  contractAddress: string,
  tokenId: string,
  listPriceEth: number
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  try {
    const account = privateKeyToAccount(privateKey);
    const client = createWalletClient({
      account,
      chain: base,
      transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org"),
    });

    const weiPrice = BigInt(Math.floor(listPriceEth * 1e18)).toString();

    const data = await fetchJson("https://api.reservoir.tools/execute/list/v5?chainId=8453", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.RESERVOIR_API_KEY || "demo-api-key",
      },
      body: JSON.stringify({
        items: [{ token: `${contractAddress}:${tokenId}`, weiPrice }],
        taker: account.address,
      }),
    });

    if (!data) {
      return {
        success: false,
        error: "Marketplace API unreachable (Reservoir outage). Try again later.",
      };
    }

    const steps: any[] = data.steps ?? [];
    if (steps.length === 0) {
      return { success: false, error: "No listing steps returned by marketplace" };
    }

    const publicClient = getPublicClient();
    let signedOffchain = false;

    // Walk Reservoir's step list in order. Approvals and listing txs are
    // separate steps; EIP-712 signature steps must be signed, not sent.
    for (const step of steps) {
      if (step.kind === "signature") {
        const item = step.items?.[0]?.data;
        if (item?.types && item?.domain && item?.value) {
          await (client as any).signTypedData({
            domain: item.domain,
            types: item.types,
            primaryType: item.primaryType || "OrderComponents",
            message: item.value,
          });
          signedOffchain = true;
        }
        continue;
      }

      for (const it of step.items ?? []) {
        const txData = it?.data;
        if (!txData?.to || !txData?.data) continue;

        const txHash = await client.sendTransaction({
          to: txData.to as Address,
          data: txData.data as Hex,
          value: safeTxValue(txData.value),
        });

        await publicClient.waitForTransactionReceipt({ hash: txHash });
        return { success: true, txHash };
      }
    }

    return {
      success: signedOffchain,
      error: signedOffchain
        ? undefined
        : "Listing prepared but no on-chain transaction was emitted",
      txHash: undefined,
    };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}
