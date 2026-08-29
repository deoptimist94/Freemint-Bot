/**
 * Mint Engine - Production Version
 * Features: Error classification, RPC failover, SeaDrop support, History tracking, Enhanced gas handling
 */

import {
  type Address,
  type Hex,
  decodeErrorResult,
  parseAbi,
  encodeFunctionData,
  getAddress,
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
  | "PAYMENT"
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
const SEADROP_ROUTER = "0x00005ea00ac477b1030ce78506496e8c2de24bf5" as Address;
const SEADROP_ABI = parseAbi([
  "function mintPublic(address nftContract, address feeRecipient, address minter, uint256 quantity) payable",
] as const);
const SEADROP_NFT_ABI = parseAbi([
  "function getFeesAndRecipient() view returns (uint256 fee, address feeRecipient)",
] as const);

export function getUserMintQuantity(userId: bigint): number {
  return userMintQuantities.get(userId) ?? 1;
}

export function setUserMintQuantity(userId: bigint, quantity: number): void {
  userMintQuantities.set(userId, Math.max(1, Math.min(quantity, 10)));
}

const CUSTOM_ERROR_DICTIONARY: Record<string, string> = {
  MintEnded: "Mint has ended.",
  MaxSupplyReached: "Max supply has been reached.",
  WalletLimitExceeded: "This wallet has reached its mint limit.",
  ApprovalQueryForNonexistentToken: "Approval was requested for a nonexistent token.",
  InvalidProof: "The allowlist proof is invalid.",
  SaleNotActive: "Mint is not active at this time.",
  SaleNotStarted: "The mint has not started yet.",
  SoldOut: "The collection is sold out.",
  AlreadyClaimed: "This wallet has already claimed a token.",
  OnlySeaDrop: "This mint must be routed through SeaDrop.",
  NotEligible: "This wallet is not eligible for the mint.",
  InsufficientPayment: "The required payment was not provided.",
  NotAuthorized: "The caller is not authorized for this mint.",
};

export function classifyMintError(error: unknown): ClassifiedError {
  const decodedCustom = decodeContractRevert(error);
  const errorString = decodedCustom ?? (error instanceof Error ? error.message : String(error));
  const errorStr = errorString.toLowerCase();

  const mappedCustom = Object.entries(CUSTOM_ERROR_DICTIONARY).find(([name]) =>
    errorString.includes(name) || errorStr.includes(name.toLowerCase())
  );
  if (mappedCustom) {
    const [name, description] = mappedCustom;
    const category = name === "MaxSupplyReached" || name === "SoldOut" || name === "MintEnded"
      ? "SOLD_OUT"
      : name === "InvalidProof" || name === "NotEligible"
        ? "WHITELIST"
        : name === "WalletLimitExceeded"
          ? "SOLD_OUT"
          : name === "OnlySeaDrop"
            ? "SIGNATURE"
            : "SIMULATION_FAILED";
    return {
      category,
      message: errorString,
      retryable: false,
      userFriendly: description,
    };
  }
  
  if (
    errorStr.includes("alreadyclaimed") ||
    errorStr.includes("soldout") ||
    errorStr.includes("mintended") ||
    errorStr.includes("mintnotactive") ||
    errorStr.includes("mint has ended") ||
    errorStr.includes("mint is not active") ||
    errorStr.includes("maximum mint per wallet exceeded") ||
    errorStr.includes("salenotactive")
  ) {
    return {
      category: "SOLD_OUT",
      message: errorString,
      retryable: false,
      userFriendly: "Mint is unavailable or sold out.",
    };
  }

  if (errorStr.includes("mintnotstarted") || errorStr.includes("mint has not started") || errorStr.includes("sale not started")) {
    return {
      category: "TIMING",
      message: errorStr,
      retryable: false,
      userFriendly: "MINT NOT STARTED: The public mint phase has not opened yet.",
    };
  }

  if (errorStr.includes("insufficientpayment") || errorStr.includes("insufficient payment")) {
    return {
      category: "PAYMENT",
      message: errorStr,
      retryable: false,
      userFriendly: "INSUFFICIENT PAYMENT: The required mint fee was not provided.",
    };
  }

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
  
  if (
    errorStr.includes("simulation") ||
    errorStr.includes("execution reverted") ||
    errorStr.includes("call exception") ||
    errorStr.includes("contract call") ||
    errorStr.includes("always failing transaction")
  ) {
    const decoded = decodeContractRevert(error);
    return {
      category: "SIMULATION_FAILED",
      message: decoded || errorStr,
      retryable: true,
      userFriendly: decoded || "Mint simulation failed. The contract rejected the call before execution.",
    };
  }
  
  return {
    category: "UNKNOWN",
    message: errorStr,
    retryable: true,
    userFriendly: `UNKNOWN ERROR: ${errorStr.slice(0, 100)}`,
  };
}

function decodeContractRevert(error: unknown): string | null {
  const data =
    typeof error === "object" && error !== null && "data" in error
      ? error.data
      : undefined;

  if (typeof data !== "string" || !data.startsWith("0x")) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("execution reverted") && message.includes("0x")) {
      const hex = message.match(/0x[0-9a-fA-F]+/);
      if (hex) return `The contract rejected the transaction (${hex[0].slice(0, 10)}).`;
    }
    return null;
  }

  try {
    const decoded = decodeErrorResult({
      abi: parseAbi([
        "error Error(string)",
        "error Panic(uint256)",
        "error AlreadyClaimed()",
        "error SoldOut()",
        "error SaleNotStarted()",
        "error SaleNotActive()",
        "error NotEligible()",
        "error InvalidProof()",
        "error InvalidSignature()",
        "error MintEnded()",
        "error MintNotActive()",
        "error MaxMintPerWalletExceeded()",
        "error MaxSupplyReached()",
        "error WalletLimitExceeded()",
        "error ApprovalQueryForNonexistentToken()",
        "error InsufficientPayment()",
        "error NotAuthorized()",
        "error OnlySeaDrop()",
        "error MintNotStarted()",
        "error Paused()",
        "error Unauthorized()",
      ]),
      data: data as Hex,
    });
    const labels: Record<string, string> = {
      MintEnded: "Mint has ended",
      MintNotActive: "Mint is not active",
      MaxMintPerWalletExceeded: "Maximum mint per wallet exceeded",
      MaxSupplyReached: "Max supply has been reached",
      WalletLimitExceeded: "This wallet has reached its mint limit",
      ApprovalQueryForNonexistentToken: "Approval was requested for a nonexistent token",
      InsufficientPayment: "Insufficient payment",
      NotAuthorized: "Wallet is not authorized",
      OnlySeaDrop: "This mint must be routed through SeaDrop",
      MintNotStarted: "Mint has not started",
      Paused: "The contract is paused",
      Unauthorized: "Wallet is not authorized",
      InvalidProof: "The allowlist proof is invalid",
      SoldOut: "The collection is sold out",
      Error: "The contract rejected the transaction",
      Panic: "The contract hit a generic panic",
    };
    const label = labels[decoded.errorName] ?? decoded.errorName ?? "The contract rejected the transaction";
    const args = decoded.args && decoded.args.length > 0 ? `: ${decoded.args.join(", ")}` : "";
    return `${label}${args}`;
  } catch {
    return `The contract rejected the transaction (custom error ${data.slice(0, 10)}). Check the mint phase, wallet eligibility, and required payment.`;
  }
}

interface GasStrategy {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

async function getOptimalGas(chain: ChainId): Promise<GasStrategy> {
  const publicClient = getPublicClient(chain);
  
  try {
    const block = await publicClient.getBlock({ blockTag: 'latest' });
    const baseFee = block.baseFeePerGas || 1000000000n;
    
    const priorityFee = await publicClient.estimateMaxPriorityFeePerGas().catch(() => 1500000000n);
    
    const maxPriorityFee = (priorityFee * 150n) / 100n;
    const maxFee = baseFee * 2n + maxPriorityFee;
    
    return {
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: maxPriorityFee,
    };
  } catch (err) {
    console.warn('Failed to get optimal gas, using defaults:', err);
    return {
      maxFeePerGas: 50000000000n,
      maxPriorityFeePerGas: 1500000000n,
    };
  }
}

function generateMintArgs(
  mintFunction: MintFunctionInfo,
  walletAddress: string,
  quantity: number = 1
): unknown[] {
  return mintFunction.args.map((type) => {
    const lowerType = type.toLowerCase().trim();
    
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
    
    if (lowerType.startsWith("uint")) {
      if (mintFunction.name.toLowerCase().includes("mint")) {
        return BigInt(quantity);
      }
      return 1n;
    }
    
    if (lowerType === "address") {
      return getAddress(walletAddress);
    }
    
    if (lowerType === "bool") {
      return true;
    }
    
    if (lowerType.startsWith("bytes")) {
      return "0x";
    }
    
    if (lowerType === "string") {
      return "";
    }
    
    return "0x";
  });
}

async function executeSingleMint(
  wallet: { id: string; address: string; label: string },
  privateKey: string,
  nftContract: string,
  mintFunction: MintFunctionInfo,
  chain: ChainId,
  iteration: number = 1,
  options?: MintOptions,
  quantity = 1
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
      
      try {
        await assertGasSafe(BigInt(0));
      } catch (gasError) {
        throw new Error("Gas price exceeds safety limit");
      }
      
      let target = getAddress(nftContract);
      let value = 0n;
      let data: Hex;

      if (options?.seaDropContext?.isViaRouter) {
        const feeResult = await publicClient.readContract({
          address: getAddress(nftContract),
          abi: SEADROP_NFT_ABI,
          functionName: "getFeesAndRecipient",
        });
        const [fee, feeRecipient] = feeResult as readonly [bigint, Address];
        target = SEADROP_ROUTER;
        value = fee * BigInt(quantity);
        data = encodeFunctionData({
          abi: SEADROP_ABI,
          functionName: "mintPublic",
          args: [getAddress(nftContract), feeRecipient, getAddress(wallet.address), BigInt(quantity)],
        });
      } else {
        const args = generateMintArgs(mintFunction, wallet.address, quantity);
        const abiItem = parseAbi([
          `function ${mintFunction.name}(${mintFunction.args.join(",")})`,
        ] as const);
        data = encodeFunctionData({
          abi: abiItem,
          functionName: mintFunction.name,
          args: args as any,
        });
      }
      
      // PRE-FLIGHT SIMULATION
      try {
        await publicClient.call({
          data,
          to: target,
          account: getAddress(wallet.address),
          value,
        });
        console.log(`✅ Pre-flight simulation passed for ${wallet.label}`);
      } catch (simError: unknown) {
        const decodedError = decodeContractRevert(simError);
        const classified = classifyMintError(decodedError || simError);
        console.warn(`❌ Pre-flight failed for ${wallet.label}: ${classified.category}`);
        
        if (!classified.retryable) {
          return {
            walletId: wallet.id,
            walletAddress: wallet.address,
            label: wallet.label,
            success: false,
            error: classified.userFriendly,
            errorCategory: classified.category,
            iteration,
          };
        }
        throw simError;
      }
      
      // Get optimal gas pricing
      const gasStrategy = await getOptimalGas(chain);
      
      // Estimate gas with buffer
      let gasLimit: bigint;
      try {
        const estimate = await publicClient.estimateGas({
          account: walletClient.account!,
          to: target,
          data,
          value,
        });
        gasLimit = (estimate * 130n) / 100n;
      } catch (gasErr) {
        console.warn(`Gas estimation failed for ${wallet.label}, using default`);
        gasLimit = 500000n;
      }
      
      // Send transaction with aggressive gas
      const txHash = await walletClient.sendTransaction({
        account: walletClient.account!,
        to: target,
        data,
        value,
        gas: gasLimit,
        maxFeePerGas: gasStrategy.maxFeePerGas,
        maxPriorityFeePerGas: gasStrategy.maxPriorityFeePerGas,
        chain: config.viemChain,
      });
      
      console.log(`🚀 Transaction sent: ${txHash} for ${wallet.label}`);
      
      // Wait for receipt with timeout
      const receipt = await Promise.race([
        publicClient.waitForTransactionReceipt({ 
          hash: txHash,
          timeout: 60000,
          pollingInterval: 1000,
        }),
        new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error("Transaction timeout")), 60000)
        ),
      ]);
      
      if (receipt.status === "success") {
        console.log(`✅ Mint confirmed for ${wallet.label}: ${txHash}`);
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
      
      console.warn(`Mint attempt ${attempt + 1} failed for ${wallet.label}: ${classified.category} - ${classified.message.slice(0, 100)}`);
      
      if (!classified.retryable || attempt === maxRetries - 1) {
        break;
      }
      
      await new Promise(resolve => setTimeout(resolve, retryDelayMs * Math.pow(2, attempt)));
    }
  }
  
  return {
    walletId: wallet.id,
    walletAddress: wallet.address,
    label: wallet.label,
    success: false,
    error: lastError?.userFriendly || "Unknown error",
    errorCategory: lastError?.category || "UNKNOWN",
    iteration,
  };
}

export async function batchMint(
  userId: bigint,
  contractAddress: string,
  options?: MintOptions
): Promise<BatchMintResult> {
  const chain = getContextChain() || getDefaultChainId();
  const config = getChainConfig(chain);
  
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

  if (scan.rejectionReason) {
    return {
      contractAddress,
      results: [],
      totalSuccess: 0,
      totalFailed: 0,
      abortReason: scan.rejectionReason,
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
  
  const quantity = options?.seaDropContext?.quantity ?? getUserMintQuantity(userId);
  const rounds = 1;
  const allResults: MintResult[] = [];
  
  const CONCURRENCY = 3;
  const queue = [...wallets];
  
  while (queue.length > 0) {
    const batch = queue.splice(0, CONCURRENCY);
    
    await Promise.all(
      batch.map(async (wallet) => {
        try {
          const privateKey = await getWalletPrivateKey(wallet.id);
          
          for (let round = 1; round <= rounds; round++) {
            const res = await executeSingleMint(
              wallet,
              privateKey,
              contractAddress,
              mintFn,
              chain,
              round,
              options,
              quantity
            );
            
            allResults.push(res);
            
            if (res.success) {
              // Success, continue to next round
            } else {
              const classified = classifyMintError(res.error || "");
              if (!classified.retryable) break;
            }
            
            if (round < rounds) {
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
          }
        } catch (err) {
          console.error(`Failed to process wallet ${wallet.label}:`, err);
        }
      })
    );
  }
  
  const totalSuccess = allResults.filter((r) => r.success).length;
  const totalFailed = allResults.filter((r) => !r.success).length;
  const totalGasUsed = allResults.reduce((sum, r) => sum + (r.gasUsed || 0n), 0n);
  
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
  return true;
}
