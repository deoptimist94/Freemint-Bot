import {
  type Address,
  type Hex,
  type Abi,
  parseAbi,
  encodeFunctionData,
  getFunctionSelector,
  getAddress,
  isAddress,
} from "viem";
import { getPublicClient } from "./chain.js";
import { auditContractSecurity, type SecurityReport } from "./security.js";

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

// Names that look like mint but are checkers / admin / ERC-20 deposit
const MINT_NAME_BLOCKLIST = [
  /^can/,           // canMint, canClaim
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
  /^mintTo$/i,      // often admin
];

const ETHERSCAN_V2 = "https://api.etherscan.io/v2/api";
const BASE_CHAIN_ID = "8453";

function explorerApiKey(): string {
  return (process.env.ETHERSCAN_API_KEY || process.env.BASESCAN_API_KEY || "").trim();
}

function explorerBaseUrl(): string {
  const raw = (process.env.BASESCAN_API_URL || ETHERSCAN_V2).trim();
  if (/basescan\.org/i.test(raw) || (raw.endsWith("/api") && !raw.includes("/v2/"))) {
    return ETHERSCAN_V2;
  }
  return raw || ETHERSCAN_V2;
}

async function fetchJson(url: string, timeoutMs = 12_000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON explorer response (${res.status}): ${text.slice(0, 120)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAbiFromEtherscanV2(
  address: string
): Promise<{ abi: Abi | null; isVerified: boolean; error?: string }> {
  const apiKey = explorerApiKey();
  const baseUrl = explorerBaseUrl();
  const params = new URLSearchParams({
    chainid: BASE_CHAIN_ID,
    module: "contract",
    action: "getabi",
    address,
  });
  if (apiKey) params.set("apikey", apiKey);

  try {
    const data = await fetchJson(`${baseUrl}?${params.toString()}`);
    const result = data?.result;

    if (typeof result === "string" && /deprecated\s+v1/i.test(result)) {
      return {
        abi: null,
        isVerified: false,
        error: "Explorer still on deprecated Basescan V1",
      };
    }
    if (typeof result === "string" && /free api access is not supported/i.test(result)) {
      return {
        abi: null,
        isVerified: false,
        error: "Etherscan free tier does not cover Base — using Sourcify fallback",
      };
    }
    if (typeof result === "string" && /missing\/invalid api key/i.test(result)) {
      return {
        abi: null,
        isVerified: false,
        error: "Missing/invalid Etherscan API key",
      };
    }
    if (data?.status === "1" && typeof result === "string" && result.startsWith("[")) {
      return { abi: JSON.parse(result) as Abi, isVerified: true };
    }
    if (typeof result === "string" && /not verified|unverified/i.test(result)) {
      return { abi: null, isVerified: false };
    }
    return {
      abi: null,
      isVerified: false,
      error: typeof result === "string" ? result.slice(0, 160) : data?.message,
    };
  } catch (err) {
    return {
      abi: null,
      isVerified: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function fetchAbiFromSourcify(
  address: string
): Promise<{ abi: Abi | null; isVerified: boolean }> {
  const url = `https://sourcify.dev/server/v2/contract/${BASE_CHAIN_ID}/${address}?fields=abi`;
  try {
    const data = await fetchJson(url);
    if (Array.isArray(data?.abi) && data.abi.length > 0) {
      return { abi: data.abi as Abi, isVerified: true };
    }
    return { abi: null, isVerified: false };
  } catch {
    return { abi: null, isVerified: false };
  }
}

export async function fetchContractAbi(
  address: string
): Promise<{ abi: Abi | null; isVerified: boolean; error?: string }> {
  const primary = await fetchAbiFromEtherscanV2(address);
  if (primary.abi) return primary;

  const sourcify = await fetchAbiFromSourcify(address);
  if (sourcify.abi) return sourcify;

  return primary;
}

export async function getBytecode(address: Address): Promise<Hex | null> {
  const client = getPublicClient();
  try {
    const code = await client.getCode({ address });
    if (!code || code === "0x") return null;
    return code;
  } catch (err) {
    console.error("Error fetching bytecode from RPC:", err);
    return null;
  }
}

function abiHasFn(abi: Abi, names: string[]): boolean {
  const set = new Set(names.map((n) => n.toLowerCase()));
  return abi.some(
    (item: any) => item?.type === "function" && set.has(String(item.name || "").toLowerCase())
  );
}

/** Hard reject ERC-20 / ERC-4626 / lending mTokens / DEXes */
function looksLikeFungibleOrDefi(abi: Abi): boolean {
  const hasDecimals = abiHasFn(abi, ["decimals"]);
  const hasTotalSupply = abiHasFn(abi, ["totalSupply"]);
  const hasTransfer = abiHasFn(abi, ["transfer"]);
  const hasApprove = abiHasFn(abi, ["approve"]);
  const hasAllowance = abiHasFn(abi, ["allowance"]);
  const hasBalanceOf = abiHasFn(abi, ["balanceOf"]);
  const hasOwnerOf = abiHasFn(abi, ["ownerOf"]);
  const hasTokenUri = abiHasFn(abi, ["tokenURI", "uri"]);
  const hasSafeTransferFrom = abiHasFn(abi, ["safeTransferFrom"]);

  // Classic ERC-20 shape without NFT surface
  if (
    hasDecimals &&
    hasTotalSupply &&
    hasTransfer &&
    hasApprove &&
    hasBalanceOf &&
    !hasOwnerOf &&
    !hasTokenUri &&
    !hasSafeTransferFrom
  ) {
    return true;
  }

  // ERC-4626 / compound-style vaults (Moonwell mUSDC etc.)
  if (abiHasFn(abi, ["asset", "convertToShares", "convertToAssets", "previewDeposit", "previewMint"])) {
    return true;
  }
  if (abiHasFn(abi, ["exchangeRateCurrent", "accrueInterest", "borrowBalanceCurrent", "underlying"])) {
    return true;
  }

  // allowance without ownerOf is almost always fungible
  if (hasAllowance && hasDecimals && !hasOwnerOf && !hasTokenUri) {
    return true;
  }

  return false;
}

export async function verifyIsNftContract(address: Address, abi: Abi): Promise<boolean> {
  if (looksLikeFungibleOrDefi(abi)) return false;

  const hasNftFns = abi.some((item: any) => {
    if (item.type !== "function") return false;
    const name = (item.name?.toLowerCase() || "");
    return (
      name === "ownerof" ||
      name === "tokenuri" ||
      name === "uri" ||
      name === "safetransferfrom" ||
      name === "setapprovalforall"
    );
  });
  if (hasNftFns) return true;

  const client = getPublicClient();
  try {
    const supportsErc721 = await client
      .readContract({
        address,
        abi: parseAbi(["function supportsInterface(bytes4 interfaceId) view returns (bool)"]),
        functionName: "supportsInterface",
        args: ["0x80ac58cd"],
      })
      .catch(() => false);

    const supportsErc1155 = await client
      .readContract({
        address,
        abi: parseAbi(["function supportsInterface(bytes4 interfaceId) view returns (bool)"]),
        functionName: "supportsInterface",
        args: ["0xd9b67a26"],
      })
      .catch(() => false);

    if (supportsErc721 || supportsErc1155) return true;
  } catch {
    // ignore
  }
  return false;
}

function isExecutableMintName(name: string): boolean {
  if (!/mint|claim|collect/i.test(name)) return false;
  for (const re of MINT_NAME_BLOCKLIST) {
    if (re.test(name)) return false;
  }
  return true;
}

export function analyzeAbiForMintFunctions(abi: Abi): MintFunctionInfo[] {
  const functions: MintFunctionInfo[] = [];

  for (const item of abi) {
    if (item.type !== "function") continue;

    const fn = item as unknown as {
      name: string;
      inputs: Array<{ type: string; name: string }>;
      stateMutability?: string;
      payable?: boolean;
    };

    const mut = (fn.stateMutability || (fn.payable ? "payable" : "nonpayable")).toLowerCase();
    // Never treat view/pure checkers as mint targets
    if (mut === "view" || mut === "pure") continue;
    if (!isExecutableMintName(fn.name)) continue;

    const lower = fn.name.toLowerCase();
    const isPaid =
      mut === "payable" ||
      PAID_MINT_PATTERNS.some((p) => lower.includes(p));

    try {
      const selector = getFunctionSelector({
        name: fn.name,
        type: "function",
        inputs: fn.inputs.map((i) => ({ type: i.type, name: i.name || "" })),
        outputs: [],
        stateMutability: fn.stateMutability || "nonpayable",
      } as any);

      functions.push({
        name: fn.name,
        selector,
        args: fn.inputs.map((i) => i.type),
        isFreeMint: !isPaid,
        requiresPayment: isPaid,
        stateMutability: mut,
      });
    } catch {
      // skip
    }
  }

  return functions;
}

export async function scanContract(rawAddress: string): Promise<ScanResult> {
  const cleanInput = rawAddress.trim();
  const hexAddress = cleanInput.startsWith("0x") ? cleanInput : `0x${cleanInput}`;

  const emptySecurity = (warnings: string[], risk = 100): SecurityReport => ({
    isSafe: false,
    isHoneypot: false,
    isDrainer: false,
    riskScore: risk,
    warnings,
  });

  if (!isAddress(hexAddress)) {
    return {
      contractAddress: hexAddress,
      mintFunctions: [],
      isVerified: false,
      isNft: false,
      abi: null,
      bytecode: null,
      isContract: false,
      security: emptySecurity(["Invalid address format"]),
      warning: "Invalid Ethereum contract address format.",
    };
  }

  const checksumAddress = getAddress(hexAddress);
  const bytecode = await getBytecode(checksumAddress);
  const { abi, isVerified, error: abiError } = await fetchContractAbi(checksumAddress);

  if (!bytecode && !abi) {
    return {
      contractAddress: checksumAddress,
      mintFunctions: [],
      isVerified: false,
      isNft: false,
      abi: null,
      bytecode: null,
      isContract: false,
      security: emptySecurity(["No contract deployed"]),
      warning: "No contract found at this address on Base.",
    };
  }

  if (!isVerified || !abi) {
    return {
      contractAddress: checksumAddress,
      mintFunctions: [],
      isVerified: false,
      isNft: false,
      abi,
      bytecode,
      isContract: true,
      security: emptySecurity(
        [abiError ? `Explorer: ${abiError}` : "Unverified contract source"],
        abiError ? 40 : 50
      ),
      warning: abiError
        ? `Skipped: Could not load ABI (${abiError}).`
        : "Skipped: Contract source code is unverified.",
    };
  }

  if (looksLikeFungibleOrDefi(abi)) {
    return {
      contractAddress: checksumAddress,
      mintFunctions: [],
      isVerified,
      isNft: false,
      abi,
      bytecode,
      isContract: true,
      security: {
        isSafe: true,
        isHoneypot: false,
        isDrainer: false,
        riskScore: 5,
        warnings: ["Fungible token / DeFi contract (not NFT)"],
      },
      warning: "Skipped: ERC-20 / lending / vault token — not an NFT free mint.",
    };
  }

  const isNft = await verifyIsNftContract(checksumAddress, abi);
  if (!isNft) {
    return {
      contractAddress: checksumAddress,
      mintFunctions: [],
      isVerified,
      isNft: false,
      abi,
      bytecode,
      isContract: true,
      security: {
        isSafe: true,
        isHoneypot: false,
        isDrainer: false,
        riskScore: 10,
        warnings: ["Not an NFT contract"],
      },
      warning: "Skipped: Contract is not an ERC-721/1155 NFT collection.",
    };
  }

  const security = await auditContractSecurity(checksumAddress);
  if (!security.isSafe) {
    return {
      contractAddress: checksumAddress,
      mintFunctions: [],
      isVerified,
      isNft: true,
      abi,
      bytecode,
      isContract: true,
      security,
      warning: `🚨 UNSAFE CONTRACT: ${security.warnings.join(", ")}`,
    };
  }

  const mintFunctions = analyzeAbiForMintFunctions(abi);
  const freeMintFunctions = mintFunctions.filter((f) => f.isFreeMint && !f.requiresPayment);

  if (freeMintFunctions.length === 0) {
    return {
      contractAddress: checksumAddress,
      mintFunctions: mintFunctions.filter((f) => f.requiresPayment),
      isVerified,
      isNft: true,
      abi,
      bytecode,
      isContract: true,
      security,
      warning:
        mintFunctions.length > 0
          ? "Verified NFT found, but mint requires payment (not free)."
          : "Skipped: No valid free-mint function detected.",
    };
  }

  return {
    contractAddress: checksumAddress,
    mintFunctions: freeMintFunctions,
    isVerified,
    isNft: true,
    abi,
    bytecode,
    isContract: true,
    security,
    warning: undefined,
  };
}

export async function simulateMint(
  contractAddress: string,
  fromAddress: string,
  mintFunction: MintFunctionInfo
): Promise<{ success: boolean; error?: string }> {
  const client = getPublicClient();
  try {
    const abiItem = parseAbi([
      `function ${mintFunction.name}(${mintFunction.args.join(",")})`,
    ] as const);
    const args = mintFunction.args.map((type) => {
      if (type.startsWith("uint") || type.startsWith("int")) return 1n;
      if (type === "address") return getAddress(fromAddress);
      if (type === "bool") return true;
      if (type.endsWith("[]")) return [];
      if (type.startsWith("bytes")) return "0x";
      return "0x";
    });
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

export function getBestMintFunction(
  functions: MintFunctionInfo[]
): MintFunctionInfo | null {
  const free = functions.filter((f) => f.isFreeMint && !f.requiresPayment);
  const pool = free.length > 0 ? free : functions;
  const noArg = pool.find((f) => f.args.length === 0);
  if (noArg) return noArg;
  const withArg = pool.find((f) => f.args.length === 1 && f.args[0] === "uint256");
  if (withArg) return withArg;
  return pool[0] || null;
}
