import {
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
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
const OPENSEA_ASSET_BASE = "https://opensea.io/assets/base";
const REQUEST_TIMEOUT_MS = 10_000;
const FLOOR_CACHE_TTL_MS = 5 * 60_000;
const FLOOR_ZERO_CACHE_TTL_MS = 60_000;
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
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw >= 0 ? raw : 0;
  }
  if (typeof raw === "string") {
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : 0;
  }
  if (Array.isArray(raw)) {
    let best = 0;
    for (const m of raw) {
      const p = asEth(m);
      if (p > 0 && (best === 0 || p < best)) best = p;
    }
    return best;
  }
  if (raw && typeof raw === "object") {
    let best = 0;
    for (const m of Object.values(raw as Record<string, unknown>)) {
      const p = asEth(m);
      if (p > 0 && (best === 0 || p < best)) best = p;
    }
    return best;
  }
  return 0;
}

function weiToEth(raw: unknown): number {
  try {
    if (typeof raw === "string" && /^\d+$/.test(raw)) {
      return Number(BigInt(raw)) / 1e18;
    }
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return raw / 1e18;
    }
  } catch {
    /* fall through */
  }
  return 0;
}

// Alchemy getFloorPrice returns { [marketplace]: { floorPrice } } or { floorPrice }.
// Be shape-agnostic: scan every nested value for floorPrice/floor_price, keep min positive.
function parseAlchemyFloor(floorJson: any): number {
  if (!floorJson || typeof floorJson !== "object") return 0;
  const markets = Array.isArray(floorJson)
    ? floorJson
    : Object.values(floorJson);
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

// Keyless last-resort: OpenSea asset/collection pages embed JSON with
// "floor_price" in ETH. First positive match wins.
async function fetchOpenSeaHtmlFloor(
  contractAddress: string,
  tokenId?: string
): Promise<number> {
  const url = tokenId
    ? `${OPENSEA_ASSET_BASE}/${contractAddress}/${tokenId}`
    : `${OPENSEA_ASSET_BASE}/${contractAddress}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "text/html",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
      signal: controller.signal,
    });
    if (!res.ok) return 0;
    const html = await res.text();
    const re = /"floor_price"\s*:\s*([0-9]*\.?[0-9]+)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) {
      const v = Number(match[1]);
      if (v > 0) return v;
    }
    return 0;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

// Live floor + top bid + collection name. Ladder: Reservoir -> Alchemy -> OpenSea HTML.
// Diagnostics log per-source values so a failed source is identifiable in Railway logs.
// Zero results are cached only 60s so a transient API failure can't poison the floor.
export async function fetchCollectionFloor(
  contractAddress: string,
  tokenId?: string
): Promise<FloorData> {
  const key = contractAddress.toLowerCase();
  const cached = floorCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const [alchemy, reservoir] = await Promise.all([
    fetchAlchemyFloor(contractAddress),
    fetchReservoirFloor(contractAddress),
  ]);

  let floorPriceEth =
    reservoir.floorPriceEth && reservoir.floorPriceEth > 0
      ? reservoir.floorPriceEth
      : alchemy.floorPriceEth && alchemy.floorPriceEth > 0
        ? alchemy.floorPriceEth
        : 0;

  let openSeaHtmlFloor = 0;
  if (floorPriceEth === 0) {
    openSeaHtmlFloor = await fetchOpenSeaHtmlFloor(contractAddress, tokenId);
    if (openSeaHtmlFloor > 0) {
      floorPriceEth = openSeaHtmlFloor;
      throttledLog(
        `floor-recovered:${key}`,
        `Floor for ${contractAddress} recovered via OpenSea HTML fallback: ${openSeaHtmlFloor} ETH`
      );
    }
  }

  if (floorPriceEth === 0) {
    throttledLog(
      `floor:${key}`,
      `Floor empty for ${contractAddress} — alchemy:${alchemy.floorPriceEth ?? "n/a"} reservoir:${reservoir.floorPriceEth ?? "n/a"} openSeaHtml:${openSeaHtmlFloor} (check ALCHEMY_API_KEY / RESERVOIR_API_KEY on Railway)`
    );
  }

  const topBidEth =
    reservoir.topBidEth && reservoir.topBidEth > 0 ? reservoir.topBidEth : 0;

  const collectionName =
    (reservoir.collectionName && reservoir.collectionName.trim()) ||
    (alchemy.collectionName && alchemy.collectionName.trim()) ||
    "Base NFT";

  const data: FloorData = { floorPriceEth, topBidEth, collectionName };

  floorCache.set(key, {
    data,
    expiresAt:
      Date.now() +
      (floorPriceEth > 0 ? FLOOR_CACHE_TTL_MS : FLOOR_ZERO_CACHE_TTL_MS),
  });
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
