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
}

export interface ScanResult {
  contractAddress: string;
  mintFunctions: MintFunctionInfo[];
  isVerified: boolean;
  abi: Abi | null;
  bytecode: Hex | null;
  isContract: boolean;
  security: SecurityReport;
  warning?: string;
}

const PAID_MINT_PATTERNS = [
  "mintWithETH",
  "paidMint",
  "mintWithPayment",
  "mintWithPrice",
  "purchase",
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
  // Force-migrate any leftover V1 Basescan host
  if (/basescan\.org/i.test(raw) || raw.endsWith("/api") && !raw.includes("/v2/")) {
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

  const url = `${baseUrl}?${params.toString()}`;
  try {
    const data = await fetchJson(url);
    const result = data?.result;

    if (typeof result === "string" && /deprecated\s+v1/i.test(result)) {
      return {
        abi: null,
        isVerified: false,
        error: "Explorer still on deprecated Basescan V1 — set BASESCAN_API_URL=https://api.etherscan.io/v2/api",
      };
    }
    if (typeof result === "string" && /missing\/invalid api key/i.test(result)) {
      return {
        abi: null,
        isVerified: false,
        error: "Missing/invalid Etherscan API key (BASESCAN_API_KEY / ETHERSCAN_API_KEY)",
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

async function verifyIsNftContract(address: Address, abi: Abi): Promise<boolean> {
  const client = getPublicClient();

  const hasNftFunctions = abi.some((item: any) => {
    if (item.type !== "function") return false;
    const name = (item.name?.toLowerCase() || "");
    return (
      name === "ownerof" ||
      name === "tokenuri" ||
      name === "safetransferfrom" ||
      name === "balanceof"
    );
  });
  if (hasNftFunctions) return true;

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

    const isPaid = PAID_MINT_PATTERNS.some((p) =>
      fn.name.toLowerCase().includes(p.toLowerCase())
    );
    const isPayable = fn.stateMutability === "payable" || fn.payable === true;
    const isMintName = /mint|claim|collect/i.test(fn.name);

    if (!isMintName) continue;

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
        isFreeMint: !isPayable && !isPaid,
        requiresPayment: isPayable || isPaid,
      });
    } catch {
      // skip bad ABI entries
    }
  }

  return functions;
}

export async function scanContract(rawAddress: string): Promise<ScanResult> {
  const cleanInput = rawAddress.trim();
  const hexAddress = cleanInput.startsWith("0x") ? cleanInput : `0x${cleanInput}`;

  if (!isAddress(hexAddress)) {
    return {
      contractAddress: hexAddress,
      mintFunctions: [],
      isVerified: false,
      abi: null,
      bytecode: null,
      isContract: false,
      security: {
        isSafe: false,
        isHoneypot: false,
        isDrainer: false,
        riskScore: 100,
        warnings: ["Invalid address format"],
      },
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
      abi: null,
      bytecode: null,
      isContract: false,
      security: {
        isSafe: false,
        isHoneypot: false,
        isDrainer: false,
        riskScore: 100,
        warnings: ["No contract deployed"],
      },
      warning: "No contract found at this address on Base.",
    };
  }

  if (!isVerified || !abi) {
    const explorerBroken = Boolean(abiError);
    return {
      contractAddress: checksumAddress,
      mintFunctions: [],
      isVerified: false,
      abi,
      bytecode,
      isContract: true,
      security: {
        isSafe: false,
        isHoneypot: false,
        isDrainer: false,
        riskScore: explorerBroken ? 40 : 50,
        warnings: [
          explorerBroken
            ? `Explorer API error: ${abiError}`
            : "Unverified contract source",
        ],
      },
      warning: explorerBroken
        ? `Skipped: Could not load ABI (${abiError}). Check BASESCAN_API_URL + API key.`
        : "Skipped: Contract source code is unverified.",
    };
  }

  const isNft = await verifyIsNftContract(checksumAddress, abi);
  if (!isNft) {
    return {
      contractAddress: checksumAddress,
      mintFunctions: [],
      isVerified,
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
      warning: "Skipped: Contract is a token/DeFi protocol, not an NFT collection.",
    };
  }

  const security = await auditContractSecurity(checksumAddress);
  if (!security.isSafe) {
    return {
      contractAddress: checksumAddress,
      mintFunctions: [],
      isVerified,
      abi,
      bytecode,
      isContract: true,
      security,
      warning: `🚨 UNSAFE CONTRACT: ${security.warnings.join(", ")}`,
    };
  }

  const mintFunctions = analyzeAbiForMintFunctions(abi);
  // Prefer free mints; still surface paid mints so whois/bypass can explain gates
  const freeMintFunctions = mintFunctions.filter((f) => f.isFreeMint && !f.requiresPayment);
  const reportFns = freeMintFunctions.length > 0 ? freeMintFunctions : mintFunctions;

  if (reportFns.length === 0) {
    return {
      contractAddress: checksumAddress,
      mintFunctions: [],
      isVerified,
      abi,
      bytecode,
      isContract: true,
      security,
      warning: "Skipped: No valid mint/claim function detected.",
    };
  }

  if (freeMintFunctions.length === 0) {
    return {
      contractAddress: checksumAddress,
      mintFunctions: reportFns,
      isVerified,
      abi,
      bytecode,
      isContract: true,
      security,
      warning: "Verified NFT found, but mint functions require payment (not a free mint).",
    };
  }

  return {
    contractAddress: checksumAddress,
    mintFunctions: freeMintFunctions,
    isVerified,
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
      if (type === "uint256") return 1n;
      if (type === "address") return getAddress(fromAddress);
      if (type === "bytes32[]") return [];
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
