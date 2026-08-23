import { type Address, type Hex } from "viem";
import { getPublicClient, getWalletClient } from "./chain.js";
import { fetchCollectionFloor } from "./autoLister.js";

export interface PortfolioItem {
  contractAddress: string;
  tokenId: string;
  name: string;
  collectionName: string;
  floorPriceEth: number;
  topBidEth: number;
  openseaUrl: string;
}

export interface WalletPortfolio {
  items: PortfolioItem[];
  totalFloorValueEth: number;
  error?: string;
}

export interface SellResult {
  success: boolean;
  txHash?: string;
  payoutEth?: number;
  error?: string;
}

interface OwnedNft {
  contractAddress: string;
  tokenId: string;
  name: string;
  collectionName: string;
}

const ALCHEMY_NFT_V3 = "https://base-mainnet.g.alchemy.com/nft/v3";
const REQUEST_TIMEOUT_MS = 12_000;
// One Alchemy page (pageSize 100) is plenty for a bot portfolio view.
const MAX_NFTS_PER_WALLET = 100;
// Floor lookups run concurrently with a hard time budget so a slow/rate-limited
// Alchemy response can never stall the whole portfolio for minutes.
const FLOOR_CONCURRENCY = 5;
const FLOOR_TIME_BUDGET_MS = 20_000;

function normalizeTokenId(raw: unknown): string {
  const s = String(raw ?? "0");
  if (/^0x[0-9a-f]+$/i.test(s)) {
    try {
      return BigInt(s).toString();
    } catch {
      return s;
    }
  }
  return s;
}

async function fetchJson(url: string): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
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

async function fetchNftsAlchemy(walletAddress: string): Promise<{ nfts: OwnedNft[]; error?: string }> {
  const key = (process.env.ALCHEMY_API_KEY || "").trim();
  if (!key) return { nfts: [], error: "missing_key" };

  const nfts: OwnedNft[] = [];
  let pageKey: string | undefined;
  let error: string | undefined;

  try {
    for (let page = 0; page < Math.ceil(MAX_NFTS_PER_WALLET / 100); page++) {
      const params = new URLSearchParams({
        owner: walletAddress,
        withMetadata: "true",
        pageSize: "100",
      });
      if (pageKey) params.set("pageKey", pageKey);

      const data = await fetchJson(
        `${ALCHEMY_NFT_V3}/${key}/getNFTsForOwner?${params.toString()}`
      );
      if (!data) {
        error = error || "Alchemy request failed (check ALCHEMY_API_KEY / rate limit)";
        break;
      }

      const owned = Array.isArray(data.ownedNfts) ? data.ownedNfts : [];
      for (const n of owned) {
        const contract = String(n.contract?.address || "").toLowerCase();
        if (!contract) continue;
        const tid = normalizeTokenId(n.tokenId);
        nfts.push({
          contractAddress: contract,
          tokenId: tid,
          name: n.name || n.metadata?.name || n.contractMetadata?.name || `Token #${tid}`,
          collectionName: n.contractMetadata?.name || n.collection?.name || "",
        });
      }

      pageKey = data.pageKey;
      if (!pageKey || nfts.length >= MAX_NFTS_PER_WALLET) break;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return { nfts, error };
}

export async function fetchWalletPortfolio(walletAddress: string): Promise<WalletPortfolio> {
  const { nfts, error } = await fetchNftsAlchemy(walletAddress);

  if (nfts.length === 0) {
    if (error) {
      return {
        items: [],
        totalFloorValueEth: 0,
        error:
          error === "missing_key"
            ? "Set ALCHEMY_API_KEY (free at dashboard.alchemy.com) — Etherscan/Reservoir free tiers cannot list Base NFTs."
            : error,
      };
    }
    return { items: [], totalFloorValueEth: 0 };
  }

  // Pre-seed every item so even if floor lookups time out, each token still
  // appears in the portfolio (floor 0 = no market data yet).
  const items: PortfolioItem[] = nfts.map((n) => ({
    contractAddress: n.contractAddress,
    tokenId: n.tokenId,
    name: n.name,
    collectionName: n.collectionName || "",
    floorPriceEth: 0,
    topBidEth: 0,
    openseaUrl: `https://opensea.io/assets/base/${n.contractAddress}/${n.tokenId}`,
  }));

  // Worker pool: at most FLOOR_CONCURRENCY parallel floor requests, and the
  // whole wallet gives up after FLOOR_TIME_BUDGET_MS so a stuck API can never
  // hang the portfolio view for minutes.
  const deadline = Date.now() + FLOOR_TIME_BUDGET_MS;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < nfts.length) {
      if (Date.now() > deadline) return;
      const idx = next++;
      try {
        const floor = await fetchCollectionFloor(nfts[idx].contractAddress);
        items[idx].name = floor.collectionName || items[idx].name;
        items[idx].collectionName = floor.collectionName || items[idx].collectionName;
        items[idx].floorPriceEth = floor.floorPriceEth;
        items[idx].topBidEth = floor.topBidEth;
      } catch {
        // keep the zeroed seed item
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(FLOOR_CONCURRENCY, nfts.length) }, () => worker())
  );

  const totalFloorValueEth = items.reduce((sum, i) => sum + i.floorPriceEth, 0);
  return { items, totalFloorValueEth };
}

export async function executeSell(
  privateKey: string,
  contractAddress: string,
  tokenId: string
): Promise<SellResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch("https://api.reservoir.tools/execute/sell/v6?chainId=8453", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.RESERVOIR_API_KEY || "demo-api-key",
      },
      body: JSON.stringify({
        orders: [{ token: `${contractAddress}:${tokenId}`, weiPrice: "0" }],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    return {
      success: false,
      error: `Sell unavailable: marketplace API unreachable (Reservoir outage). ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    return {
      success: false,
      error: `Sell unavailable: marketplace API error ${res.status}${bodyText ? ` — ${bodyText.slice(0, 160)}` : ""}`,
    };
  }

  const json = (await res.json().catch(() => ({}))) as any;
  const step = (json.steps ?? []).find(
    (s: any) => Array.isArray(s.items) && s.items.length > 0
  );
  const txData = step?.items?.[0]?.data;

  if (!txData || !txData.to) {
    return { success: false, error: "No active bids found on secondary markets" };
  }

  try {
    const hexKey = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;
    const walletClient = getWalletClient(hexKey);
    const txHash = await walletClient.sendTransaction({
      to: txData.to as Address,
      data: (txData.data ?? "0x") as Hex,
      value: BigInt(txData.value ?? "0"),
    });
    await getPublicClient().waitForTransactionReceipt({ hash: txHash });
    const payoutEth = Number(BigInt(txData.value ?? "0")) / 1e18;
    return { success: true, txHash, payoutEth };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
