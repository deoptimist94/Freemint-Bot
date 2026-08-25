/**
 * Contract Scanner - Production Version
 * Fixes: View function filtering, SeaDrop detection, Security auditing, Better simulation
 */

import {
  type Address,
  type Hex,
  type Abi,
  parseAbi,
  encodeFunctionData,
  getFunctionSelector,
  getAddress,
  isAddress,
  decodeErrorResult,
} from "viem";
import { getPublicClient } from "./chain.js";
import { auditContractSecurity, type SecurityReport } from "./security.js";
import {
  getChainConfig,
  getDefaultChainId,
  type ChainId,
} from "./chains.js";

export interface MintFunctionInfo {
  name: string;
  selector: string;
  args: string[];
  isFreeMint: boolean;
  requiresPayment: boolean;
  stateMutability: string;
}

export interface ScanResult {
  contractAddress: string;
  mintFunctions: MintFunctionInfo[];
  isVerified: boolean;
  isNft: boolean;
  abi: Abi | null;
  bytecode: Hex | null;
  isContract: boolean;
  security: SecurityReport;
  warning?: string;
  isSeaDrop?: boolean;
  requiresSignature?: boolean;
  isGated?: boolean;
}

type AbiInput = { type: string; name?: string };
type AbiFn = {
  type?: string;
  name?: string;
  inputs?: AbiInput[];
  stateMutability?: string;
  payable?: boolean;
};

type ExplorerJson = {
  status?: string;
  message?: string;
  result?: unknown;
};

const PAID_MINT_PATTERNS = [
  "mintwitheth",
  "paidmint",
  "mintwithpayment",
  "mintwithprice",
  "purchase",
  "buynft",
  "buy",
];

const MINT_NAME_BLOCKLIST = [
  /^can/,
  /allowance/,
  /preview/,
  /estimate/,
  /calculate/,
  /getmint/,
  /mintprice/,
  /mintlimit/,
  /minted/,
  /maxmint/,
  /totalmint/,
  /hasminted/,
  /isminted/,
  /devmint/,
  /ownermint/,
  /adminmint/,
  /teamMint/i,
  /^mintTo$/i,
  /^mintSeaDrop$/i,
  /getseadrop/i,
  /getmint/i,
  /mintmode/i,
  /mintstats/i,
  /signedmint/i,
  /updatemint/i,
];

const SIGNATURE_INDICATORS = [
  "signedmint",
  "signaturemint",
  "mintwithsignature",
  "verifysignature",
  "updatesignedmint",
  "signature",
];

const GATED_INDICATORS = [
  "whitelist",
  "allowlist",
  "merkle",
  "proof",
  "presale",
  "onlywhitelisted",
];

const ETHERSCAN_V2 = "https://api.etherscan.io/v2/api";
const BASE_CHAIN_ID = "8453";

function explorerApiKey(): string {
  return (
    process.env.ETHERSCAN_API_KEY ||
    process.env.BASESCAN_API_KEY ||
    ""
  ).trim();
}

function explorerBaseUrl(): string {
  const raw = (process.env.BASESCAN_API_URL || ETHERSCAN_V2).trim();
  if (/basescan\.org/i.test(raw) || raw.endsWith("/")) {
    return raw.replace(/\/+$/, "");
  }
  return raw || ETHERSCAN_V2;
}

async function getBytecode(
  address: Address,
  chain: ChainId
): Promise<Hex | null> {
  try {
    const code = await getPublicClient(chain).getBytecode({ address });
    if (!code || code === "0x") return null;
    return code as Hex;
  } catch {
    return null;
  }
}

async function fetchAbiFromExplorer(
  address: Address,
  chain: ChainId
): Promise<Abi | null> {
  const config = getChainConfig(chain);
  
  try {
    if (config.abiSource.type === "etherscanV2") {
      const apiKey = process.env[config.abiSource.apiKeyEnv] || explorerApiKey();
      const url = `${config.explorerApiUrl}?module=contract&action=getabi&address=${address}&apikey=${apiKey}`;
      
      const res = await fetch(url);
      const json: ExplorerJson = await res.json();
      
      if (json.status === "1" && json.result) {
        return JSON.parse(json.result as string) as Abi;
      }
    } else if (config.abiSource.type === "blockscout") {
      const url = `${config.abiSource.apiUrl}?module=contract&action=getabi&address=${address}`;
      const res = await fetch(url);
      const json: ExplorerJson = await res.json();
      
      if (json.status === "1" && json.result) {
        return JSON.parse(json.result as string) as Abi;
      }
    }
  } catch (err) {
    console.error("Failed to fetch ABI:", err);
  }
  
  return null;
}

function isViewOrPure(fn: AbiFn): boolean {
  return (
    fn.stateMutability === "view" ||
    fn.stateMutability === "pure" ||
    (!fn.stateMutability && !fn.payable)
  );
}

function isBlockedName(name: string): boolean {
  const lower = name.toLowerCase();
  return MINT_NAME_BLOCKLIST.some((pattern) =>
    pattern instanceof RegExp ? pattern.test(lower) : lower.includes(pattern)
  );
}

function looksLikeMint(fn: AbiFn): boolean {
  if (!fn.name || fn.name.length < 3) return false;
  const lower = fn.name.toLowerCase();
  
  if (isBlockedName(fn.name)) return false;
  
  return (
    lower.includes("mint") ||
    lower.includes("claim") ||
    lower.includes("drop") ||
    lower.includes("airdrop")
  );
}

function isProbablyPaidMint(fn: AbiFn): boolean {
  if (!fn.name) return false;
  const lower = fn.name.toLowerCase();
  return PAID_MINT_PATTERNS.some((p) => lower.includes(p));
}

function isPayable(fn: AbiFn): boolean {
  return fn.payable === true || fn.stateMutability === "payable";
}

function isSeaDropMint(fn: AbiFn): boolean {
  if (!fn.name) return false;
  const lower = fn.name.toLowerCase();
  return (
    lower.includes("seadrop") ||
    lower.includes("seadropmint") ||
    (lower.includes("mint") && lower.includes("sea"))
  );
}

function hasSignatureArg(fn: AbiFn): boolean {
  if (!fn.inputs) return false;
  return fn.inputs.some((input) => {
    const type = input.type?.toLowerCase() || "";
    return type === "bytes" || type.startsWith("bytes");
  });
}

function detectGateTypeFromFunctions(functions: MintFunctionInfo[]): { isGated: boolean; requiresSignature: boolean } {
  let isGated = false;
  let requiresSignature = false;
  
  for (const fn of functions) {
    const lower = fn.name.toLowerCase();
    
    if (SIGNATURE_INDICATORS.some(ind => lower.includes(ind))) {
      requiresSignature = true;
    }
    
    if (GATED_INDICATORS.some(ind => lower.includes(ind))) {
      isGated = true;
    }
    
    if (fn.args.some(arg => {
      const lowerArg = arg.toLowerCase();
      return lowerArg.includes("bytes") || lowerArg.includes("proof") || lowerArg.includes("merkle");
    })) {
      requiresSignature = true;
    }
  }
  
  return { isGated, requiresSignature };
}

export function analyzeAbiForMintFunctions(abi: Abi): MintFunctionInfo[] {
  const functions: MintFunctionInfo[] = [];
  
  for (const item of abi) {
    const fn = item as AbiFn;
    if (fn.type !== "function") continue;
    if (!fn.name) continue;
    if (isViewOrPure(fn)) continue;
    if (!looksLikeMint(fn)) continue;
    
    const args = (fn.inputs || []).map((i) => i.type);
    const selector = getFunctionSelector(`${fn.name}(${args.join(",")})`);
    
    const isProbablyPaid = isProbablyPaidMint(fn);
    const payable = isPayable(fn);
    const isFreeMint = !isProbablyPaid && !payable;
    
    functions.push({
      name: fn.name,
      selector,
      args,
      isFreeMint,
      requiresPayment: payable || isProbablyPaid,
      stateMutability: fn.stateMutability || "nonpayable",
    });
  }
  
  return functions.sort((a, b) => {
    if (a.isFreeMint && !b.isFreeMint) return -1;
    if (!a.isFreeMint && b.isFreeMint) return 1;
    return a.args.length - b.args.length;
  });
}

export async function scanContract(
  address: string,
  chain: ChainId = getDefaultChainId()
): Promise<ScanResult> {
  const checksumAddress = isAddress(address) ? getAddress(address) : address;
  const config = getChainConfig(chain);
  
  const [bytecode, abi] = await Promise.all([
    getBytecode(checksumAddress as Address, chain),
    fetchAbiFromExplorer(checksumAddress as Address, chain),
  ]);
  
  if (!bytecode) {
    return {
      contractAddress: checksumAddress,
      mintFunctions: [],
      isVerified: false,
      isNft: false,
      abi: null,
      bytecode: null,
      isContract: false,
      security: {
        isSafe: false,
        isHoneypot: false,
        isDrainer: false,
        riskScore: 100,
        warnings: ["No contract bytecode found at this address"],
      },
    };
  }
  
  const isVerified = abi !== null;
  let mintFunctions: MintFunctionInfo[] = [];
  
  if (abi) {
    mintFunctions = analyzeAbiForMintFunctions(abi);
  }
  
  const isSeaDrop = mintFunctions.some((f) => isSeaDropMint({ 
    name: f.name, 
    stateMutability: f.stateMutability,
    payable: f.stateMutability === "payable"
  }));
  
  const { isGated, requiresSignature } = detectGateTypeFromFunctions(mintFunctions);
  
  const freeMintFunctions = mintFunctions.filter((f) => f.isFreeMint);
  
  const security = await auditContractSecurity(checksumAddress, chain);
  
  return {
    contractAddress: checksumAddress,
    mintFunctions: freeMintFunctions,
    isVerified,
    isNft: mintFunctions.length > 0,
    abi,
    bytecode,
    isContract: true,
    security,
    isSeaDrop,
    requiresSignature,
    isGated,
    warning: isSeaDrop
      ? "SeaDrop contract detected. Free mint functions available (non-SeaDrop)."
      : requiresSignature
      ? "Signature-required mint detected. Bot may not be able to mint without valid signature."
      : isGated
      ? "Gated mint detected (whitelist/allowlist). Bot may fail if wallets not on list."
      : undefined,
  };
}

// ENHANCED: Better simulation with dynamic argument generation
export async function simulateMint(
  contractAddress: string,
  fromAddress: string,
  mintFunction: MintFunctionInfo,
  chain: ChainId = getDefaultChainId()
): Promise<{ success: boolean; error?: string; gasEstimate?: bigint }> {
  const client = getPublicClient(chain);
  
  try {
    const abiItem = parseAbi([
      `function ${mintFunction.name}(${mintFunction.args.join(",")})`,
    ] as const);
    
    // ENHANCED: Smarter argument generation based on type
    const args = mintFunction.args.map((type) => {
      const lowerType = type.toLowerCase().trim();
      
      // Handle arrays
      if (lowerType.endsWith("[]")) {
        const baseType = lowerType.slice(0, -2);
        if (baseType.includes("uint") || baseType.includes("int")) {
          return [1n];
        }
        if (baseType === "address") {
          return [getAddress(fromAddress)];
        }
        if (baseType === "bool") {
          return [true];
        }
        return [];
      }
      
      // Handle integers
      if (lowerType.startsWith("uint") || lowerType.startsWith("int")) {
        const bits = parseInt(lowerType.replace(/[^0-9]/g, "")) || 256;
        const maxVal = bits >= 256 ? 100n : BigInt(Math.min(100, (2 ** Math.min(bits, 53)) - 1));
        return maxVal;
      }
      
      // Handle addresses
      if (lowerType === "address") {
        return getAddress(fromAddress);
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
      
      // Default
      return "0x";
    });
    
    const data = encodeFunctionData({
      abi: abiItem,
      functionName: mintFunction.name,
      args: args as any,
    });
    
    // Try to estimate gas first
    let gasEstimate: bigint | undefined;
    try {
      gasEstimate = await client.estimateGas({
        account: getAddress(fromAddress),
        to: getAddress(contractAddress),
        data,
        value: 0n,
      });
    } catch (gasErr) {
      // Gas estimation failed, but we'll still try the call
    }
    
    // Perform the actual call
    await client.call({
      data,
      to: getAddress(contractAddress),
      account: getAddress(fromAddress),
      value: 0n,
    });
    
    return { success: true, gasEstimate };
    
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    
    // Try to decode the error
    try {
      const errorData = (error as any)?.data;
      if (errorData && typeof errorData === "string" && errorData.startsWith("0x")) {
        const decoded = decodeErrorResult({
          abi: parseAbi(["error Error(string)", "error Panic(uint256)"]),
          data: errorData as Hex,
        });
        return { 
          success: false, 
          error: `Contract reverted: ${decoded.args?.[0] || message}` 
        };
      }
    } catch {
      // Could not decode error, use original message
    }
    
    return { success: false, error: message };
  }
}

export function getBestMintFunction(
  functions: MintFunctionInfo[]
): MintFunctionInfo | null {
  const free = functions.filter((f) => f.isFreeMint && !f.requiresPayment);
  const pool = free.length > 0 ? free : functions;
  
  const noArg = pool.find((f) => f.args.length === 0);
  if (noArg) return noArg;
  
  const withArg = pool.find(
    (f) => f.args.length === 1 && f.args[0] === "uint256"
  );
  if (withArg) return withArg;
  
  const withTwoArgs = pool.find(
    (f) => f.args.length === 2 && f.args[0] === "address" && f.args[1] === "uint256"
  );
  if (withTwoArgs) return withTwoArgs;
  
  return pool[0] || null;
}
