/**
 * Mint Engine - Production Version
 * Features: Error classification, RPC failover, SeaDrop support, History tracking
 */

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
  errorCategory?: string;
  basescanUrl?: string;
  iteration?: number;
}

export interface BatchMintResult {
  contractAddress: string;
  results: MintResult[];
  totalSuccess: number;
  totalFailed: number;
  abortReason?: string;
}

export interface SeaDropContext {
  isViaRouter: boolean;
  routerAddress: string;
  feeRecipient?: string;
  quantity?: number;
}

export interface MintOptions {
  contractAddress?: string;
  seaDropContext?: SeaDropContext;
}

export type MintErrorCategory = 
  | "WHITELIST"
  | "SIGNATURE"
  | "SOLD_OUT"
  | "TIMING"
  | "GAS"
  | "RPC"
  | "INSUFFICIENT_FUNDS"
  | "UNKNOWN";

export interface ClassifiedError {
  category: MintErrorCategory;
  message: string;
  retryable: boolean;
  userFriendly: string;
}

const userMintQuantities = new Map<bigint, number>();

export function getUserMintQuantity(userId: bigint): number {
  return userMintQuantities.get(userId) ?? 1;
}

export function setUserMintQuantity(userId: bigint, quantity: number): void {
  userMintQuantities.set(userId, Math.max(1, Math.min(quantity, 10)));
}

// SeaDrop Router ABI for mintPublic
const SEADROP_ROUTER_ABI = parseAbi([
  "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable",
] as const);

// Standard transfer events for receipt verification
const STANDARD_TRANSFER_EVENTS = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
] as const);

export function classifyMintError(error: unknown): ClassifiedError {
  const errorStr = (error instanceof Error ? error.message : String(error)).toLowerCase();
  
  // Whitelist/Allowlist errors
  if (
    errorStr.includes("not whitelisted") ||
    errorStr.includes("not on whitelist") ||
    errorStr.includes("allowlist") ||
    errorStr.includes("not eligible") ||
    errorStr.includes("unauthorized") ||
    errorStr.includes("caller is not") ||
    errorStr.includes("merkle") ||
    errorStr.includes("proof") ||
    errorStr.includes("not in merkle tree")
  ) {
    return {
      category: "WHITELIST",
      message: errorStr,
      retryable: false,
      userFriendly: "❌ WHITELISTED: Your wallet is not on the allowlist for this mint.",
    };
  }
  
  // Signature errors
  if (
    errorStr.includes("signature") ||
    errorStr.includes("invalid signer") ||
    errorStr.includes("ecrecover") ||
    errorStr.includes("0xe12d2314") ||
    errorStr.includes("invalid signature")
  ) {
    return {
      category: "SIGNATURE",
      message: errorStr,
      retryable: false,
      userFriendly: "❌ SIGNATURE REQUIRED: This mint requires a valid signature from the project.",
    };
  }
  
  // Sold out / Supply errors
  if (
    errorStr.includes("sold out") ||
    errorStr.includes("exceeds supply") ||
    errorStr.includes("max supply") ||
    errorStr.includes("no tokens left") ||
    errorStr.includes("minting closed") ||
    errorStr.includes("sale closed") ||
    errorStr.includes("all tokens have been minted") ||
    errorStr.includes("exceeds max") ||
    errorStr.includes("cap reached")
  ) {
    return {
      category: "SOLD_OUT",
      message: errorStr,
      retryable: false,
      userFriendly: "❌ SOLD OUT: All NFTs in this collection have been minted.",
    };
  }
  
  // Timing errors
  if (
    errorStr.includes("not started") ||
    errorStr.includes("sale not active") ||
    errorStr.includes("mint not active") ||
    errorStr.includes("too early") ||
    errorStr.includes("before start") ||
    errorStr.includes("has not started") ||
    errorStr.includes("not yet active")
  ) {
    return {
      category: "TIMING",
      message: errorStr,
      retryable: true,
      userFriendly: "⏰ NOT YET ACTIVE: This mint hasn't started yet.",
    };
  }
  
  // Gas errors
  if (
    errorStr.includes("gas") ||
    errorStr.includes("estimate") ||
    errorStr.includes("execution reverted") ||
    errorStr.includes("intrinsic gas")
  ) {
    return {
      category: "GAS",
      message: errorStr,
      retryable: true,
      userFriendly: "⛽ GAS ERROR: Transaction simulation failed.",
    };
  }
  
  // RPC errors
  if (
    errorStr.includes("rpc") ||
    errorStr.includes("network") ||
    errorStr.includes("timeout") ||
    errorStr.includes("connection") ||
    errorStr.includes("rate limit") ||
    errorStr.includes("compute units") ||
    errorStr.includes("request failed") ||
    errorStr.includes("503") ||
    errorStr.includes("429")
  ) {
    return {
      category: "RPC",
      message: errorStr,
      retryable: true,
      userFriendly: "🌐 NETWORK ERROR: RPC provider issue.",
    };
  }
  
  // Insufficient funds
  if (
    errorStr.includes("insufficient funds") ||
    errorStr.includes("not enough eth") ||
    errorStr.includes("balance too low")
  ) {
    return {
      category: "INSUFFICIENT_FUNDS",
      message: errorStr,
      retryable: false,
      userFriendly: "💰 LOW BALANCE: Wallet doesn't have enough ETH for gas.",
    };
  }
  
  // Default
  return {
    category: "UNKNOWN",
    message: errorStr,
    retryable: false,
    userFriendly: `❌ FAILED: ${errorStr.slice(0, 100)}${errorStr.length > 100 ? '...' : ''}`,
  };
}

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
      // not a standard transfer event
    }
  }
  return false;
}

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
    return value as bigint;
  } catch {
    return null;
  }
}

async function executeSeaDropMint(
  walletId: string,
  walletAddress: string,
  walletLabel: string,
  nftContract: string,
  seaDropContext: SeaDropContext,
  userId: bigint,
  iteration: number,
  nonce: number
): Promise<MintResult> {
  const chain = getContextChain() || getDefaultChainId();
  const { explorerBaseUrl } = getChainConfig(chain);
  
  try {
    const privateKey = await getWalletPrivateKey(walletId);
    const walletClient = getWalletClient(privateKey as Hex, chain);
    
    const feeRecipient = (seaDropContext.feeRecipient || "0x0000000000000000000000000000000000000000") as Address;
    const minterIfNotPayer = walletAddress as Address;
    const quantity = BigInt(seaDropContext.quantity || 1);
    
    const balanceBefore = await readNftBalance(nftContract, walletAddress);
    
    const hash = await walletClient.writeContract({
      address: seaDropContext.routerAddress as Address,
      abi: SEADROP_ROUTER_ABI,
      functionName: "mintPublic",
      args: [
        nftContract as Address,
        feeRecipient,
        minterIfNotPayer,
        quantity,
      ],
      value: 0n,
      nonce,
    });
    
    const publicClient = getPublicClient(chain);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    
    if (receipt.status !== "success") {
      return {
        walletId,
        walletAddress,
        label: walletLabel,
        success: false,
        txHash: hash,
        basescanUrl: `${explorerBaseUrl}/tx/${hash}`,
        error: "Transaction reverted on-chain",
        errorCategory: "GAS",
        iteration,
      };
    }
    
    const hasTransferEvent = mintEventsInReceipt(receipt, walletAddress);
    const balanceAfter = await readNftBalance(nftContract, walletAddress);
    const balanceIncreased = balanceAfter !== null && balanceBefore !== null && balanceAfter > balanceBefore;
    
    if (!hasTransferEvent && !balanceIncreased) {
      const classified = classifyMintError("TX mined but no NFT received");
      return {
        walletId,
        walletAddress,
        label: walletLabel,
        success: false,
        txHash: hash,
        basescanUrl: `${explorerBaseUrl}/tx/${hash}`,
        error: classified.userFriendly,
        errorCategory: classified.category,
        iteration,
      };
    }
    
    return {
      walletId,
      walletAddress,
      label: walletLabel,
      success: true,
      txHash: hash,
      basescanUrl: `${explorerBaseUrl}/tx/${hash}`,
      iteration,
    };
    
  } catch (error) {
    const classified = classifyMintError(error);
    return {
      walletId,
      walletAddress,
      label: walletLabel,
      success: false,
      error: classified.userFriendly,
      errorCategory: classified.category,
      iteration,
    };
  }
}

async function executeDirectMint(
  walletId: string,
  walletAddress: string,
  walletLabel: string,
  contractAddress: string,
  mintFunction: MintFunctionInfo,
  userId: bigint,
  iteration: number,
  nonce: number
): Promise<MintResult> {
  const chain = getContextChain() || getDefaultChainId();
  const { explorerBaseUrl } = getChainConfig(chain);
  
  try {
    const privateKey = await getWalletPrivateKey(walletId);
    const walletClient = getWalletClient(privateKey as Hex, chain);
    const publicClient = getPublicClient(chain);
    
    const args = buildMintArgs(mintFunction, walletAddress, iteration);
    
    const balanceBefore = await readNftBalance(contractAddress, walletAddress);
    
    const abiItem = parseAbi([`function ${mintFunction.name}(${mintFunction.args.join(",")})`] as const);
    const data = encodeFunctionData({
      abi: abiItem,
      functionName: mintFunction.name,
      args: args as any,
    });
    
    const simResult = await simulateMintWithArgs(contractAddress, walletAddress, mintFunction, args);
    if (!simResult.success) {
      const classified = classifyMintError(simResult.error || "Simulation failed");
      return {
        walletId,
        walletAddress,
        label: walletLabel,
        success: false,
        error: classified.userFriendly,
        errorCategory: classified.category,
        iteration,
      };
    }
    
    const hash = await walletClient.sendTransaction({
      to: getAddress(contractAddress),
      data,
      value: 0n,
      nonce,
    });
    
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    
    if (receipt.status !== "success") {
      return {
        walletId,
        walletAddress,
        label: walletLabel,
        success: false,
        txHash: hash,
        basescanUrl: `${explorerBaseUrl}/tx/${hash}`,
        error: "Transaction reverted on-chain",
        errorCategory: "GAS",
        iteration,
      };
    }
    
    const hasTransferEvent = mintEventsInReceipt(receipt, walletAddress);
    const balanceAfter = await readNftBalance(contractAddress, walletAddress);
    const balanceIncreased = balanceAfter !== null && balanceBefore !== null && balanceAfter > balanceBefore;
    
    if (!hasTransferEvent && !balanceIncreased) {
      const classified = classifyMintError("TX mined but no NFT received");
      return {
        walletId,
        walletAddress,
        label: walletLabel,
        success: false,
        txHash: hash,
        basescanUrl: `${explorerBaseUrl}/tx/${hash}`,
        error: classified.userFriendly,
        errorCategory: classified.category,
        iteration,
      };
    }
    
    return {
      walletId,
      walletAddress,
      label: walletLabel,
      success: true,
      txHash: hash,
      basescanUrl: `${explorerBaseUrl}/tx/${hash}`,
      iteration,
    };
    
  } catch (error) {
    const classified = classifyMintError(error);
    return {
      walletId,
      walletAddress,
      label: walletLabel,
      success: false,
      error: classified.userFriendly,
      errorCategory: classified.category,
      iteration,
    };
  }
}

export async function batchMint(
  userId: bigint,
  contractAddress: string,
  options?: MintOptions
): Promise<BatchMintResult> {
  const chain = getContextChain() || getDefaultChainId();
  
  const targetContract = options?.contractAddress || contractAddress;
  
  // Check gas safety
  try {
    await assertGasSafe(userId);
  } catch (gasError: any) {
    return {
      contractAddress: targetContract,
      results: [],
      totalSuccess: 0,
      totalFailed: 0,
      abortReason: gasError?.message || "Gas price exceeds your limit",
    };
  }
  
  const activeWallets = await getActiveWallets(userId);
  if (activeWallets.length === 0) {
    return {
      contractAddress: targetContract,
      results: [],
      totalSuccess: 0,
      totalFailed: 0,
      abortReason: "No active wallets. Generate or activate wallets first.",
    };
  }
  
  // If SeaDrop context is provided, route through SeaDrop router
  if (options?.seaDropContext?.isViaRouter) {
    return executeSeaDropBatchMint(userId, targetContract, options.seaDropContext, activeWallets);
  }
  
  // Otherwise, scan and mint directly
  const scan = await scanContract(targetContract, chain);
  
  if (!scan.isContract || !scan.isNft) {
    return {
      contractAddress: targetContract,
      results: [],
      totalSuccess: 0,
      totalFailed: 0,
      abortReason: "Not a valid NFT contract",
    };
  }
  
  if (!scan.security?.isSafe) {
    return {
      contractAddress: targetContract,
      results: [],
      totalSuccess: 0,
      totalFailed: 0,
      abortReason: `Unsafe contract: ${scan.security?.warnings?.join(", ") || "security check failed"}`,
    };
  }
  
  const freeMintFunctions = scan.mintFunctions.filter((f) => f.isFreeMint && !f.requiresPayment);
  
  if (freeMintFunctions.length === 0) {
    return {
      contractAddress: targetContract,
      results: [],
      totalSuccess: 0,
      totalFailed: 0,
      abortReason: scan.requiresSignature 
        ? "Signature-required mint. Bot cannot generate valid signatures."
        : scan.isGated 
        ? "Gated/whitelist mint. Wallets may not be on allowlist."
        : "No free mint functions detected",
    };
  }
  
  const bestFn = getBestMintFunction(freeMintFunctions) || freeMintFunctions[0];
  
  const rounds = getUserMintQuantity(userId);
  const allResults: MintResult[] = [];
  const publicClient = getPublicClient(chain);
  
  for (const w of activeWallets) {
    let currentNonce = await publicClient.getTransactionCount({
      address: w.address as Address,
      blockTag: "pending",
    });
    
    for (let round = 1; round <= rounds; round++) {
      const res = await executeDirectMint(
        w.id,
        w.address,
        w.label,
        targetContract,
        bestFn,
        userId,
        round,
        currentNonce
      );
      
      allResults.push(res);
      
      if (res.success) {
        currentNonce++;
      } else {
        // Don't retry on non-retryable errors
        const classified = classifyMintError(res.error || "");
        if (!classified.retryable) break;
      }
      
      if (round < rounds) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }
  
  const totalSuccess = allResults.filter((r) => r.success).length;
  const totalFailed = allResults.filter((r) => !r.success).length;
  
  for (const r of allResults) {
    await recordMintHistory(userId, targetContract, r.txHash || null, r.success ? "success" : "failed", chain);
  }
  
  return { contractAddress: targetContract, results: allResults, totalSuccess, totalFailed };
}

async function executeSeaDropBatchMint(
  userId: bigint,
  nftContract: string,
  seaDropContext: SeaDropContext,
  activeWallets: Array<{ id: string; address: string; label: string }>
): Promise<BatchMintResult> {
  const chain = getContextChain() || getDefaultChainId();
  const rounds = getUserMintQuantity(userId);
  const allResults: MintResult[] = [];
  const publicClient = getPublicClient(chain);
  
  for (const w of activeWallets) {
    let currentNonce = await publicClient.getTransactionCount({
      address: w.address as Address,
      blockTag: "pending",
    });
    
    for (let round = 1; round <= rounds; round++) {
      const res = await executeSeaDropMint(
        w.id,
        w.address,
        w.label,
        nftContract,
        seaDropContext,
        userId,
        round,
        currentNonce
      );
      
      allResults.push(res);
      
      if (res.success) {
        currentNonce++;
      } else {
        const classified = classifyMintError(res.error || "");
        if (!classified.retryable) break;
      }
      
      if (round < rounds) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }
  
  const totalSuccess = allResults.filter((r) => r.success).length;
  const totalFailed = allResults.filter((r) => !r.success).length;
  
  for (const r of allResults) {
    await recordMintHistory(userId, nftContract, r.txHash || null, r.success ? "success" : "failed", chain);
  }
  
  return { contractAddress: nftContract, results: allResults, totalSuccess, totalFailed };
}

export async function manualMint(
  userId: bigint,
  contractAddress: string,
  options?: MintOptions
): Promise<BatchMintResult> {
  return batchMint(userId, contractAddress, options);
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
      data: { 
        userId, 
        contractAddress, 
        txHash, 
        status, 
        chain,
      },
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

export async function checkMintStillOpen(contractAddress: string): Promise<boolean> {
  return true;
}
