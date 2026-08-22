import { Hex, Address, encodeFunctionData, parseAbi } from "viem";
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
  error?: string;
}

export interface BypassPlan {
  executable: boolean;
  gateType: GateType;
  targetFn: MintFunctionInfo | null;
  reason?: string;
}

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

async function simulateCall(
  client: ReturnType<typeof getPublicClient>,
  to: Address,
  data: Hex,
  from: Address
): Promise<boolean> {
  try {
    await client.call({ to, data, account: from, value: 0n } as any);
    return true;
  } catch {
    return false;
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
  rawAddress: string
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
  const wallet = (
    wallets.find((w) => (w as { isActive?: boolean }).isActive) ??
    wallets[0]
  ) as { id: string } | undefined;

  if (!wallet) {
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

  const privateKey = await getWalletPrivateKey(wallet.id);
  if (!privateKey) {
    const error = "Wallet private key unavailable";
    await logBypass(userId, address, strategyId, "", false, undefined, error);
    return {
      success: false,
      contractAddress: address,
      gateType: plan.gateType,
      strategyId,
      error,
    };
  }

  const hexKey = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  const fromAddress = getAddressFromPrivateKey(hexKey);

  const args = buildArgs(plan.targetFn, fromAddress);
  const data = encodeCall(plan.targetFn, args);

  const client = getPublicClient();
  const simOk = await simulateCall(client, address as Address, data, fromAddress);
  if (!simOk) {
    const error = `Simulation reverted for ${plan.targetFn.name}()`;
    await logBypass(userId, address, strategyId, fromAddress, false, undefined, error);
    return {
      success: false,
      contractAddress: address,
      gateType: plan.gateType,
      strategyId,
      walletAddress: fromAddress,
      error,
    };
  }

  const walletClient = getWalletClient(hexKey);
  const txHash = await walletClient.sendTransaction({
    to: address as Address,
    data,
    value: 0n,
  });
  await client.waitForTransactionReceipt({ hash: txHash });

  await logBypass(userId, address, strategyId, fromAddress, true, txHash);
  return {
    success: true,
    contractAddress: address,
    gateType: plan.gateType,
    strategyId,
    walletAddress: fromAddress,
    txHash,
  };
}
