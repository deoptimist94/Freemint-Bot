import { createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { getPublicClient } from "./chain.js";

export interface FloorData {
  floorPriceEth: number;
  topBidEth: number;
  collectionName: string;
}

function apiKey(): string {
  return process.env.RESERVOIR_API_KEY || "demo-api-key";
}

// Fetch live floor price and collection stats using Reservoir API
export async function fetchCollectionFloor(contractAddress: string): Promise<FloorData> {
  try {
    const res = await fetch(
      `https://api-base.reservoir.tools/collections/v5?contract=${contractAddress}`,
      { headers: { Accept: "*/*", "x-api-key": apiKey() } }
    );

    if (res.ok) {
      const data = (await res.json()) as any;
      if (data?.collections?.length > 0) {
        const col = data.collections[0];
        return {
          floorPriceEth: Number(col.floorAsk?.price?.amount?.native ?? 0),
          topBidEth: Number(col.topBid?.price?.amount?.native ?? 0),
          collectionName: col.name || "Base Collection",
        };
      }
    } else {
      console.warn(`Reservoir collections API HTTP ${res.status}`);
    }
  } catch (err) {
    console.error("Error fetching collection floor:", err);
  }

  return { floorPriceEth: 0, topBidEth: 0, collectionName: "Base NFT" };
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

// Generate and execute a listing on secondary markets (OpenSea/Blur via Reservoir)
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

    const res = await fetch("https://api-base.reservoir.tools/execute/list/v5", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey(),
      },
      body: JSON.stringify({
        items: [{ token: `${contractAddress}:${tokenId}`, weiPrice }],
        taker: account.address,
      }),
    });

    if (!res.ok) {
      return {
        success: false,
        error: `Failed to construct marketplace listing order (HTTP ${res.status})`,
      };
    }

    const data = (await res.json()) as any;
    const steps: any[] = data?.steps ?? [];
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
      success: signedOffchain
        ? true
        : false,
      error: signedOffchain
        ? undefined
        : "Listing prepared but no on-chain transaction was emitted",
      txHash: undefined,
    };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}
