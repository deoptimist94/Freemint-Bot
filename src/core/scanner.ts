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
  return raw;
}

async function getBytecode(address: Address, chain: ChainId): Promise<Hex | null> {
  try {
    return await getPublicClient(chain).getBytecode({ address });
  } catch {
    return null;
  }
}

async function fetchContractAbi(
  address: Address,
  chain: ChainId
): Promise<{ abi: Abi | null; isVerified: boolean; error?: string }> {
  if (chain !== "base") {
    return fetchAbiFromBlockscout(address, chain);
  }
  // Base — unchanged Etherscan V2 path (honors BASESCAN_API_URL override)
  const baseUrl = explorerBaseUrl();
  const isV2 = baseUrl === ETHERSCAN_V2;
  const url = isV2
    ? `${baseUrl}?chainid=${BASE_CHAIN_ID}&module=contract&action=getabi&address=${address}&apikey=${explorerApiKey()}`
    : `${baseUrl}?module=contract&action=getabi&address=${address}&apikey=${explorerApiKey()}`;
  return fetchAbiJson(url);
}

async function fetchAbiFromBlockscout(
  address: Address,
  chain: ChainId
): Promise<{ abi: Abi | null; isVerified: boolean; error?: string }> {
  const config = getChainConfig(chain);
  const src = config.abiSource;
  if (src.type !== "blockscout") {
    return { abi: null, isVerified: false, error: `No ABI source configured for ${config.name}` };
  }
  const url = `${src.apiUrl}?module=contract&action=getabi&address=${address}`;
  return fetchAbiJson(url);
}

async function fetchAbiJson(
  url: string
): Promise<{ abi: Abi | null; isVerified: boolean; error?: string }> {
  try {
    const res = await fetch(url);
    const json = await res.json();
    const raw = json?.result;
    if (
      (json?.status === "1" || json?.message === "OK") &&
      typeof raw === "string" &&
      raw.trim().startsWith("[")
    ) {
      try {
        return { abi: JSON.parse(raw) as Abi, isVerified: true };
      } catch {
        return { abi: null, isVerified: false, error: "Explorer returned malformed ABI" };
      }
    }
    const reason = typeof raw === "string" ? raw : (json?.message ?? "unverified");
    return { abi: null, isVerified: false, error: reason };
  } catch (err) {
    return {
      abi: null,
      isVerified: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function verifyIsNftContract(address: Address, abi: Abi, chain: ChainId): Promise<boolean> {
  const client = getPublicClient(chain);
  const erc165 = parseAbi([
    "function supportsInterface(bytes4 interfaceId) view returns (bool)",
  ] as const);
  for (const interfaceId of ["0x80ac58cd", "0xd9b67a26"] as const) {
    try {
      const ok = await client.readContract({
        address,
        abi: erc165,
        functionName: "supportsInterface",
        args: [interfaceId as Hex],
      });
      if (ok === true) return true;
    } catch {
      // contract may not implement ERC-165 — fall through to ABI heuristic
    }
  }
  const fnNames = new Set(
    (abi as any[]).filter((i) => i.type === "function").map((i) => String(i.name ?? "").toLowerCase())
  );
  return fnNames.has("ownerof") && (fnNames.has("tokenuri") || fnNames.has("uri"));
}

// ERC-20 / DeFi contracts should be skipped even if they expose a mint-like function.
function looksLikeFungibleOrDefi(abi: Abi): boolean {
  const fnNames = new Set(
    (abi as any[]).filter((i) => i.type === "function").map((i) => String(i.name ?? "").toLowerCase())
  );
  const erc20Markers = ["transfer", "transferfrom", "approve", "balanceof", "allowance", "totalsupply", "decimals"];
  const hasErc20 = erc20Markers.some((n) => fnNames.has(n));
  const hasNft = fnNames.has("ownerof") && (fnNames.has("tokenuri") || fnNames.has("uri"));
  const defiMarkers = ["deposit", "withdraw", "lend", "borrow", "stake", "swap", "redeem", "farm", "supply"];
  const hasDefi = [...fnNames].some((n) => defiMarkers.some((d) => n.includes(d)));
  return (hasErc20 || hasDefi) && !hasNft;
}

export function analyzeAbiForMintFunctions(abi: Abi): MintFunctionInfo[] {
  const functions: MintFunctionInfo[] = [];
  const items = (abi as any[]).filter((i) => i.type === "function");
  for (const fn of items) {
    const name = String(fn.name ?? "");
    const lower = name.toLowerCase();
    if (MINT_NAME_BLOCKLIST.some((re) => re.test(name))) continue;
    if (!/(mint|claim|buy|purchase|airdrop|sale)/i.test(lower)) continue;
    const mut = fn.stateMutability || "nonpayable";
    const isPaid = PAID_MINT_PATTERNS.some((p) => lower.includes(p));

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

export async function scanContract(rawAddress: string, chain: ChainId = getDefaultChainId()): Promise<ScanResult> {
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
  const bytecode = await getBytecode(checksumAddress, chain);
  const { abi, isVerified, error: abiError } = await fetchContractAbi(checksumAddress, chain);

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
      warning: `No contract found at this address on ${getChainConfig(chain).name}.`,
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

  const isNft = await verifyIsNftContract(checksumAddress, abi, chain);
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

  const security = await auditContractSecurity(checksumAddress, chain);
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
  mintFunction: MintFunctionInfo,
  chain: ChainId = getDefaultChainId()
): Promise<{ success: boolean; error?: string }> {
  const client = getPublicClient(chain);
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
