import { type Hex, type Address, createWalletClient, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { getPublicClient } from "./chain.js";

export interface PortfolioItem {
  contractAddress: string;
  tokenId: string;
  collectionName: string;
  floorPriceEth: number;
  topBidEth: number;
  openseaUrl: string;
}

export interface WalletPortfolio {
  walletAddress: string;
  items: PortfolioItem[];
  totalNfts: number;
  totalFloorValueEth: number;
}

// Reservoir responses are cached per wallet to protect the free API tier.
const CACHE_TTL_MS = 5 * 60_000;
const reservoirCache = new Map<
  string,
  { expiresAt: number; data: Map<string, { floor: number; bid: number; name: string }> }
>();

function reservoirApiKey(): string {
  return process.env.RESERVOIR_API_KEY || "demo-api-key";
}

async function fetchReservoirPortfolio(
  walletAddress: string
): Promise<Map<string, { floor: number; bid: number; name: string }>> {
  const key = walletAddress.toLowerCase();
  const cached = reservoirCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const out = new Map<string, { floor: number; bid: number; name: string }>();
  try {
    const res = await fetch(`https://api-base.reservoir.tools/users/${walletAddress}/tokens/v7`, {
      headers: { Accept: "*/*", "x-api-key": reservoirApiKey() },
    });
    if (res.ok) {
      const json = (await res.json()) as any;
      const tokens = json?.tokens ?? [];
      for (const t of tokens) {
        const contract = t?.token?.contract?.toLowerCase();
        const tokenId = t?.token?.tokenId;
        if (!contract || tokenId === undefined) continue;
        const col = t?.token?.collection ?? {};
        out.set(`${contract}:${tokenId}`, {
          floor: Number(t?.market?.floorAsk?.price?.amount?.native ?? 0),
          bid: Number(t?.market?.topBid?.price?.amount?.native ?? 0),
          name: col?.name || `Base NFT (${contract.slice(0, 6)}...)`,
        });
      }
    } else {
      console.warn(`Reservoir portfolio returned HTTP ${res.status} for ${walletAddress}`);
    }
  } catch (err) {
    console.warn(`Reservoir portfolio error for ${walletAddress}:`, err);
  }

  reservoirCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, data: out });
  return out;
}

export async function fetchWalletPortfolio(walletAddress: string): Promise<WalletPortfolio> {
  const items: PortfolioItem[] = [];
  const targetWallet = walletAddress.toLowerCase();

  // 1. Determine held tokens from BaseScan (reliable token-history source).
  try {
    const apiKey = process.env.BASESCAN_API_KEY || "";
    const url = `https://api.basescan.org/api?module=account&action=tokennfttx&address=${walletAddress}&apikey=${apiKey}`;

    const res = await fetch(url);
    if (res.ok) {
      const data = (await res.json()) as any;

      if (data?.status === "1" && Array.isArray(data.result)) {
        const held = new Map<string, { contract: string; tokenId: string }>();

        for (const tx of data.result) {
          const contract = tx.contractAddress?.toLowerCase();
          const tokenId = tx.tokenID;
          const to = tx.to?.toLowerCase();
          const from = tx.from?.toLowerCase();

          if (!contract || tokenId === undefined) continue;
          const key = `${contract}-${tokenId}`;

          if (to === targetWallet) {
            held.set(key, { contract, tokenId });
          } else if (from === targetWallet) {
            held.delete(key);
          }
        }

        // 2. Enrich with live floor/top-bid from Reservoir (cached 5 min).
        const market = await fetchReservoirPortfolio(walletAddress);

        for (const token of held.values()) {
          const marketKey = `${token.contract}:${token.tokenId}`;
          const m = market.get(marketKey);
          items.push({
            contractAddress: token.contract,
            tokenId: token.tokenId,
            collectionName: m?.name || `Base NFT (${token.contract.slice(0, 6)}...)`,
            floorPriceEth: m?.floor ?? 0,
            topBidEth: m?.bid ?? 0,
            openseaUrl: `https://opensea.io/assets/base/${token.contract}/${token.tokenId}`,
          });
        }
      }
    }
  } catch (err) {
    console.error(`Portfolio fetch error for ${walletAddress}:`, err);
  }

  const totalFloorValueEth = items.reduce((sum, i) => sum + i.floorPriceEth, 0);

  return {
    walletAddress,
    items,
    totalNfts: items.length,
    totalFloorValueEth,
  };
}

export async function executeSell(
  privateKey: Hex,
  contractAddress: string,
  tokenId: string
): Promise<{ success: boolean; payoutEth?: number; txHash?: string; error?: string }> {
  const account = privateKeyToAccount(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
  const token = `${contractAddress.toLowerCase()}:${tokenId}`;

  try {
    // 1. Fetch the best active bid (buy order) for this token.
    const bidsRes = await fetch(
      `https://api-base.reservoir.tools/orders/bids/v5?token=${token}&status=active&sortBy=price&limit=1`,
      { headers: { Accept: "*/*", "x-api-key": reservoirApiKey() } }
    );
    if (!bidsRes.ok) {
      return { success: false, error: `Reservoir bids API HTTP ${bidsRes.status}` };
    }
    const bidsJson = (await bidsRes.json()) as any;
    const bestBid = bidsJson?.orders?.[0];
    if (!bestBid?.id) {
      return { success: false, error: "No active bids found on secondary markets" };
    }

    const payoutEth = Number(bestBid?.price?.amount?.native ?? 0);
    if (payoutEth <= 0) {
      return { success: false, error: "Best bid has zero payout — cannot liquidate" };
    }

    // 2. Execute the sale (fulfill the buyer's signed order on-chain).
    const sellRes = await fetch("https://api-base.reservoir.tools/execute/sell/v7", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": reservoirApiKey(),
      },
      body: JSON.stringify({
        items: [{ orderId: bestBid.id }],
        taker: account.address,
        chainId: 8453,
      }),
    });
    if (!sellRes.ok) {
      return { success: false, error: `Failed to construct sell: HTTP ${sellRes.status}` };
    }
    const sellJson = (await sellRes.json()) as any;
    const steps: any[] = sellJson?.steps ?? [];
    if (steps.length === 0) {
      return { success: false, error: "No sell steps returned by marketplace" };
    }

    const publicClient = getPublicClient();
    const walletClient = createWalletClient({
      account,
      chain: base,
      transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org"),
    });

    // 3. Walk the steps: optional EIP-712 signature, then transaction(s).
    for (const step of steps) {
      if (step.kind === "signature") {
        const item = step.items?.[0]?.data;
        if (item?.types && item?.domain && item?.value) {
          await (walletClient as any).signTypedData({
            domain: item.domain,
            types: item.types,
            primaryType: item.primaryType || "OrderComponents",
            message: item.value,
          });
        }
        continue;
      }

      for (const it of step.items ?? []) {
        const txData = it?.data;
        if (!txData?.to || !txData?.data) continue;

        const txHash = await walletClient.sendTransaction({
          to: txData.to as Address,
          data: txData.data as Hex,
          value: BigInt(txData.value || "0"),
        });

        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        if (receipt.status !== "success") {
          return { success: false, error: "Sale transaction reverted on-chain", txHash };
        }
        return { success: true, payoutEth, txHash };
      }
    }

    return {
      success: false,
      error: "Sale prepared but no on-chain transaction was emitted (off-chain order accepted)",
    };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}
