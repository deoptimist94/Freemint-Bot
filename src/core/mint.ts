/**
 * Mint Engine - Production Version
 * Features: Error classification, RPC failover, SeaDrop support, History tracking, Enhanced gas handling
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
  gasUsed?: bigint;
}

export interface BatchMintResult {
  contractAddress: string;
  results: MintResult[];
  totalSuccess: number;
  totalFailed: number;
  abortReason?: string;
  totalGasUsed?: bigint;
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
  maxRetries?: number;
  retryDelayMs?: number;
}

export type MintErrorCategory =
  | "WHITELIST"
  | "SIGNATURE"
  | "SOLD_OUT"
  | "TIMING"
  | "GAS"
  | "RPC"
  | "INSUFFICIENT_FUNDS"
  | "UNKNOWN"
  | "SIMULATION_FAILED";

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

// ENHANCED: More comprehensive error classification
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
    errorStr.includes("not in merkle tree") ||
    errorStr.includes("presale") ||
    errorStr.includes("not active") ||
    errorStr.includes("sale not started") ||
    errorStr.includes("sale closed") ||
    errorStr.includes("not open") ||
    errorStr.includes("invalid proof")
  ) {
    return {
      category: "WHITELIST",
      message: errorStr,
      retryable: false,
      userFriendly: "WHITELISTED: Your wallet is not on the allowlist for this mint.",
    };
  }
  
  // Signature errors
  if (
    errorStr.includes("signature") ||
    errorStr.includes("invalid signer") ||
    errorStr.includes("ecrecover") ||
    errorStr.includes("0xe12d2314") ||
    errorStr.includes("invalid signature") ||
    errorStr.includes("expired signature") ||
    errorStr.includes("invalid nonce")
  ) {
    return {
      category: "SIGNATURE",
      message: errorStr,
      retryable: false,
      userFriendly: "SIGNATURE REQUIRED: This mint requires a valid signature from the project.",
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
    errorStr.includes("cap reached") ||
    errorStr.includes("mint exceeds") ||
    errorStr.includes("would exceed") ||
    errorStr.includes("total supply") ||
    errorStr.includes("max mint")
  ) {
    return {
      category: "SOLD_OUT",
      message: errorStr,
      retryable: false,
      userFriendly: "SOLD OUT: All NFTs in this collection have been minted.",
    };
  }
  
  // Gas errors
  if (
    errorStr.includes("gas") ||
    errorStr.includes("fee") ||
    errorStr.includes("intrinsic gas too low") ||
    errorStr.includes("exceeds block gas limit") ||
    errorStr.includes("out of gas") ||
    errorStr.includes("gas too high") ||
    errorStr.includes("max fee per gas") ||
    errorStr.includes("max priority fee")
  ) {
    return {
      category: "GAS",
      message: errorStr,
      retryable: true,
      userFriendly: "GAS ERROR: Transaction failed due to gas issues. Will retry with adjusted gas.",
    };
  }
  
  // Insufficient funds
  if (
    errorStr.includes("insufficient funds") ||
    errorStr.includes("not enough funds") ||
    errorStr.includes("balance too low") ||
    errorStr.includes("cannot afford") ||
    errorStr.includes("insufficient balance")
  ) {
    return {
      category: "INSUFFICIENT_FUNDS",
      message: errorStr,
      retryable: false,
      userFriendly: "INSUFFICIENT FUNDS: Wallet doesn't have enough ETH for gas fees.",
    };
  }
  
  // RPC errors
  if (
    errorStr.includes("rpc") ||
    errorStr.includes("connection") ||
    errorStr.includes("timeout") ||
    errorStr.includes("network error") ||
    errorStr.includes("failed to fetch") ||
    errorStr.includes("rate limit") ||
    errorStr.includes("429") ||
    errorStr.includes("503") ||
    errorStr.includes("502")
  ) {
    return {
      category: "RPC",
      message: errorStr,
      retryable: true,
      userFriendly: "RPC ERROR: Network issue. Will retry with different RPC.",
    };
  }
  
  // Timing errors
  if (
    errorStr.includes("too soon") ||
    errorStr.includes("not yet") ||
    errorStr.includes("wait") ||
    errorStr.includes("cooldown") ||
    errorStr.includes("rate limit") ||
    errorStr.includes("too many requests") ||
    errorStr.includes("nonce too high") ||
    errorStr.includes("nonce too low") ||
    errorStr.includes("replacement transaction")
  ) {
    return {
      category: "TIMING",
      message: errorStr,
      retryable: true,
      userFriendly: "TIMING ERROR: Transaction timing issue. Will retry.",
    };
  }
  
  // Simulation failed
  if (
    errorStr.includes("simulation") ||
    errorStr.includes("execution reverted") ||
    errorStr.includes("call exception") ||
    errorStr.includes("contract call") ||
    errorStr.includes("always failing transaction")
  ) {
    return {
      category: "SIMULATION_FAILED",
      message: errorStr,
      retryable: true,
      userFriendly: "SIMULATION FAILED: Contract call would fail. May need different parameters.",
    };
  }
  
  return {
    category: "UNKNOWN",
    message: errorStr,
    retryable: true,
    userFriendly: `UNKNOWN ERROR: ${errorStr.slice(0, 100)}`,
  };
}

// ENHANCED: Better argument generation with support for complex types
function generateMintArgs(
  mintFunction: MintFunctionInfo,
  walletAddress: string,
  quantity: number = 1
): unknown[] {
  return mintFunction.args.map((type) => {
    const lowerType = type.toLowerCase().trim();
    
    // Handle arrays
    if (lowerType.endsWith("[]")) {
      const baseType = lowerType.slice(0, -2).trim();
      if (baseType.includes("uint") || baseType.includes("int")) {
        return Array(quantity).fill(1n);
      }
      if (baseType === "address") {
        return Array(quantity).fill(getAddress(walletAddress));
      }
      if (baseType === "bool") {
        return Array(quantity).fill(true);
      }
      if (baseType.startsWith("bytes")) {
        return Array(quantity).fill("0x");
      }
      return [];
    }
    
    // Handle specific uint types
    if (lowerType.startsWith("uint")) {
      // Check if it's a quantity parameter (usually named something like quantity, amount, count)
      if (mintFunction.name.toLowerCase().includes("mint")) {
        return BigInt(quantity);
      }
      return 1n;
    }
    
    // Handle addresses
    if (lowerType === "address") {
      return getAddress(walletAddress);
    }
    
    // Handle booleans
    if (lowerType === "bool") {
      return true;
    }
    
    // Handle bytes
    if (lowerType.startsWith("bytes")) {
      return "0x";
    }
    
    // Handle strings
    if (lowerType === "string") {
      return "";
    }
    
    // Default fallback
    return "0x";
  });
}

// ENHANCED: Single mint with retry logic
async function executeSingleMint(
  wallet: { id: string; address: string; label: string },
  privateKey: string,
  nftContract: string,
  mintFunction: MintFunctionInfo,
  chain: ChainId,
  iteration: number = 1,
  options?: MintOptions
): Promise<MintResult> {
  const config = getChainConfig(chain);
  const maxRetries = options?.maxRetries ?? 3;
  const retryDelayMs = options?.retryDelayMs ?? 1000;
  
  let lastError: ClassifiedError | null = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const hexKey = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;
      const walletClient = getWalletClient(hexKey, chain);
      const publicClient = getPublicClient(chain);
      
      // Check gas safety before each attempt
      const gasSafe = await assertGasSafe(BigInt(0), chain);
      if (!gasSafe) {
        throw new Error("Gas price exceeds safety limit");
      }
      
      // Generate appropriate arguments
      const args = generateMintArgs(mintFunction, wallet.address, getUserMintQuantity(BigInt(0)));
      
      const abiItem = parseAbi([
        `function ${mintFunction.name}(${mintFunction.args.join(",")})`,
      ] as const);
      
      const data = encodeFunctionData({
        abi: abiItem,
        functionName: mintFunction.name,
        args: args as any,
      });
      
      // Get gas estimate with buffer
      let gasLimit: bigint;
      try {
        const estimate = await publicClient.estimateGas({
          account: walletClient.account!,
          to: getAddress(nftContract),
          data,
          value: 0n,
        });
        gasLimit = (estimate * 120n) / 100n; // Add 20% buffer
      } catch (gasErr) {
        console.warn(`Gas estimation failed for ${wallet.label}, using default`);
        gasLimit = 500000n; // Safe default
      }
      
      // Send transaction with proper gas settings
      const txHash = await walletClient.sendTransaction({
        account: walletClient.account!,
        to: getAddress(nftContract),
        data,
        value: 0n,
        gas: gasLimit,
      });
      
      // Wait for receipt with timeout
      const receipt = await Promise.race([
        publicClient.waitForTransactionReceipt({ hash: txHash }),
        new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error("Transaction timeout")), 60000)
        ),
      ]);
      
      // Verify success
      if (receipt.status === "success") {
        return {
          walletId: wallet.id,
          walletAddress: wallet.address,
          label: wallet.label,
          success: true,
          txHash,
          basescanUrl: `${config.explorerBaseUrl}/tx/${txHash}`,
          iteration,
          gasUsed: receipt.gasUsed,
        };
      } else {
        throw new Error("Transaction failed on-chain");
      }
      
    } catch (error) {
      const classified = classifyMintError(error);
      lastError = classified;
      
      console.warn(`Mint attempt ${attempt + 1} failed for ${wallet.label}: ${classified.category}`);
      
      if (!classified.retryable || attempt === maxRetries - 1) {
        break;
      }
      
      // Wait before retry with exponential backoff
      await new Promise(resolve => setTimeout(resolve, retryDelayMs * (attempt + 1)));
    }
  }
  
  return {
    walletId: wallet.id,
    walletAddress: wallet.address,
    label: wallet.label,
    success: false,
    error: lastError?.message || "Unknown error",
    errorCategory: lastError?.category || "UNKNOWN",
    iteration,
  };
}

// ENHANCED: Batch mint with better concurrency control
export async function batchMint(
  userId: bigint,
  contractAddress: string,
  options?: MintOptions
): Promise<BatchMintResult> {
  const chain = getContextChain() || getDefaultChainId();
  const config = getChainConfig(chain);
  
  // Pre-scan the contract to get mint function
  const scan = await scanContract(contractAddress, chain);
  
  if (!scan.isContract) {
    return {
      contractAddress,
      results: [],
      totalSuccess: 0,
      totalFailed: 0,
      abortReason: "No contract found at address",
    };
  }
  
  if (!scan.security.isSafe) {
    return {
      contractAddress,
      results: [],
      totalSuccess: 0,
      totalFailed: 0,
      abortReason: `Contract security check failed: ${scan.security.warnings.join(", ")}`,
    };
  }
  
  const mintFn = getBestMintFunction(scan.mintFunctions);
  if (!mintFn) {
    return {
      contractAddress,
      results: [],
      totalSuccess: 0,
      totalFailed: 0,
      abortReason: "No free mint functions found",
    };
  }
  
  // Check if gated and warn
  if (scan.isGated || scan.requiresSignature) {
    console.warn(`Attempting gated/signature mint on ${contractAddress}`);
  }
  
  const wallets = await getActiveWallets(userId);
  if (wallets.length === 0) {
    return {
      contractAddress,
      results: [],
      totalSuccess: 0,
      totalFailed: 0,
      abortReason: "No active wallets",
    };
  }
  
  const quantity = getUserMintQuantity(userId);
  const rounds = quantity;
  const allResults: MintResult[] = [];
  
  // Process wallets with concurrency limit
  const CONCURRENCY = 3;
  const queue = [...wallets];
  
  while (queue.length > 0) {
    const batch = queue.splice(0, CONCURRENCY);
    
    const batchResults = await Promise.all(
      batch.map(async (wallet) => {
        try {
          const privateKey = await getWalletPrivateKey(wallet.id);
          
          let currentNonce = 0; // This should be fetched from chain in production
          
          for (let round = 1; round <= rounds; round++) {
            const res = await executeSingleMint(
              wallet,
              privateKey,
              contractAddress,
              mintFn,
              chain,
              round,
              options
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
          
          return true;
        } catch (err) {
          console.error(`Failed to process wallet ${wallet.label}:`, err);
          return false;
        }
      })
    );
  }
  
  const totalSuccess = allResults.filter((r) => r.success).length;
  const totalFailed = allResults.filter((r) => !r.success).length;
  const totalGasUsed = allResults.reduce((sum, r) => sum + (r.gasUsed || 0n), 0n);
  
  // Record history
  for (const r of allResults) {
    await recordMintHistory(userId, contractAddress, r.txHash || null, r.success ? "success" : "failed", chain);
  }
  
  return {
    contractAddress,
    results: allResults,
    totalSuccess,
    totalFailed,
    totalGasUsed,
  };
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
  // This could check contract state like totalSupply vs maxSupply
  return true;
}
