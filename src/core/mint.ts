import { type Address, type Hex, parseAbi, encodeFunctionData, getAddress } from "viem";
import { prisma } from "../db/client.js";
import { getPublicClient, getWalletClient } from "./chain.js";
import { assertGasSafe } from "./gasGuard.js";
import { getActiveWallets, getWalletPrivateKey } from "./wallet.js";
import { scanContract, getBestMintFunction, type MintFunctionInfo } from "./scanner.js";
import { getContextChain } from "./chainContext.js";
import { getChainConfig, getDefaultChainId, type ChainId } from "./chains.js";

export interface MintResult {
  walletId: string;
  walletAddress: string;
  label: string;
  success: boolean;
  txHash?: string;
  error?: string;
  basescanUrl?: string;
  iteration?: number;
}

export interface BatchMintResult {
  contractAddress: string;
  results: MintResult[];
  totalSuccess: number;
  totalFailed: number;
}

const userMintQuantities = new Map<bigint, number>();

export function getUserMintQuantity(userId: bigint): number {
  return userMintQuantities.get(userId) ?? 1;
}

export function setUserMintQuantity(userId: bigint, quantity: number): void {
  userMintQuantities.set(userId, Math.max(1, Math.min(quantity, 10)));
}

// Build the exact calldata args for a given mint round. This must match what the
// simulation sees so sequential/quantity contracts don't pass simulation and then revert.
function buildMintArgs(
  mintFunction: MintFunctionInfo,
  walletAddress: string,
  iteration: number
): unknown[] {
  const args: unknown[] = [];
  for (const argType of mintFunction.args) {
    if (argType.includes("address")) {
      args.push(walletAddress as Address);
    } else if (argType.includes("uint") || argType.includes("int")) {
      args.push(BigInt(iteration));
    } else if (argType.startsWith("bytes32[")) {
      args.push([]);
    } else if (argType.startsWith("bytes")) {
      args.push("0x");
    } else if (argType === "bool") {
      args.push(false);
    } else {
      args.push("0x");
    }
  }
  return args;
}

// Simulate the exact transaction we're about to send (eth_call, zero gas).
async function simulateMintWithArgs(
  contractAddress: string,
  fromAddress: string,
  mintFunction: MintFunctionInfo,
  args: unknown[]
): Promise<{ success: boolean; error?: string }> {
  const client = getPublicClient();
  try {
    const abiItem = parseAbi([`function ${mintFunction.name}(${mintFunction.args.join(",")})`] as const);
    const data = encodeFunctionData({
      abi: abiItem,
      functionName: mintFunction.name,
      args: args as any,
    });
    await client.call({
      data,
      to: getAddress(contractAddress),
      account: getAddress(fromAddress),
      value: 0n,
    });
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

export async function executeMintForWallet(
  walletId: string,
  walletAddress: string,
  label: string,
  contractAddress: string,
  mintFunction: MintFunctionInfo,
  userId: bigint,
  iteration: number = 1,
  prefetchedNonce?: number
): Promise<MintResult> {
  const privateKey = (await getWalletPrivateKey(walletId)) as Hex;
  const hexKey = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  const walletClient = getWalletClient(hexKey as Hex);
  const publicClient = getPublicClient();
  const iterLabel = iteration > 1 ? `${label} (Mint #${iteration})` : label;

  // Resolve the active chain from context (set by withChainContext in handlers/
  // main/sniper) so history rows and explorer links point at the right network.
  const chain: ChainId = getContextChain() ?? getDefaultChainId();

  try {
    const args = buildMintArgs(mintFunction, walletAddress, iteration);

    // 1. Simulate with the REAL args (not a hardcoded 1n).
    const simResult = await simulateMintWithArgs(contractAddress, walletAddress, mintFunction, args);
    if (!simResult.success) {
      await recordMintHistory(userId, contractAddress, null, "SIMULATION_FAILED", chain);
      return {
        walletId,
        walletAddress,
        label: iterLabel,
        success: false,
        error: `Simulation failed: ${simResult.error}`,
        iteration,
      };
    }

    // 2. Send-time gas enforcement: aborts if gas spiked above the user's ceiling
    //    after the decision point (throws -> caught below, clean failure).
    await assertGasSafe(userId);

    const abiItem = parseAbi([`function ${mintFunction.name}(${mintFunction.args.join(",")})`] as const);
    const data = encodeFunctionData({
      abi: abiItem,
      functionName: mintFunction.name,
      args: args as any,
    });

    const nonce =
      prefetchedNonce ??
      (await publicClient.getTransactionCount({
        address: walletAddress as Address,
        blockTag: "pending",
      }));

    // 3. Send with the chain-aware wallet client (resolves via context).
    const txHash = await walletClient.sendTransaction({
      to: contractAddress as Address,
      data,
      value: 0n,
      nonce,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    const status = receipt.status === "success" ? "SUCCESS" : "FAILED";
    await recordMintHistory(userId, contractAddress, txHash, status, chain);

    return {
      walletId,
      walletAddress,
      label: iterLabel,
      success: receipt.status === "success",
      txHash,
      basescanUrl: `${getChainConfig(chain).explorerBaseUrl}/tx/${txHash}`,
      error: receipt.status !== "success" ? "Transaction reverted on-chain" : undefined,
      iteration,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordMintHistory(userId, contractAddress, null, "ERROR", chain);
    return {
      walletId,
      walletAddress,
      label: iterLabel,
      success: false,
      error: message,
      iteration,
    };
  }
}

export async function batchMint(
  userId: bigint,
  contractAddress: string
): Promise<BatchMintResult> {
  const scanResult = await scanContract(contractAddress);

  if (!scanResult.isContract || scanResult.mintFunctions.length === 0) {
    return { contractAddress, results: [], totalSuccess: 0, totalFailed: 0 };
  }

  const freeMints = scanResult.mintFunctions.filter((f) => f.isFreeMint && !f.requiresPayment);
  if (freeMints.length === 0) {
    return { contractAddress, results: [], totalSuccess: 0, totalFailed: 0 };
  }

  const mintFunction = getBestMintFunction(freeMints);
  if (!mintFunction) {
    return { contractAddress, results: [], totalSuccess: 0, totalFailed: 0 };
  }

  const activeWallets = await getActiveWallets(userId);
  if (activeWallets.length === 0) {
    return { contractAddress, results: [], totalSuccess: 0, totalFailed: 0 };
  }

  const rounds = getUserMintQuantity(userId);
  const allResults: MintResult[] = [];
  const publicClient = getPublicClient();

  for (const w of activeWallets) {
    let currentNonce = await publicClient.getTransactionCount({
      address: w.address as Address,
      blockTag: "pending",
    });

    for (let round = 1; round <= rounds; round++) {
      const res = await executeMintForWallet(
        w.id,
        w.address,
        w.label,
        contractAddress,
        mintFunction,
        userId,
        round,
        currentNonce
      );
      allResults.push(res);

      if (res.success) {
        currentNonce++;
      } else {
        break;
      }

      if (round < rounds) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }

  const totalSuccess = allResults.filter((r) => r.success).length;
  const totalFailed = allResults.filter((r) => !r.success).length;

  return { contractAddress, results: allResults, totalSuccess, totalFailed };
}

export async function manualMint(
  userId: bigint,
  contractAddress: string
): Promise<BatchMintResult> {
  return batchMint(userId, contractAddress);
}

async function recordMintHistory(
  userId: bigint,
  contractAddress: string,
  txHash: string | null,
  status: string,
  chain: ChainId
): Promise<void> {
  try {
    await prisma.mintHistory.create({
      data: { userId, contractAddress, txHash, status, chain },
    });
  } catch (err) {
    console.error("Failed to record mint history:", err);
  }
}

export async function getMintHistory(userId: bigint, limit = 10) {
  return prisma.mintHistory.findMany({
    where: { userId },
    orderBy: { timestamp: "desc" },
    take: limit,
  });
}
