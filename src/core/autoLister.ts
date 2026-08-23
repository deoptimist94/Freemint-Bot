import {
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { getPublicClient, getBaseRpcUrl } from "./chain.js";
import { getChainConfig, getDefaultChainId, type ChainId } from "./chains.js";

export interface FloorData {
  floorPriceEth: number;
  topBidEth: number;
  collectionName: string;
}

const RESERVOIR_BASE = "https://api-base.reservoir.tools";
const REQUEST_TIMEOUT_MS = 10_000;
const FLOOR_CACHE_TTL_MS = 5 * 60_000;
const FLOOR_ZERO_CACHE_TTL_MS = 60_000;
const LOG_THROTTLE_MS = 15 * 60_000;

const floorCache = new Map<string, { data: FloorData; expiresAt: number }>();
const logThrottle = new Map<string, number>();

function alchemyKey(chain: ChainId): string {
  if (chain === "robinhood") {
    return (
      process.env.ROBINHOOD_ALCHEMY_API_KEY ||
      process.env.ALCHEMY_API_KEY ||
      ""
    ).trim();
  }
  return (process.env.ALCHEMY_API_KEY || "").trim();
}

function reservoirKey(): string {
  return (process.env.RESERVOIR_API_KEY || "demo-api-key").trim();
}

function alchemyNftBase(chain: ChainId): string {
  return getChainConfig(chain).alchemyNftBase;
}

function openseaAssetBase(chain: ChainId): string {
  return `https://opensea.io/assets/${getChainConfig(chain).openseaChain}`;
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

// Normalizes wei (1e18-scale) to ETH; native (already-ETH) values pass through.
function asEth(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1e12 ? n / 1e18 : n;
}

// Alchemy getFloorPrice returns marketplace-keyed data
// ({openSea:{floorPrice,...}, looksRare:{...}}) — parse whichever exists.
async function fetchAlchemyFloor(
  contractAddress: string,
  chain: ChainId
): Promise<FloorData> {
  const key = alchemyKey(chain);
  if (!key) return { floorPriceEth: 0, topBidEth: 0, collectionName: "" };
  const url = `${alchemyNftBase(chain)}/${key}/getFloorPrice?contractAddress=${contractAddress}`;
  const json = await fetchJson(url);
  if (!json) return { floorPriceEth: 0, topBidEth: 0, collectionName: "" };
  const raw =
    json.floorPrice ??
    json.openSea?.floorPrice ??
    json.looksRare?.floorPrice;
  const collectionName =
    typeof json.collectionName === "string"
      ? json.collectionName
      : typeof json.collection?.name === "string"
        ? json.collection.name
        : "";
  return { floorPriceEth: asEth(raw), topBidEth: 0, collectionName };
}

async function fetchReservoirFloor(
  contractAddress: string
): Promise<FloorData> {
  const url = `${RESERVOIR_BASE}/collections/v7?id=${contractAddress}&includeTopBid=true`;
  const json = await fetchJson(url, {
    headers: { "x-api-key": reservoirKey() },
  });
  const col = json?.collections?.[0];
  if (!col) return { floorPriceEth: 0, topBidEth: 0, collectionName: "" };
  const floorRaw = col?.floorAsk?.price?.amount?.raw;
  const floorNative = col?.floorAsk?.price?.amount?.native;
  const topBidRaw = col?.topBid?.price?.amount?.raw;
  const topBidNative = col?.topBid?.price?.amount?.native;
  const topBidWei = asEth(topBidRaw);
  return {
    floorPriceEth: asEth(floorRaw) || asEth(floorNative),
    topBidEth: topBidNative > 0 ? topBidNative : topBidWei,
    collectionName: typeof col.name === "string" ? col.name : "",
  };
}

// Keyless last-resort: OpenSea asset/collection pages embed JSON with
// "floor_price" in ETH. First positive match wins.
async function fetchOpenSeaHtmlFloor(
  contractAddress: string,
  tokenId?: string,
  chain: ChainId = getDefaultChainId()
): Promise<number> {
  const base = openseaAssetBase(chain);
  const url = tokenId
    ? `${base}/${contractAddress}/${tokenId}`
    : `${base}/${contractAddress}`;
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
// Robinhood: Reservoir is skipped (no RH support yet) — Alchemy -> OpenSea HTML.
// Diagnostics log per-source values so a failed source is identifiable in Railway logs.
// Zero results are cached only 60s so a transient API failure can't poison the floor.
export async function fetchCollectionFloor(
  contractAddress: string,
  tokenId?: string,
  chain: ChainId = getDefaultChainId()
): Promise<FloorData> {
  const config = getChainConfig(chain);
  const key = `${chain}::${contractAddress.toLowerCase()}`;
  const cached = floorCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const useReservoir = Boolean(config.reservoirBase);
  const [alchemy, reservoir] = await Promise.all([
    fetchAlchemyFloor(contractAddress, chain),
    useReservoir
      ? fetchReservoirFloor(contractAddress)
      : Promise.resolve({ floorPriceEth: 0, topBidEth: 0, collectionName: "" }),
  ]);

  let floorPriceEth =
    reservoir.floorPriceEth && reservoir.floorPriceEth > 0
      ? reservoir.floorPriceEth
      : alchemy.floorPriceEth && alchemy.floorPriceEth > 0
        ? alchemy.floorPriceEth
        : 0;

  let openSeaHtmlFloor = 0;
  if (floorPriceEth === 0) {
    openSeaHtmlFloor = await fetchOpenSeaHtmlFloor(
      contractAddress,
      tokenId,
      chain
    );
    if (openSeaHtmlFloor > 0) {
      floorPriceEth = openSeaHtmlFloor;
      throttledLog(
        `floor-recovered:${key}`,
        `Floor for ${contractAddress} (${config.name}) recovered via OpenSea HTML fallback: ${openSeaHtmlFloor} ETH`
      );
    }
  }

  if (floorPriceEth === 0) {
    throttledLog(
      `floor:${key}`,
      `Floor empty for ${contractAddress} (${config.name}) — alchemy:${alchemy.floorPriceEth ?? "n/a"} reservoir:${reservoir.floorPriceEth ?? "n/a"} openSeaHtml:${openSeaHtmlFloor} (check ALCHEMY_API_KEY / RESERVOIR_API_KEY on Railway)`
    );
  }

  const topBidEth =
    reservoir.topBidEth && reservoir.topBidEth > 0 ? reservoir.topBidEth : 0;

  const collectionName =
    (reservoir.collectionName && reservoir.collectionName.trim()) ||
    (alchemy.collectionName && alchemy.collectionName.trim()) ||
    `${config.name} NFT`;

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

// Listings stay Base-only for now: Reservoir does not support Robinhood Chain
// (checked 2026-08-14 chain list). When they add RH, this just needs the
// chainId swap.
export async function executeAutoListing(
  privateKey: Hex,
  contractAddress: string,
  tokenId: string,
  listPriceEth: number,
  chain: ChainId = getDefaultChainId()
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  if (chain !== "base") {
    return {
      success: false,
      error: "🔜 Robinhood Chain listings coming soon — marketplace support is not live yet.",
    };
  }
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
      return {
        success: false,
        error: "No listing steps returned by marketplace",
      };
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
