import { Hex, Address } from "viem";
import { getPublicClient, getWalletClient } from "./chain.js";
import { fetchCollectionFloor, FloorData } from "./autoLister.js";

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

async function fetchNftsAlchemy(walletAddress: string): Promise<{
  nfts: OwnedNft[];
  error?: string;
}> {
  const key = (process.env.ALCHEMY_API_KEY || "").trim();
  if (!key) return { nfts: [], error: "missing_key" };

  const base = `https://base-mainnet.g.alchemy.com/nft/v3/${key}/getNFTsForOwner`;
  const url = `${base}?owner=${walletAddress}&withMetadata=true&pageSize=100`;

  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const data = (await res.json()) as any;
    if (!res.ok) {
      return {
        nfts: [],
        error: data?.message || data?.error?.message || `Alchemy HTTP ${res.status}`,
      };
    }
    const owned = Array.isArray(data?.ownedNfts) ? data.ownedNfts : [];
    const nfts: OwnedNft[] = owned.map((n: any) => {
      const contract = (n.contract?.address || n.contractAddress || "").toLowerCase();
      const tokenId = String(
        n.tokenId ?? n.id?.tokenId ?? "0"
      ).replace(/^0x/, (h: string) => {
        try {
          return BigInt("0x" + h).toString();
        } catch {
          return h;
        }
      });
      // tokenId may already be decimal
      let tid = String(n.tokenId ?? "0");
      try {
        if (tid.startsWith("0x")) tid = BigInt(tid).toString();
      } catch {
        /* keep */
      }
      return {
        contractAddress: contract,
        tokenId: tid,
        name: n.name || n.title || n.rawMetadata?.name || `Token #${tid}`,
        collectionName:
          n.contract?.name || n.collection?.name || n.contractMetadata?.name || "",
      };
    }).filter((n: OwnedNft) => n.contractAddress);

    return { nfts };
  } catch (err) {
    return { nfts: [], error: err instanceof Error ? err.message : String(err) };
  }
}

async function fetchNftsReservoir(walletAddress: string): Promise<{
  nfts: OwnedNft[];
  error?: string;
}> {
  const apiKey = process.env.RESERVOIR_API_KEY || "demo-api-key";
  const url = `https://api-base.reservoir.tools/users/${walletAddress}/tokens/v7?limit=100`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "x-api-key": apiKey },
    });
    const data = (await res.json()) as any;
    if (!res.ok) {
      return {
        nfts: [],
        error: data?.message || `Reservoir HTTP ${res.status}`,
      };
    }
    const tokens = Array.isArray(data?.tokens) ? data.tokens : [];
    const nfts: OwnedNft[] = tokens.map((t: any) => {
      const token = t.token || t;
      return {
        contractAddress: String(token.contract || "").toLowerCase(),
        tokenId: String(token.tokenId ?? ""),
        name: token.name || `Token #${token.tokenId}`,
        collectionName: token.collection?.name || "",
      };
    }).filter((n: OwnedNft) => n.contractAddress && n.tokenId);

    return { nfts };
  } catch (err) {
    return { nfts: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export async function fetchWalletPortfolio(
  walletAddress: string
): Promise<WalletPortfolio> {
  let nfts: OwnedNft[] = [];
  let lastError: string | undefined;

  const alchemy = await fetchNftsAlchemy(walletAddress);
  if (alchemy.nfts.length > 0) {
    nfts = alchemy.nfts;
  } else if (alchemy.error && alchemy.error !== "missing_key") {
    lastError = `Alchemy: ${alchemy.error}`;
  }

  if (nfts.length === 0) {
    const reservoir = await fetchNftsReservoir(walletAddress);
    if (reservoir.nfts.length > 0) {
      nfts = reservoir.nfts;
      lastError = undefined;
    } else if (reservoir.error) {
      lastError = lastError
        ? `${lastError}; Reservoir: ${reservoir.error}`
        : `Reservoir: ${reservoir.error}`;
    }
  }

  if (nfts.length === 0) {
    if (!process.env.ALCHEMY_API_KEY && lastError) {
      return {
        items: [],
        totalFloorValueEth: 0,
        error:
          "Set ALCHEMY_API_KEY (free at dashboard.alchemy.com) — Etherscan free tier cannot list Base NFTs.",
      };
    }
    if (lastError) {
      return { items: [], totalFloorValueEth: 0, error: lastError };
    }
    return { items: [], totalFloorValueEth: 0 };
  }

  const floorCache = new Map<string, FloorData | null>();
  const getFloor = async (contract: string): Promise<FloorData | null> => {
    if (floorCache.has(contract)) return floorCache.get(contract)!;
    try {
      const floor = await fetchCollectionFloor(contract);
      floorCache.set(contract, floor);
      return floor;
    } catch {
      floorCache.set(contract, null);
      return null;
    }
  };

  const items: PortfolioItem[] = [];
  for (const n of nfts) {
    const floor = await getFloor(n.contractAddress);
    items.push({
      contractAddress: n.contractAddress,
      tokenId: n.tokenId,
      name: floor?.collectionName || n.name,
      collectionName: floor?.collectionName || n.collectionName || "",
      floorPriceEth: floor?.floorPriceEth ?? 0,
      topBidEth: floor?.topBidEth ?? 0,
      openseaUrl: `https://opensea.io/assets/base/${n.contractAddress}/${n.tokenId}`,
    });
  }

  const totalFloorValueEth = items.reduce((s, i) => s + i.floorPriceEth, 0);
  return { items, totalFloorValueEth };
}

export async function executeSell(
  privateKey: string,
  contractAddress: string,
  tokenId: string
): Promise<SellResult> {
  const apiKey = process.env.RESERVOIR_API_KEY || "demo-api-key";
  const body = {
    orders: [{ token: `${contractAddress}:${tokenId}`, weiPrice: "0" }],
  };

  let res: Response;
  try {
    res = await fetch("https://api-base.reservoir.tools/execute/sell/v6", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      success: false,
      error: `Reservoir request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    return {
      success: false,
      error: `Reservoir API error ${res.status}: ${bodyText.slice(0, 200)}`,
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
    const hexKey = (
      privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`
    ) as Hex;
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
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
