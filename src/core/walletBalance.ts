import { formatEther, type Address } from "viem";
import { getPublicClient } from "./chain.js";
import { getEthUsdPrice } from "./price.js";

export interface WalletBalanceInfo {
  address: string;
  ethBalance: string;
  usdBalance: string;
}

export async function fetchAllWalletsBalances(
  wallets: Array<{ address: string; isActive: boolean }>
): Promise<WalletBalanceInfo[]> {
  const client = getPublicClient();
  // getEthUsdPrice() caches the live price for 60s and only falls back to a
  // baseline (3000) if CoinGecko is unreachable — no more uncached per-call fetch.
  const ethPrice = await getEthUsdPrice();

  const results = await Promise.all(
    wallets.map(async (w) => {
      try {
        const balanceWei = await client.getBalance({ address: w.address as Address });
        const ethNum = parseFloat(formatEther(balanceWei));
        return {
          address: w.address,
          ethBalance: ethNum.toFixed(4),
          usdBalance: (ethNum * ethPrice).toFixed(2),
        };
      } catch {
        return {
          address: w.address,
          ethBalance: "0.0000",
          usdBalance: "0.00",
        };
      }
    })
  );

  return results;
}
