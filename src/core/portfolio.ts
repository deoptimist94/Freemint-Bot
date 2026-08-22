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
}

export interface SellResult {
  success: boolean;
  txHash?: string;
  payoutEth?: number;
  error?: string;
}

const BASESCAN_API = "https://api.basescan.org/api";

interface NftTx {
  contractAddress: string;
  tokenID: string;
  tokenName?: string;
  from: string;
  to: string;
}

export async function fetchWalletPortfolio(
  walletAddress: string
): Promise<WalletPortfolio> {
  const apiKey = process.env.BASESCAN_API_KEY ?? "";
  const url =
    `${BASESCAN_API}?module=account&action=tokennfttx&address=${walletAddress}` +
    `&page=1&offset=100&sort=desc&apikey=${apiKey}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`BaseScan API error ${res.status}`);

  const data = (await res.json()) as {
    status?: string;
    message?: string;
    result?: NftTx[];
  };
  const txs = Array.isArray(data.result) ? data.result : [];

  // Reconstruct currently held tokens (newest tx wins per token)
  const held = new Map<string, Map<string, string>>();
  const addr = walletAddress.toLowerCase();
  for (const tx of txs) {
    const contract = tx.contractAddress.toLowerCase();
    const tokenId = BigInt(tx.tokenID).toString();
    const from = (tx.from ?? "").toLowerCase();
    const to = (tx.to ?? "").toLowerCase();
    if (from === addr) {
      const tokens = held.get(contract);
      if (tokens) tokens.delete(tokenId);
    }
    if (to === addr) {
      let tokens = held.get(contract);
      if (!tokens) {
        tokens = new Map();
        held.set(contract, tokens);
      }
      tokens.set(tokenId, tx.tokenName || "");
    }
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
  for (const [contract, tokens] of held) {
    const floor = await getFloor(contract);
    for (const [tokenId, tokenName] of tokens) {
      items.push({
        contractAddress: contract,
        tokenId,
        name:
          floor?.collectionName ||
          tokenName ||
          `Base NFT (${contract.slice(0, 6)}...)`,
        collectionName: floor?.collectionName ?? "",
        floorPriceEth: floor?.floorPriceEth ?? 0,
        topBidEth: floor?.topBidEth ?? 0,
        openseaUrl: `https://opensea.io/assets/base/${contract}/${tokenId}`,
      });
    }
  }

  const totalFloorValueEth = items.reduce(
    (sum, item) => sum + item.floorPriceEth,
    0
  );
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
    return {
      success: false,
      error: "No active bids found on secondary markets",
    };
  }

  try {
    const hexKey = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;
    const walletClient = getWalletClient(hexKey);
    const txHash = await walletClient.sendTransaction({
      to: txData.to as Address,
      data: (txData.data ?? "0x") as Hex,
      value: BigInt(txData.value ?? "0"),
    });

    const publicClient = getPublicClient();
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    const payoutEth = Number(BigInt(txData.value ?? "0")) / 1e18;
    return { success: true, txHash, payoutEth };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
