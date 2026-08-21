import {
  createWalletClient,
  http,
  type Hex,
  getAddress,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { getPublicClient } from "./chain.js";
import { getWallets, getWalletPrivateKey } from "./wallet.js";

export interface SweepResult {
  walletLabel: string;
  fromAddress: string;
  sweptEth: number;
  txHash?: string;
  error?: string;
}

const TRANSFER_GAS = 21000n;

export async function sweepDustToMaster(
  userId: bigint,
  destinationAddress: string
): Promise<{ totalSweptEth: number; results: SweepResult[] }> {
  const publicClient = getPublicClient();
  const wallets = await getWallets(userId);
  const cleanDestination = getAddress(destinationAddress);

  const results: SweepResult[] = [];
  let totalSweptEth = 0;

  // EIP-1559 fee data (Base is a 1559 chain) — fetched once per sweep.
  let maxFeePerGas: bigint | undefined;
  let maxPriorityFeePerGas: bigint | undefined;
  try {
    const fees = await publicClient.estimateFeesPerGas();
    maxFeePerGas = fees.maxFeePerGas;
    maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
  } catch (err) {
    console.warn("estimateFeesPerGas failed, falling back to legacy pricing:", err);
  }

  for (const w of wallets) {
    // Skip if this wallet is the destination
    if (getAddress(w.address).toLowerCase() === cleanDestination.toLowerCase()) {
      continue;
    }

    try {
      const balance = await publicClient.getBalance({ address: getAddress(w.address) });
      if (balance === 0n) {
        results.push({
          walletLabel: w.label,
          fromAddress: w.address,
          sweptEth: 0,
          error: "0 balance",
        });
        continue;
      }

      const gasPrice = maxFeePerGas ?? (await publicClient.getGasPrice());
      const gasCost = TRANSFER_GAS * gasPrice;

      if (balance <= gasCost) {
        results.push({
          walletLabel: w.label,
          fromAddress: w.address,
          sweptEth: 0,
          error: "Balance insufficient for gas",
        });
        continue;
      }

      const privateKey = await getWalletPrivateKey(w.id);
      const hexKey = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;
      const account = privateKeyToAccount(hexKey);

      const walletClient = createWalletClient({
        account,
        chain: base,
        transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org"),
      });

      const sendAmount = balance - gasCost;

      const params: any = {
        to: cleanDestination,
        value: sendAmount,
        gas: TRANSFER_GAS,
      };
      if (maxFeePerGas !== undefined && maxPriorityFeePerGas !== undefined) {
        params.maxFeePerGas = maxFeePerGas;
        params.maxPriorityFeePerGas = maxPriorityFeePerGas;
      }

      const txHash = await walletClient.sendTransaction(params);

      await publicClient.waitForTransactionReceipt({ hash: txHash });

      const ethValue = Number(sendAmount) / 1e18;
      totalSweptEth += ethValue;

      results.push({
        walletLabel: w.label,
        fromAddress: w.address,
        sweptEth: ethValue,
        txHash,
      });
    } catch (err) {
      results.push({
        walletLabel: w.label,
        fromAddress: w.address,
        sweptEth: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { totalSweptEth, results };
}
