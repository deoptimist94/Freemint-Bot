import {
  type Hex,
  type Address,
  type Abi,
  encodeFunctionData,
  parseAbi,
  decodeErrorResult,
  getAddress,
} from "viem";
import {
  getPublicClient,
  getAddressFromPrivateKey,
  getWalletClient,
  normalizeAddressInput,
} from "./chain.js";
import { checkGasSafety } from "./gasGuard.js";
import { getWallets, getWalletPrivateKey, type WalletInfo } from "./wallet.js";
import {
  scanContract,
  getBestMintFunction,
  analyzeAbiForMintFunctions,
  type MintFunctionInfo,
  type ScanResult,
} from "./scanner.js";
import { prisma } from "../db/client.js";

export type GateType =
  | "mint_open"
  | "whitelist"
  | "signature"
  | "payment"
  | "paused"
  | "timed"
  | "none"
  | "unknown";

export interface BypassResult {
  success: boolean;
  contractAddress: string;
  gateType: GateType;
  strategyId: string;
  walletAddress?: string;
  txHash?: string;
  dryRun?: boolean;
  probeOnly?: boolean;
  error?: string;
  state?: string;
  probe?: ProbeRow[];
  publicMintAt?: { atMs: number; label: string } | null;
}

export interface BypassPlan {
  executable: boolean;
  gateType: GateType;
  targetFn: MintFunctionInfo | null;
  reason?: string;
}

export interface BypassOptions {
  dryRun?: boolean;
  probeOnly?: boolean;
  maxSpendEth?: number;
  merkleProof?: string[];
  signature?: Hex;
}

export interface ProbeRow {
  name: string;
  value: string | number | boolean | null;
}

export interface ProbeRowCall {
  fn: MintFunctionInfo;
  args: unknown[];
  data: Hex;
}

const REVERT_ABI = parseAbi([
  "error Error(string)",
  "error Panic(uint256)",
] as const);

const MAX_WALLET_ATTEMPTS = 5;
const RECEIPT_TIMEOUT_MS = 60_000;
const PROBE_NAME_RE =
  /^(public|whitelist|allowlist|presale|sale|mint|free|phase|start|end|open|active|live|paused|supply|max|price|total)/i;

const MAX_PROBE_READS = 24;

const PUBLIC_START_KEYS = [
  "publicSaleStartTime",
  "saleStartTime",
  "publicMintStartTime",
  "mintStartTime",
  "presaleEndTime",
  "whitelistEndTime",
  "allowlistEndTime",
  "publicSaleTime",
  "startTime",
];

// ENHANCED: Better gate detection with more patterns
export function detectGateType(mintFunctions: MintFunctionInfo[]): GateType {
  if (!mintFunctions || mintFunctions.length === 0) return "none";
  
  const freeFns = mintFunctions.filter((f) => f.isFreeMint);
  if (freeFns.length === 0) return "payment";
  
  const joined = mintFunctions
    .map((f) => `${f.name}(${f.args.join(",")})`)
    .join(" ");
  
  // Check for whitelist indicators
  if (/whitelist|allowlist|presale|og\b|early|merkle/i.test(joined)) return "whitelist";
  
  // Check for signature requirements
  const hasSigArg = mintFunctions.some(
    (f) =>
      f.args.some((a) => a.trim().toLowerCase().startsWith("bytes")) ||
      /signature|merkle/i.test(f.name)
  );
  if (hasSigArg) return "signature";
  
  // Check for time-based gates
  if (/start.*time|end.*time|phase|stage|timestamp/i.test(joined)) return "timed";
  
  // Check for pause functionality
  if (/paused|pause|frozen|unpause/i.test(joined)) return "paused";
  
  return "mint_open";
}

export function analyzeGates(result: ScanResult): {
  gateType: GateType;
  freeFns: MintFunctionInfo[];
  reason?: string;
} {
  return {
    gateType: detectGateType(result.mintFunctions),
    freeFns: result.mintFunctions.filter((f) => f.isFreeMint),
    reason: result.warning,
  };
}

export function getBypassPlan(result: ScanResult): BypassPlan {
  const { gateType, freeFns, reason } = analyzeGates(result);
  
  if (gateType !== "mint_open" || freeFns.length === 0) {
    return {
      executable: false,
      gateType,
      targetFn: null,
      reason:
        reason ??
        `Gate type "${gateType}" is not directly bypassable with current strategies`,
    };
  }
  
  return {
    executable: true,
    gateType,
    targetFn: getBestMintFunction(freeFns),
  };
}

export function classifyRevertReason(reason: string): GateType | undefined {
  const lower = reason.toLowerCase();
  
  if (lower.includes("whitelist") || lower.includes("allowlist") || lower.includes("merkle") || lower.includes("not on list")) {
    return "whitelist";
  }
  if (lower.includes("signature") || lower.includes("ecrecover") || lower.includes("invalid signer")) {
    return "signature";
  }
  if (lower.includes("paused") || lower.includes("frozen") || lower.includes("contract is paused")) {
    return "paused";
  }
  if (lower.includes("sale not started") || lower.includes("too early") || lower.includes("not open") || lower.includes("before start")) {
    return "timed";
  }
  if (lower.includes("payment") || lower.includes("insufficient funds") || lower.includes("price") || lower.includes("send ether")) {
    return "payment";
  }
  if (lower.includes("sold out") || lower.includes("max supply") || lower.includes("exceeds")) {
    return "none"; // Not a gate, just sold out
  }
  
  return undefined;
}

// ENHANCED: Try to find public mint path even in gated contracts
function publicPathFunctions(result: ScanResult): MintFunctionInfo[] {
  if (!result.abi) return [];
  
  const allFns = analyzeAbiForMintFunctions(result.abi);
  
  // Look for functions that might be public mints
  return allFns.filter(fn => {
    const lower = fn.name.toLowerCase();
    return (
      lower.includes("public") ||
      lower.includes("open") ||
      lower.includes("free") ||
      (lower.includes("mint") && 
       !lower.includes("whitelist") && 
       !lower.includes("allowlist") && 
       !lower.includes("presale") &&
       !lower.includes("signature") &&
       !lower.includes("admin") &&
       !lower.includes("owner") &&
       !lower.includes("dev"))
    );
  });
}

// ENHANCED: Generate different argument variations for testing
function generateArgVariations(fn: MintFunctionInfo, walletAddress: string): unknown[][] {
  const variations: unknown[][] = [];
  
  // Try with zero/default values
  const defaultArgs = fn.args.map(type => {
    const lower = type.toLowerCase().trim();
    if (lower.includes("uint") || lower.includes("int")) return 0n;
    if (lower === "address") return "0x0000000000000000000000000000000000000000";
    if (lower === "bool") return false;
    if (lower.startsWith("bytes")) return "0x";
    if (lower === "string") return "";
    return "0x";
  });
  variations.push(defaultArgs);
  
  // Try with quantity 1
  const oneArgs = fn.args.map(type => {
    const lower = type.toLowerCase().trim();
    if (lower.includes("uint") || lower.includes("int")) return 1n;
    if (lower === "address") return getAddress(walletAddress);
    if (lower === "bool") return true;
    if (lower.startsWith("bytes")) return "0x01";
    if (lower === "string") return "1";
    return "0x";
  });
  variations.push(oneArgs);
  
  // Try with quantity 2 (for multiple mints)
  const twoArgs = fn.args.map(type => {
    const lower = type.toLowerCase().trim();
    if (lower.includes("uint") || lower.includes("int")) return 2n;
    if (lower === "address") return getAddress(walletAddress);
    if (lower === "bool") return true;
    if (lower.startsWith("bytes")) return "0x02";
    if (lower === "string") return "2";
    return "0x";
  });
  variations.push(twoArgs);
  
  // If merkle proof is expected, try empty proof
  if (fn.args.some(a => {
    const lower = a.toLowerCase();
    return lower.includes("bytes") && fn.name.toLowerCase().includes("merkle");
  })) {
    const proofArgs = fn.args.map(type => {
      const lower = type.toLowerCase().trim();
      if (lower.includes("bytes") && lower.includes("[]")) return [];
      if (lower.includes("uint") || lower.includes("int")) return 1n;
      if (lower === "address") return getAddress(walletAddress);
      if (lower === "bool") return true;
      return "0x";
    });
    variations.push(proofArgs);
  }
  
  return variations;
}

// ENHANCED: Try matrix of different parameter combinations
async function tryMatrix(
  userId: bigint,
  address: string,
  result: ScanResult,
  client: any,
  attempts: string[],
  options: BypassOptions,
  base: any,
  functions: MintFunctionInfo[],
  strategy: string
): Promise<BypassResult | null> {
  
  for (const fn of functions) {
    const argVariations = generateArgVariations(fn, attempts[0]);
    
    for (const args of argVariations) {
      try {
        const data = encodeFunctionData({
          abi: parseAbi([`function ${fn.name}(${fn.args.join(",")})`] as const),
          functionName: fn.name,
          args: args as any,
        });
        
        await client.call({
          data,
          to: getAddress(address),
          from: getAddress(attempts[0]),
          value: 0n,
        });
        
        // If simulation succeeds, try actual mint
        if (!options.dryRun && !options.probeOnly) {
          for (const walletAddr of attempts.slice(0, MAX_WALLET_ATTEMPTS)) {
            const wallets = await getWallets(userId);
            const wallet = wallets.find(w => w.address.toLowerCase() === walletAddr.toLowerCase());
            
            if (wallet) {
              try {
                const privateKey = await getWalletPrivateKey(wallet.id);
                const walletClient = getWalletClient(privateKey as Hex);
                
                // Get gas estimate
                const gasEstimate = await client.estimateGas({
                  account: walletClient.account!,
                  to: getAddress(address),
                  data,
                  value: 0n,
                }).catch(() => 300000n);
                
                const txHash = await walletClient.sendTransaction({
                  account: walletClient.account!,
                  to: getAddress(address),
                  data,
                  value: 0n,
                  gas: (gasEstimate * 120n) / 100n, // 20% buffer
                });
                
                // Wait for receipt
                const receipt = await Promise.race([
                  client.waitForTransactionReceipt({ hash: txHash }),
                  new Promise<never>((_, reject) => 
                    setTimeout(() => reject(new Error("Transaction timeout")), RECEIPT_TIMEOUT_MS)
                  ),
                ]);
                
                if (receipt.status === "success") {
                  await logBypass(userId, address, `${strategy}_${fn.name}`, wallet.address, true, txHash);
                  
                  return {
                    ...base,
                    success: true,
                    walletAddress: wallet.address,
                    txHash,
                    strategyId: `${strategy}_${fn.name}`,
                  };
                }
              } catch (txErr) {
                console.warn(`Transaction failed for ${wallet.address}:`, txErr);
                continue;
              }
            }
          }
        }
        
        return {
          ...base,
          success: true,
          dryRun: options.dryRun,
          strategyId: `${strategy}_${fn.name}`,
        };
        
      } catch (err) {
        const errorStr = String(err).toLowerCase();
        
        // If it's a whitelist/signature error, don't try more variations
        if (errorStr.includes("whitelist") || 
            errorStr.includes("allowlist") || 
            errorStr.includes("signature") ||
            errorStr.includes("merkle")) {
          break;
        }
        
        // Continue to next variation
        continue;
      }
    }
  }
  
  return null;
}

// ENHANCED: Try direct mint with multiple wallets
async function tryDirectMint(
  userId: bigint,
  address: string,
  result: ScanResult,
  plan: BypassPlan,
  client: any,
  attempts: string[],
  options: BypassOptions,
  base: any
): Promise<BypassResult | null> {
  if (!plan.targetFn) return null;
  
  const fn = plan.targetFn;
  
  for (const from of attempts.slice(0, MAX_WALLET_ATTEMPTS)) {
    const argVariations = generateArgVariations(fn, from);
    
    for (const args of argVariations) {
      try {
        const data = encodeFunctionData({
          abi: parseAbi([`function ${fn.name}(${fn.args.join(",")})`] as const),
          functionName: fn.name,
          args: args as any,
        });
        
        await client.call({
          data,
          to: getAddress(address),
          from: getAddress(from),
          value: 0n,
        });
        
        if (!options.dryRun && !options.probeOnly) {
          const wallets = await getWallets(userId);
          const wallet = wallets.find(w => w.address.toLowerCase() === from.toLowerCase());
          
          if (wallet) {
            try {
              const privateKey = await getWalletPrivateKey(wallet.id);
              const walletClient = getWalletClient(privateKey as Hex);
              
              const gasEstimate = await client.estimateGas({
                account: walletClient.account!,
                to: getAddress(address),
                data,
                value: 0n,
              }).catch(() => 300000n);
              
              const txHash = await walletClient.sendTransaction({
                account: walletClient.account!,
                to: getAddress(address),
                data,
                value: 0n,
                gas: (gasEstimate * 120n) / 100n,
              });
              
              const receipt = await Promise.race([
                client.waitForTransactionReceipt({ hash: txHash }),
                new Promise<never>((_, reject) => 
                  setTimeout(() => reject(new Error("Transaction timeout")), RECEIPT_TIMEOUT_MS)
                ),
              ]);
              
              if (receipt.status === "success") {
                await logBypass(userId, address, "direct_mint", from, true, txHash);
                
                return {
                  ...base,
                  success: true,
                  walletAddress: from,
                  txHash,
                  strategyId: "direct_mint",
                };
              }
            } catch (txErr) {
              console.warn(`Direct mint transaction failed for ${from}:`, txErr);
              
              // Classify error
              const errorStr = String(txErr).toLowerCase();
              if (errorStr.includes("whitelist") || errorStr.includes("allowlist")) {
                break; // Try next wallet
              }
              if (errorStr.includes("signature")) {
                break;
              }
              continue;
            }
          }
        }
        
        return {
          ...base,
          success: true,
          dryRun: options.dryRun,
          walletAddress: from,
          strategyId: "direct_mint",
        };
        
      } catch (err) {
        const errorStr = String(err).toLowerCase();
        
        if (errorStr.includes("whitelist") || errorStr.includes("allowlist")) {
          break;
        }
        if (errorStr.includes("signature")) {
          break;
        }
        
        console.warn(`Direct mint simulation failed for ${from}:`, err);
      }
    }
  }
  
  return null;
}

// ENHANCED: Try signature-based mint
async function trySignatureMint(
  userId: bigint,
  address: string,
  result: ScanResult,
  signature: Hex,
  client: any,
  attempts: string[],
  options: BypassOptions,
  base: any
): Promise<BypassResult | null> {
  // Find signature mint functions
  const sigFns = result.mintFunctions.filter(f => 
    f.name.toLowerCase().includes("signature") ||
    f.args.some(a => a.toLowerCase().includes("bytes"))
  );
  
  // Also check all functions in ABI
  if (result.abi) {
    const allFns = analyzeAbiForMintFunctions(result.abi);
    const additionalSigFns = allFns.filter(f => 
      !sigFns.find(sf => sf.name === f.name) &&
      (f.name.toLowerCase().includes("signature") ||
       f.args.some(a => a.toLowerCase().includes("bytes")))
    );
    sigFns.push(...additionalSigFns);
  }
  
  for (const fn of sigFns) {
    for (const from of attempts.slice(0, MAX_WALLET_ATTEMPTS)) {
      try {
        // Generate base args
        const baseArgs = generateArgVariations(fn, from)[1]; // Use the "one" variation
        
        // Inject signature into bytes arguments
        const finalArgs = baseArgs.map((arg, idx) => {
          const argType = fn.args[idx]?.toLowerCase() || "";
          
          // If this is a bytes argument and we have a signature, use it
          if (argType.includes("bytes") && signature) {
            if (argType.includes("[]")) {
              // Array of bytes - signature might need to be wrapped
              return [signature];
            }
            return signature;
          }
          
          return arg;
        });
        
        const data = encodeFunctionData({
          abi: parseAbi([`function ${fn.name}(${fn.args.join(",")})`] as const),
          functionName: fn.name,
          args: finalArgs as any,
        });
        
        await client.call({
          data,
          to: getAddress(address),
          from: getAddress(from),
          value: 0n,
        });
        
        if (!options.dryRun && !options.probeOnly) {
          const wallets = await getWallets(userId);
          const wallet = wallets.find(w => w.address.toLowerCase() === from.toLowerCase());
          
          if (wallet) {
            try {
              const privateKey = await getWalletPrivateKey(wallet.id);
              const walletClient = getWalletClient(privateKey as Hex);
              
              const gasEstimate = await client.estimateGas({
                account: walletClient.account!,
                to: getAddress(address),
                data,
                value: 0n,
              }).catch(() => 300000n);
              
              const txHash = await walletClient.sendTransaction({
                account: walletClient.account!,
                to: getAddress(address),
                data,
                value: 0n,
                gas: (gasEstimate * 120n) / 100n,
              });
              
              const receipt = await Promise.race([
                client.waitForTransactionReceipt({ hash: txHash }),
                new Promise<never>((_, reject) => 
                  setTimeout(() => reject(new Error("Transaction timeout")), RECEIPT_TIMEOUT_MS)
                ),
              ]);
              
              if (receipt.status === "success") {
                await logBypass(userId, address, "signature_mint", from, true, txHash);
                
                return {
                  ...base,
                  success: true,
                  walletAddress: from,
                  txHash,
                  strategyId: "signature_mint",
                };
              }
            } catch (txErr) {
              console.warn(`Signature mint transaction failed for ${from}:`, txErr);
              continue;
            }
          }
        }
        
        return {
          ...base,
          success: true,
          dryRun: options.dryRun,
          walletAddress: from,
          strategyId: "signature_mint",
        };
        
      } catch (err) {
        console.warn(`Signature mint simulation failed for ${from}:`, err);
      }
    }
  }
  
  return null;
}

// ENHANCED: Try merkle proof mint
async function tryMerkleMint(
  userId: bigint,
  address: string,
  result: ScanResult,
  merkleProof: string[],
  client: any,
  attempts: string[],
  options: BypassOptions,
  base: any
): Promise<BypassResult | null> {
  // Find merkle/whitelist functions
  const merkleFns = result.mintFunctions.filter(f => 
    f.name.toLowerCase().includes("merkle") ||
    f.name.toLowerCase().includes("whitelist") ||
    f.name.toLowerCase().includes("allowlist") ||
    f.args.some(a => a.toLowerCase().includes("proof"))
  );
  
  // Also check all functions in ABI
  if (result.abi) {
    const allFns = analyzeAbiForMintFunctions(result.abi);
    const additionalFns = allFns.filter(f => 
      !merkleFns.find(mf => mf.name === f.name) &&
      (f.name.toLowerCase().includes("merkle") ||
       f.name.toLowerCase().includes("whitelist") ||
       f.name.toLowerCase().includes("allowlist") ||
       f.args.some(a => a.toLowerCase().includes("proof")))
    );
    merkleFns.push(...additionalFns);
  }
  
  for (const fn of merkleFns) {
    for (const from of attempts.slice(0, MAX_WALLET_ATTEMPTS)) {
      try {
        // Generate base args
        const baseArgs = generateArgVariations(fn, from)[1];
        
        // Inject merkle proof
        const finalArgs = baseArgs.map((arg, idx) => {
          const argType = fn.args[idx]?.toLowerCase() || "";
          
          if (argType.includes("bytes") && argType.includes("[]") && merkleProof.length > 0) {
            return merkleProof;
          }
          
          return arg;
        });
        
        const data = encodeFunctionData({
          abi: parseAbi([`function ${fn.name}(${fn.args.join(",")})`] as const),
          functionName: fn.name,
          args: finalArgs as any,
        });
        
        await client.call({
          data,
          to: getAddress(address),
          from: getAddress(from),
          value: 0n,
        });
        
        if (!options.dryRun && !options.probeOnly) {
          const wallets = await getWallets(userId);
          const wallet = wallets.find(w => w.address.toLowerCase() === from.toLowerCase());
          
          if (wallet) {
            try {
              const privateKey = await getWalletPrivateKey(wallet.id);
              const walletClient = getWalletClient(privateKey as Hex);
              
              const gasEstimate = await client.estimateGas({
                account: walletClient.account!,
                to: getAddress(address),
                data,
                value: 0n,
              }).catch(() => 300000n);
              
              const txHash = await walletClient.sendTransaction({
                account: walletClient.account!,
                to: getAddress(address),
                data,
                value: 0n,
                gas: (gasEstimate * 120n) / 100n,
              });
              
              const receipt = await Promise.race([
                client.waitForTransactionReceipt({ hash: txHash }),
                new Promise<never>((_, reject) => 
                  setTimeout(() => reject(new Error("Transaction timeout")), RECEIPT_TIMEOUT_MS)
                ),
              ]);
              
              if (receipt.status === "success") {
                await logBypass(userId, address, "merkle_mint", from, true, txHash);
                
                return {
                  ...base,
                  success: true,
                  walletAddress: from,
                  txHash,
                  strategyId: "merkle_mint",
                };
              }
            } catch (txErr) {
              console.warn(`Merkle mint transaction failed for ${from}:`, txErr);
              continue;
            }
          }
        }
        
        return {
          ...base,
          success: true,
          dryRun: options.dryRun,
          walletAddress: from,
          strategyId: "merkle_mint",
        };
        
      } catch (err) {
        console.warn(`Merkle mint simulation failed for ${from}:`, err);
      }
    }
  }
  
  return null;
}

// ENHANCED: Probe contract for public sale timing
async function probePublicSaleTiming(
  address: string,
  abi: Abi | null,
  client: any
): Promise<{ atMs: number; label: string } | null> {
  if (!abi) return null;
  
  const probeFns = abi.filter((item: any) => 
    item.type === "function" &&
    PUBLIC_START_KEYS.some(key => item.name?.toLowerCase().includes(key.toLowerCase()))
  );
  
  for (const fn of probeFns.slice(0, MAX_PROBE_READS)) {
    try {
      const data = encodeFunctionData({
        abi: parseAbi([`function ${fn.name}()`] as const),
        functionName: fn.name,
        args: [],
      });
      
      const result = await client.call({
        data,
        to: getAddress(address),
      });
      
      if (result.data) {
        const decoded = BigInt(result.data);
        const timestamp = Number(decoded) * 1000; // Convert to milliseconds
        
        if (timestamp > Date.now()) {
          return {
            atMs: timestamp,
            label: fn.name,
          };
        }
      }
    } catch {
      // Continue probing
    }
  }
  
  return null;
}

// ENHANCED: Build comprehensive probe results
async function buildProbeResults(
  address: string,
  result: ScanResult,
  client: any
): Promise<ProbeRow[]> {
  const rows: ProbeRow[] = [];
  
  // Add gate analysis
  const { gateType, freeFns } = analyzeGates(result);
  rows.push({ name: "Detected Gate", value: gateType });
  rows.push({ name: "Free Functions", value: freeFns.length });
  
  // Add mint functions
  for (const fn of result.mintFunctions.slice(0, 10)) {
    rows.push({
      name: `Function: ${fn.name}`,
      value: `${fn.args.join(", ")} | Free: ${fn.isFreeMint}`,
    });
  }
  
  // Try to probe public sale timing
  const publicTiming = await probePublicSaleTiming(address, result.abi, client);
  if (publicTiming) {
    rows.push({
      name: "Public Sale Opens",
      value: new Date(publicTiming.atMs).toISOString(),
    });
  }
  
  return rows;
}

// ENHANCED: Main bypass execution with all strategies
export async function executeBypass(
  userId: bigint,
  address: string,
  options: BypassOptions = {}
): Promise<BypassResult> {
  const normalizedAddr = normalizeAddressInput(address);
  if (!normalizedAddr) {
    return {
      success: false,
      contractAddress: address,
      gateType: "unknown",
      strategyId: "invalid_address",
      error: "Invalid contract address",
    };
  }
  
  const chain = getContextChain() || "base";
  const client = getPublicClient(chain);
  
  // Scan contract first
  const result = await scanContract(normalizedAddr, chain);
  const plan = getBypassPlan(result);
  
  const base: BypassResult = {
    success: false,
    contractAddress: normalizedAddr,
    gateType: plan.gateType,
    strategyId: "analysis",
  };
  
  // Get wallets to attempt from
  const wallets = await getWallets(userId).catch(() => [] as WalletInfo[]);
  const attempts = wallets.map(w => w.address);
  
  if (attempts.length === 0) {
    attempts.push("0x0000000000000000000000000000000000000001");
  }
  
  // Build probe results if requested
  if (options.probeOnly) {
    const probe = await buildProbeResults(normalizedAddr, result, client);
    return {
      ...base,
      probe,
      probeOnly: true,
    };
  }
  
  // Strategy 1: Direct free mint (if available)
  if (plan.executable && plan.targetFn) {
    const direct = await tryDirectMint(
      userId,
      normalizedAddr,
      result,
      plan,
      client,
      attempts,
      options,
      base
    );
    if (direct) return direct;
  }
  
  // Strategy 2: Try public mint path even in gated contracts
  if (plan.gateType === "whitelist" || plan.gateType === "timed" || plan.gateType === "paused") {
    const pubFns = publicPathFunctions(result);
    if (pubFns.length > 0) {
      const pub = await tryMatrix(
        userId,
        normalizedAddr,
        result,
        client,
        attempts,
        options,
        base,
        pubFns,
        "public_path"
      );
      if (pub) return pub;
    }
  }
  
  // Strategy 3: Try all mint functions with different parameters
  if (plan.gateType !== "payment" && plan.gateType !== "paused") {
    const allFns = result.abi ? analyzeAbiForMintFunctions(result.abi) : [];
    if (allFns.length > 0) {
      const matrix = await tryMatrix(
        userId,
        normalizedAddr,
        result,
        client,
        attempts,
        options,
        base,
        allFns,
        "probe_matrix"
      );
      if (matrix) return matrix;
    }
  }
  
  // Strategy 4: For signature-required, check if we have a signature
  if (plan.gateType === "signature" && options.signature) {
    const sigResult = await trySignatureMint(
      userId,
      normalizedAddr,
      result,
      options.signature,
      client,
      attempts,
      options,
      base
    );
    if (sigResult) return sigResult;
  }
  
  // Strategy 5: For merkle/whitelist, try with proof if provided
  if ((plan.gateType === "whitelist" || plan.gateType === "signature") && options.merkleProof && options.merkleProof.length > 0) {
    const merkleResult = await tryMerkleMint(
      userId,
      normalizedAddr,
      result,
      options.merkleProof,
      client,
      attempts,
      options,
      base
    );
    if (merkleResult) return merkleResult;
  }
  
  // Strategy 6: Check for public sale timing
  const publicTiming = await probePublicSaleTiming(normalizedAddr, result.abi, client);
  
  // All strategies failed
  const error = buildFinalError(plan.gateType, plan.reason);
  
  await logBypass(userId, normalizedAddr, base.strategyId, "", false, undefined, error);
  
  return {
    ...base,
    error,
    publicMintAt: publicTiming,
  };
}

function buildFinalError(gateType: GateType, reason?: string): string {
  if (reason) return reason;
  
  switch (gateType) {
    case "whitelist":
      return "Contract requires whitelist/allowlist. No bypass available without merkle proof. Try providing proof via --merkleProof option.";
    case "signature":
      return "Contract requires valid signature. Provide signature via --signature option or wait for public mint.";
    case "payment":
      return "Contract requires payment. Use manual mint with payment options.";
    case "paused":
      return "Contract is paused. Wait for unpause.";
    case "timed":
      return "Contract has time-based restrictions. Wait for public mint window or check --probeOnly for timing.";
    default:
      return "Unable to bypass gate. Contract may require special access.";
  }
}

async function logBypass(
  userId: bigint,
  contractAddress: string,
  strategyId: string,
  walletAddress: string,
  success: boolean,
  txHash?: string,
  error?: string
): Promise<void> {
  try {
    await prisma.bypassLog.create({
      data: {
        userId,
        contractAddress,
        strategyId,
        walletAddress,
        success,
        txHash,
        error,
      },
    });
  } catch (err) {
    console.error("Failed to log bypass attempt:", err);
  }
}
