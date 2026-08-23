import { Hex, Address, encodeFunctionData, parseAbi, decodeErrorResult } from "viem";
import {
  getPublicClient,
  getAddressFromPrivateKey,
  getWalletClient,
  normalizeAddressInput,
} from "./chain.js";
import { checkGasSafety } from "./gasGuard.js";
import { getWallets, getWalletPrivateKey } from "./wallet.js";
import {
  scanContract,
  getBestMintFunction,
  MintFunctionInfo,
  ScanResult,
} from "./scanner.js";
import { prisma } from "../db/client.js";

export type GateType =
  | "mint_open"
  | "whitelist"
  | "signature"
  | "payment"
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
  error?: string;
}

export interface BypassPlan {
  executable: boolean;
  gateType: GateType;
  targetFn: MintFunctionInfo | null;
  reason?: string;
}

export interface BypassOptions {
  // Simulate only — never send a real transaction.
  dryRun?: boolean;
}

// Common reverts that carry human-readable data. Custom errors on the target
// contract are decoded separately when its ABI is available.
const REVERT_ABI = parseAbi([
  "error Error(string)",
  "error Panic(uint256)",
] as const);

const MAX_WALLET_ATTEMPTS = 5;
const RECEIPT_TIMEOUT_MS = 60_000;

export function detectGateType(mintFunctions: MintFunctionInfo[]): GateType {
  if (!mintFunctions || mintFunctions.length === 0) return "none";

  const freeFns = mintFunctions.filter((f) => f.isFreeMint);
  if (freeFns.length === 0) return "payment";

  const joined = mintFunctions
    .map((f) => `${f.name}(${f.args.join(",")})`)
    .join(" ");
  if (/whitelist|allowlist|presale|og\b|early/i.test(joined)) return "whitelist";

  const hasSigArg = mintFunctions.some(
    (f) =>
      f.args.some((a) => a.trim().toLowerCase().startsWith("bytes")) ||
      /signature|merkle/i.test(f.name)
  );
  if (hasSigArg) return "signature";

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

function encodeCall(fn: MintFunctionInfo, args: unknown[]): Hex {
  const abi = parseAbi([`function ${fn.name}(${fn.args.join(",")})`] as const);
  return encodeFunctionData({
    abi,
    functionName: fn.name,
    args: args as any,
  }) as Hex;
}

function buildArgs(fn: MintFunctionInfo, fromAddress: Address): unknown[] {
  return fn.args.map((arg) => {
    const a = arg.trim();
    if (a.startsWith("uint")) return 1n;
    if (a === "address") return fromAddress;
    if (a === "bytes32[]") return [];
    if (a.startsWith("bytes")) return "0x";
    return "0x";
  });
}

function extractRevertData(err: unknown): Hex | undefined {
  const e = err as any;
  const candidates = [
    e?.data,
    e?.cause?.data,
    e?.details?.data,
    e?.error?.data,
    e?.rpcError?.data,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && /^0x[0-9a-fA-F]+$/.test(c) && c.length >= 10) {
      return c as Hex;
    }
  }
  // viem sometimes embeds the revert bytes in the message instead.
  const msg = typeof e?.message === "string" ? e.message : String(err ?? "");
  const match = msg.match(/0x[0-9a-fA-F]{8,}/);
  if (match) return match[0] as Hex;
  return undefined;
}

// Decode a revert into a human-readable reason: Error(string), Panic(uint256),
// or the contract's own custom error selector (best-effort without the ABI).
export function decodeRevertReason(err: unknown, contractAbi?: unknown): string {
  const data = extractRevertData(err);
  if (data) {
    try {
      const decoded = decodeErrorResult({ abi: REVERT_ABI, data });
      if (decoded.errorName === "Error") return String(decoded.args?.[0] ?? "reverted");
      if (decoded.errorName === "Panic") return `Panic(${String(decoded.args?.[0])})`;
    } catch {
      // not a standard revert — fall through to custom-error attempt
    }
    try {
      if (contractAbi) {
        const decoded = decodeErrorResult({ abi: contractAbi as any, data });
        return `${decoded.errorName}(${(decoded.args ?? []).map(String).join(", ")})`;
      }
    } catch {
      // unknown selector
    }
  }
  const base = err instanceof Error ? err.message : String(err);
  return base.length > 200 ? base.slice(0, 200) : base;
}

async function simulateCall(
  client: ReturnType<typeof getPublicClient>,
  to: Address,
  data: Hex,
  from: Address,
  contractAbi?: unknown
): Promise<{ ok: boolean; error?: string }> {
  try {
    await client.call({ to, data, account: from, value: 0n } as any);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: decodeRevertReason(err, contractAbi) };
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
  await prisma.bypassLog
    .create({
      data: {
        userId,
        contractAddress,
        strategyId,
        walletAddress,
        success,
        txHash,
        error,
      },
    })
    .catch(() => undefined);
}

export async function executeBypass(
  userId: bigint,
  rawAddress: string,
  options: BypassOptions = {}
): Promise<BypassResult> {
  const address = normalizeAddressInput(rawAddress);
  if (!address) throw new Error("Invalid address");

  const result: ScanResult = await scanContract(address);
  const plan = getBypassPlan(result);

  if (!plan.executable || !plan.targetFn) {
    const error = plan.reason ?? "No bypass strategy available for this contract";
    await logBypass(userId, address, "none", "", false, undefined, error);
    return {
      success: false,
      contractAddress: address,
      gateType: plan.gateType,
      strategyId: "none",
      error,
    };
  }

  const strategyId = "mint_open_direct";

  const gas = await checkGasSafety(userId);
  if (!gas.safe) {
    const error = `Gas too high to proceed: ${gas.currentGwei} gwei (ceiling ${gas.maxGwei} gwei)`;
    await logBypass(userId, address, strategyId, "", false, undefined, error);
    return {
      success: false,
      contractAddress: address,
      gateType: plan.gateType,
      strategyId,
      error,
    };
  }

  const wallets = await getWallets(userId);
  if (wallets.length === 0) {
    const error = "No wallet found. Add a wallet in the Portfolio menu first.";
    await logBypass(userId, address, strategyId, "", false, undefined, error);
    return {
      success: false,
      contractAddress: address,
      gateType: plan.gateType,
      strategyId,
      error,
    };
  }

  // Active wallets first, then inactive; stop after a few attempts so a fully
  // gated contract can't burn minutes on simulated calls.
  const attempts = [
    ...wallets.filter((w) => w.isActive),
    ...wallets.filter((w) => !w.isActive),
  ].slice(0, MAX_WALLET_ATTEMPTS);

  const client = getPublicClient();

  let lastSimError: string | undefined;
  let lastSendError: string | undefined;

  for (const wallet of attempts) {
    const privateKey = await getWalletPrivateKey(wallet.id).catch(() => null);
    if (!privateKey) continue;

    const hexKey = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;
    const fromAddress = getAddressFromPrivateKey(hexKey);

    // Rebuild calldata per wallet so `address` args match the actual signer.
    const args = buildArgs(plan.targetFn, fromAddress);
    const data = encodeCall(plan.targetFn, args);

    const sim = await simulateCall(
      client,
      address as Address,
      data,
      fromAddress,
      result.abi ?? undefined
    );
    if (!sim.ok) {
      lastSimError = sim.error;
      continue;
    }

    if (options.dryRun) {
      await logBypass(userId, address, strategyId, fromAddress, true, undefined, "dry-run (simulation only)");
      return {
        success: true,
        contractAddress: address,
        gateType: plan.gateType,
        strategyId,
        walletAddress: fromAddress,
        dryRun: true,
      };
    }

    try {
      const walletClient = getWalletClient(hexKey);
      const txHash = await walletClient.sendTransaction({
        to: address as Address,
        data,
        value: 0n,
      });
      // Bound the receipt wait so a stalled node can't hang the command forever.
      const receiptTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Transaction receipt timeout")), RECEIPT_TIMEOUT_MS)
      );
      receiptTimeout.catch(() => undefined); // avoid unhandled rejection later
      await Promise.race([client.waitForTransactionReceipt({ hash: txHash }), receiptTimeout]);

      await logBypass(userId, address, strategyId, fromAddress, true, txHash);
      return {
        success: true,
        contractAddress: address,
        gateType: plan.gateType,
        strategyId,
        walletAddress: fromAddress,
        txHash,
      };
    } catch (err) {
      lastSendError = err instanceof Error ? err.message : String(err);
      // try the next wallet
    }
  }

  const error = lastSimError
    ? `Simulation reverted for ${plan.targetFn.name}(): ${lastSimError}`
    : lastSendError ?? "No usable wallet for bypass attempt";
  await logBypass(userId, address, strategyId, "", false, undefined, error);
  return {
    success: false,
    contractAddress: address,
    gateType: plan.gateType,
    strategyId,
    error,
  };
}
