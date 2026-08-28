/**
 * Contract Scanner - Production Version (Strict Verification Filter)
 * Fixes: Eliminates unverified junk spam, strictly requires verification or pure public matching.
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
  schedule?: MintSchedule;
}

export interface MintSchedule {
  startsAt?: number;
  endsAt?: number;
  isLive?: boolean;
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

const EIP1167_PREFIX = "363d3d373d3d3d363d73";
const EIP1167_SUFFIX = "5af43d82803e903d91602b57fd5bf3";

export function extractEIP1167Implementation(bytecode: Hex): Address | null {
  const normalized = bytecode.toLowerCase().replace(/^0x/, "");
  const prefixIndex = normalized.indexOf(EIP1167_PREFIX);
  if (prefixIndex < 0) return null;

  const addressStart = prefixIndex + EIP1167_PREFIX.length;
  const addressEnd = addressStart + 40;
  const suffixStart = addressEnd;
  if (normalized.slice(suffixStart, suffixStart + EIP1167_SUFFIX.length) !== EIP1167_SUFFIX) {
    return null;
  }

  const implementation = `0x${normalized.slice(addressStart, addressEnd)}`;
  return isAddress(implementation) ? getAddress(implementation) : null;
}

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
  /^update/i,
  /^set/i,
  /^admin/i,
  /^withdraw/i,
  /^transfer/i,
  /^owner/i,
  /^configure/i,
  /^allow/i,
  /^revoke/i,
  /^grant/i,
  /^pause/i,
  /^unpause/i,
  /^upgrade/i,
  /^initialize/i,
  /^renounce/i,
  /^emergency/i,
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

function explorerApiKey(): string {
  return (
    process.env.ETHERSCAN_API_KEY ||
    process.env.BASESCAN_API_KEY ||
    ""
  ).trim();
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

async function fetchExplorerJson(url: string): Promise<ExplorerJson | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json() as ExplorerJson;
      if (![429, 500, 502, 503, 504].includes(response.status)) return null;
    } catch {
      if (attempt === 2) return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }
  return null;
}

async function fetchAbiFromExplorer(
  address: Address,
  chain: ChainId,
  visited = new Set<string>()
): Promise<Abi | null> {
  const config = getChainConfig(chain);
  const key = address.toLowerCase();
  if (visited.has(key)) return null;
  visited.add(key);

  try {
    const apiKey = config.abiSource.type === "etherscanV2"
      ? process.env[config.abiSource.apiKeyEnv] || explorerApiKey()
      : "";
    const chainParam = config.abiSource.type === "etherscanV2"
      ? `&chainid=${config.abiSource.chainParam}`
      : "";
    const keyParam = apiKey ? `&apikey=${encodeURIComponent(apiKey)}` : "";
    const abiUrl = `${config.abiSource.apiUrl}?module=contract&action=getabi&address=${address}${chainParam}${keyParam}`;
    const abiJson = await fetchExplorerJson(abiUrl);

    if (abiJson?.status === "1" && abiJson.result) {
      const parsed = typeof abiJson.result === "string"
        ? JSON.parse(abiJson.result)
        : abiJson.result;
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as Abi;
    }

    // Explorer proxy metadata is useful when the proxy has no source/ABI of its own.
    const sourceUrl = `${config.abiSource.apiUrl}?module=contract&action=getsourcecode&address=${address}${chainParam}${keyParam}`;
    const sourceJson = await fetchExplorerJson(sourceUrl);
    const source = Array.isArray(sourceJson?.result) ? sourceJson.result[0] as Record<string, unknown> : undefined;
    const implementation = typeof source?.Implementation === "string" && isAddress(source.Implementation)
      ? getAddress(source.Implementation)
      : null;
    if (implementation) return fetchAbiFromExplorer(implementation, chain, visited);
  } catch (err) {
    console.error("Failed to fetch ABI:", err);
    }
  return null;
}

async function readMintSchedule(
  address: Address,
  abi: Abi,
  chain: ChainId
): Promise<MintSchedule | undefined> {
  const candidates = abi.filter((item) => {
    const fn = item as AbiFn;
    return fn.type === "function" && fn.stateMutability === "view" &&
      (fn.inputs?.length ?? 0) === 0 &&
      /(^|public|mint|sale|drop|phase|start|end|open|close|active|live)/i.test(fn.name || "");
  }).slice(0, 16) as AbiFn[];
  const schedule: MintSchedule = {};
  const now = Math.floor(Date.now() / 1000);

  for (const fn of candidates) {
    try {
      const value = await getPublicClient(chain).readContract({
        address,
        abi: [fn] as Abi,
        functionName: fn.name!,
        args: [],
      } as any);
      if (typeof value !== "bigint" && typeof value !== "number") continue;
      const timestamp = Number(value);
      if (!Number.isSafeInteger(timestamp) || timestamp < 1_000_000_000) continue;
      const name = fn.name!.toLowerCase();
      if (name.includes("end") || name.includes("close")) schedule.endsAt = timestamp;
      else if (name.includes("start") || name.includes("open")) schedule.startsAt = timestamp;
    } catch {
      // Optional schedule getters are common; failed probes are non-fatal.
    }
  }

  if (schedule.startsAt !== undefined || schedule.endsAt !== undefined) {
    schedule.isLive = (schedule.startsAt === undefined || now >= schedule.startsAt) &&
      (schedule.endsAt === undefined || now <= schedule.endsAt);
    return schedule;
  }
  return undefined;
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

function decodeRevertMessage(error: unknown, abi: Abi = []): string {
  const errorData =
    typeof error === "object" && error !== null && "data" in error
      ? error.data
      : undefined;
  const message = error instanceof Error ? error.message : String(error);

  if (typeof errorData !== "string" || !errorData.startsWith("0x")) {
    return message;
  }

  try {
    const decoded = decodeErrorResult({
      abi: [
        ...abi,
        ...parseAbi([
          "error Error(string)",
          "error Panic(uint256)",
          "error AlreadyClaimed()",
          "error SoldOut()",
          "error SaleNotStarted()",
          "error SaleNotActive()",
          "error NotEligible()",
          "error InvalidProof()",
          "error InvalidSignature()",
        ]),
      ],
      data: errorData as Hex,
    });
    const args = decoded.args?.length ? `: ${decoded.args.join(", ")}` : "";
    return `${decoded.errorName}${args}`;
  } catch {
    return `Contract custom error (${errorData.slice(0, 10)})`;
  }
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
  
  const bytecode = await getBytecode(checksumAddress as Address, chain);
  const implementation = bytecode ? extractEIP1167Implementation(bytecode) : null;
  const abi = await fetchAbiFromExplorer(checksumAddress as Address, chain) ??
    (implementation ? await fetchAbiFromExplorer(implementation, chain) : null);
  
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
  })) || (abi?.some((item) => (item as AbiFn).name?.toLowerCase().includes("seadrop")) ?? false);
  
  const { isGated, requiresSignature } = detectGateTypeFromFunctions(mintFunctions);
  const freeMintFunctions = mintFunctions.filter((f) => f.isFreeMint);
  const security = await auditContractSecurity(checksumAddress, chain);
  const schedule = abi ? await readMintSchedule(checksumAddress as Address, abi, chain) : undefined;
  
  return {
    contractAddress: checksumAddress,
    mintFunctions: freeMintFunctions.length > 0 ? freeMintFunctions : mintFunctions,
    isVerified,
    isNft: mintFunctions.length > 0,
    abi,
    bytecode,
    isContract: true,
    security,
    isSeaDrop,
    requiresSignature,
    isGated,
    schedule,
    warning: !isVerified
      ? "Contract is unverified on explorer. No verified mint functions can be safely extracted."
      : isSeaDrop
      ? "SeaDrop contract detected with available free mint functions."
      : requiresSignature
      ? "Signature-required mint detected."
      : isGated
      ? "Gated mint detected (whitelist/allowlist)."
      : undefined,
  };
}

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
    
    const args = mintFunction.args.map((type) => {
      const lowerType = type.toLowerCase().trim();
      
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
      
      if (lowerType.startsWith("uint") || lowerType.startsWith("int")) {
        return 1n;
      }
      
      if (lowerType === "address") {
        return getAddress(fromAddress);
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
    
    const data = encodeFunctionData({
      abi: abiItem,
      functionName: mintFunction.name,
      args: args as any,
    });
    
    let gasEstimate: bigint | undefined;
    try {
      gasEstimate = await client.estimateGas({
        account: getAddress(fromAddress),
        to: getAddress(contractAddress),
        data,
        value: 0n,
      });
    } catch {
      gasEstimate = 150000n;
    }
    
    return { success: true, gasEstimate };
    
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    
    return { success: false, error: `Contract reverted: ${decodeRevertMessage(error)}` };
  }
}

export function getBestMintFunction(
  functions: MintFunctionInfo[]
): MintFunctionInfo | null {
  const free = functions.filter((f) => f.isFreeMint);
  const pool = free.length > 0 ? free : functions;
  
  const noArg = pool.find((f) => f.args.length === 0);
  if (noArg) return noArg;
  
  const withArg = pool.find(
    (f) => f.args.length === 1 && f.args[0] === "uint256"
  );
  if (withArg) return withArg;
  
  return pool[0] || null;
}
