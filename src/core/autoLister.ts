import { createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { getPublicClient, getBaseRpcUrl } from "./chain.js";

export interface FloorData {
  floorPriceEth: number;
  topBidEth: number;
  collectionName: string;
}

const ALCHEMY_NFT_V3 = "https://base-mainnet.g.alchemy.com/nft/v3";
const RESERVOIR_BASE = "https://api-base.reservoir.tools";
const REQUEST_TIMEOUT_MS = 10_000;
const FLOOR_CACHE_TTL_MS = 5 * 60_000;
const LOG_THROTTLE_MS = 15 * 60_000;

const floorCache = new Map<string, { data: FloorData; expiresAt: number }>();
const logThrottle = new Map<string, number>();

function alchemyKey(): string {
  return (process.env.ALCHEMY_API_KEY || "").trim();
}

function reservoirKey(): string {
  return (process.env.RESERVOIR_API_KEY || "demo-api-key").trim();
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

function asEth(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

function weiToEth(raw: unknown): number {
  try {
    if (typeof raw === "string" && /^\d+$/.test(raw)) {
      return Number(BigInt(raw)) / 1e18;
    }
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return raw > 1e9 ? raw / 1e18 : raw;
    }
  } catch {
    /* fall through */
  }
  return 0;
}

// Alchemy getFloorPrice — try every marketplace object it returns.
function parseAlchemyFloor(floorJson: any): number {
  if (!floorJson || typeof floorJson !== "object") return 0;
  const markets = [
    floorJson.openSea,
    floorJson.opensea,
    floorJson.looksRare,
    floorJson.looksrare,
    floorJson.x2y2,
    floorJson.blur,
  ];
  let best = 0;
  for (const m of markets) {
    if (!m || typeof m !== "object") continue;
    if (m.error) continue;
    const p = asEth(m.floorPrice ?? m.floor_price);
    if (p > 0 && (best === 0 || p < best)) best = p;
  }
  // Some responses put floorPrice at the top level
  if (best === 0) best = asEth(floorJson.floorPrice ?? floorJson.floor_price);
  return best;
}

async function fetchAlchemyFloor(
  contractAddress: string
): Promise<Partial<FloorData>> {
  const key = alchemyKey();
  if (!key) return {};

  const [floorJson, metaJson] = await Promise.all([
    fetchJson(
      `${ALCHEMY_NFT_V3}/${key}/getFloorPrice?contractAddress=${contractAddress}`
    ),
    fetchJson(
      `${ALCHEMY_NFT_V3}/${key}/getContractMetadata?contractAddress=${contractAddress}`
    ),
  ]);

  return {
    floorPriceEth: parseAlchemyFloor(floorJson),
    collectionName:
      metaJson?.openSeaMetadata?.collectionName ||
      metaJson?.contractMetadata?.name ||
      metaJson?.name ||
      "",
  };
}

// Reservoir is the strongest Base floor source (OpenSea + Blur + etc.).
async function fetchReservoirFloor(
  contractAddress: string
): Promise<Partial<FloorData>> {
  const id = contractAddress.toLowerCase();
  const json = await fetchJson(
    `${RESERVOIR_BASE}/collections/v7?id=${encodeURIComponent(id)}`,
    {
      headers: {
        Accept: "application/json",
        "x-api-key": reservoirKey(),
      },
    }
  );
  const col = Array.isArray(json?.collections) ? json.collections[0] : null;
  if (!col) return {};

  const floorNative = asEth(col.floorAsk?.price?.amount?.native);
  const floorWei = weiToEth(col.floorAsk?.price?.amount?.raw);
  const topBidNative = asEth(col.topBid?.price?.amount?.native);
  const topBidWei = weiToEth(col.topBid?.price?.amount?.raw);

  return {
    floorPriceEth: floorNative > 0 ? floorNative : floorWei,
    topBidEth: topBidNative > 0 ? topBidNative : topBidWei,
    collectionName: typeof col.name === "string" ? col.name : "",
  };
}

// Live floor + top bid + collection name.
// Sources (in parallel): Alchemy NFT API + Reservoir Base. Best non-zero wins.
export async function fetchCollectionFloor(
  contractAddress: string
): Promise<FloorData> {
  const key = contractAddress.toLowerCase();
  const cached = floorCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const [alchemy, reservoir] = await Promise.all([
    fetchAlchemyFloor(contractAddress),
    fetchReservoirFloor(contractAddress),
  ]);

  const floorPriceEth =
    reservoir.floorPriceEth && reservoir.floorPriceEth > 0
      ? reservoir.floorPriceEth
      : alchemy.floorPriceEth && alchemy.floorPriceEth > 0
        ? alchemy.floorPriceEth
        : 0;

  const topBidEth =
    reservoir.topBidEth && reservoir.topBidEth > 0 ? reservoir.topBidEth : 0;

  const collectionName =
    (reservoir.collectionName && reservoir.collectionName.trim()) ||
    (alchemy.collectionName && alchemy.collectionName.trim()) ||
    "Base NFT";

  const data: FloorData = { floorPriceEth, topBidEth, collectionName };

  if (floorPriceEth === 0 && topBidEth === 0) {
    throttledLog(
      `floor:${key}`,
      `Floor fetch empty for ${contractAddress} (Alchemy + Reservoir both returned 0 — collection may have no live listings)`
    );
  }

  floorCache.set(key, { data, expiresAt: Date.now() + FLOOR_CACHE_TTL_MS });
  return data;
}

function safeTxValue(raw: unknown): bigint {
  try {
    if (typeof raw === "string" && /^\d+$/.test(raw)) return BigInt(raw);
    if (typeof raw === "number" && Number.isFinite(raw))
      return BigInt(Math.floor(raw));
  } catch {
    /* fall through */
  }
  return 0n;
}

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
      transport: http(getBaseRpcUrl()),
    });

    const weiPrice = BigInt(Math.floor(listPriceEth * 1e18)).toString();

    const data = await fetchJson(
      "https://api.reservoir.tools/execute/list/v5?chainId=8453",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": reservoirKey(),
        },
        body: JSON.stringify({
          items: [{ token: `${contractAddress}:${tokenId}`, weiPrice }],
          taker: account.address,
        }),
      }
    );

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
