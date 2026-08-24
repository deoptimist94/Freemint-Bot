import {
  type Address,
  type Hex,
  parseAbi,
  encodeFunctionData,
  getAddress,
  decodeEventLog,
  zeroAddress,
} from "viem";
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
  /** Set when batchMint returns without attempting any transaction. */
  abortReason?: string;
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

// ==== NFT receipt verification (fixes false "Success: 1") ====

const STANDARD_TRANSFER_EVENTS = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
] as const);

// True when the receipt contains a standard MINT event (Transfer/TransferSingle/
// TransferBatch) FROM the zero address TO the given wallet. Covers ERC-721,
// ERC-1155 and most proxy/ERC-721A implementations.
function mintEventsInReceipt(
  receipt: { logs: readonly unknown[] },
  walletAddress: string
): boolean {
  const dst = walletAddress.toLowerCase();
  for (const log of receipt.logs as Array<{ data: Hex; topics: Hex[] }>) {
    try {
      const decoded = decodeEventLog({
        abi: STANDARD_TRANSFER_EVENTS,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      }) as unknown as { args?: { from?: string; to?: string } };
      const from = (decoded.args?.from ?? "").toLowerCase();
      const to = (decoded.args?.to ?? "").toLowerCase();
      if (from === zeroAddress && to === dst) return true;
    } catch {
      // not one of the standard transfer events — ignore
    }
  }
  return false;
}

// Standard ERC-721 balanceOf(owner). Best-effort: returns null when the contract
// doesn't expose it (ERC-1155, some proxies). Used for a pre/post delta check.
async function readNftBalance(
  contractAddress: string,
  walletAddress: string
): Promise<bigint | null> {
  const client = getPublicClient();
  try {
    const value = await client.readContract({
      address: getAddress(contractAddress) as Address,
      abi: parseAbi([
        "function balanceOf(address owner) external view returns (uint256)",
      ] as const),
      functionName: "balanceOf",
      args: [getAddress(walletAddress) as Address],
    });
    return BigInt(String(value ?? 0));
  } catch {
    return null;
  }
}

// Best-effort supply gate: aborts BEFORE spending gas when the collection is
// provably sold out. Returns false only when BOTH totalSupply() and maxSupply()
// read cleanly AND totalSupply >= maxSupply. Any read error = "unknown" → true
// (the per-wallet simulation stays the authoritative gate).
export async function checkMintStillOpen(contractAddress: string): Promise<boolean> {
  const client = getPublicClient();
  const supplyAbi = parseAbi([
    "function totalSupply() external view returns (uint256)",
    "function maxSupply() external view returns (uint256)",
  ] as const);
  let total: bigint | null = null;
  let max: bigint | null = null;
  try {
    total = BigInt(
      String(
        (await client.readContract({
          address: getAddress(contractAddress) as Address,
          abi: supplyAbi,
          functionName: "totalSupply",
        })) ?? 0
      )
    );
  } catch {
    // not ERC-721-style — skip the pre-check
  }
  if (total === null) return true;
  try {
    max = BigInt(
      String(
        (await client.readContract({
          address: getAddress(contractAddress) as Address,
          abi: supplyAbi,
          functionName: "maxSupply",
        })) ?? 0
      )
    );
  } catch {
    // no maxSupply() — can't prove it's closed
  }
  if (max === null) return true;
  return total < max;
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

    // 2b. Pre-mint NFT balance (best-effort) so we can prove delivery after mining.
    const preBalance = await readNftBalance(contractAddress, walletAddress);

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

    if (receipt.status !== "success") {
      await recordMintHistory(userId, contractAddress, txHash, "FAILED", chain);
      return {
        walletId,
        walletAddress,
        label: iterLabel,
        success: false,
        txHash,
        basescanUrl: `${getChainConfig(chain).explorerBaseUrl}/tx/${txHash}`,
        error: `Transaction reverted on-chain (status ${receipt.status})`,
        iteration,
      };
    }

    // 4. VERIFY the wallet actually received NFT(s). A successful receipt only
    //    means the tx mined — many "free mints" succeed while minting 0
    //    (whitelist no-op, soft sold-out, or wrong contract). Without this check
    //    the bot reported "Success: 1" with zero NFTs in the wallet.
    const postBalance =
      preBalance === null ? null : await readNftBalance(contractAddress, walletAddress);
    const delta =
      preBalance !== null && postBalance !== null ? postBalance - preBalance : null;
    const received =
      mintEventsInReceipt(receipt, walletAddress) || (delta !== null && delta > 0n);

    if (!received) {
      await recordMintHistory(userId, contractAddress, txHash, "NO_NFT", chain);
      return {
        walletId,
        walletAddress,
        label: iterLabel,
        success: false,
        txHash,
        basescanUrl: `${getChainConfig(chain).explorerBaseUrl}/tx/${txHash}`,
        error: "TX mined but no NFT received (no mint Transfer event, balance unchanged)",
        iteration,
      };
    }

    await recordMintHistory(userId, contractAddress, txHash, "SUCCESS", chain);
    return {
      walletId,
      walletAddress,
      label: iterLabel,
      success: true,
      txHash,
      basescanUrl: `${getChainConfig(chain).explorerBaseUrl}/tx/${txHash}`,
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
    return {
      contractAddress,
      results: [],
      totalSuccess: 0,
      totalFailed: 0,
      abortReason: "Not a contract or no mint functions detected",
    };
  }

  const freeMints = scanResult.mintFunctions.filter((f) => f.isFreeMint && !f.requiresPayment);
  if (freeMints.length === 0) {
    return {
      contractAddress,
      results: [],
      totalSuccess: 0,
      totalFailed: 0,
      abortReason: "No free mint functions available on this contract",
    };
  }

  const mintFunction = getBestMintFunction(freeMints);
  if (!mintFunction) {
    return {
      contractAddress,
      results: [],
      totalSuccess: 0,
      totalFailed: 0,
      abortReason: "No usable mint function found",
    };
  }

  // Supply pre-check: don't spend gas on a collection that is provably sold out.
  const stillOpen = await checkMintStillOpen(contractAddress).catch(() => true);
  if (!stillOpen) {
    return {
      contractAddress,
      results: [],
      totalSuccess: 0,
      totalFailed: 0,
      abortReason: "Mint ended — supply exhausted (totalSupply >= maxSupply)",
    };
  }

  const activeWallets = await getActiveWallets(userId);
  if (activeWallets.length === 0) {
    return {
      contractAddress,
      results: [],
      totalSuccess: 0,
      totalFailed: 0,
      abortReason: "No active wallets — add and fund a wallet first",
    };
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
