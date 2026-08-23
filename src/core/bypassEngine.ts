import {
  type Hex,
  type Address,
  type Abi,
  encodeFunctionData,
  parseAbi,
  decodeErrorResult,
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

// ---------------------------------------------------------------------------
// Gate classification
// ---------------------------------------------------------------------------

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

export function classifyRevertReason(reason: string): GateType | undefined {
  const r = reason.toLowerCase();
  if (
    /whitelist|allowlist|not whitelisted|not on (the )?list|no access|not in list|merkle|proof/.test(
      r
    )
  ) {
    return "whitelist";
  }
  if (/signature|invalid sig|bad sig|sig.*expired|voucher|eip-?712/.test(r)) {
    return "signature";
  }
  if (
    /paused|not live|sale.*not.*(start|open)|closed|ended|sold out|max supply|mint limit|exceed(s|ed)|too (early|soon)/.test(
      r
    )
  ) {
    return /paused/.test(r) ? "paused" : "timed";
  }
  if (/\b(price|payment|payable|value|eth|ether|funds?)\b/.test(r)) {
    return "payment";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// State probing
// ---------------------------------------------------------------------------

function normalizeProbeValue(value: unknown): ProbeRow["value"] {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") {
    const n = Number(value);
    return Number.isSafeInteger(n) || (Number.isFinite(n) && Math.abs(n) < 1e15)
      ? n
      : value.toString();
  }
  if (typeof value === "string") {
    const asNum = Number(value);
    if (value.trim() !== "" && Number.isFinite(asNum)) return asNum;
    return value.slice(0, 120);
  }
  if (typeof value === "number") return value;
  return JSON.stringify(value)?.slice(0, 120) ?? null;
}

export async function probeStateVariables(
  client: ReturnType<typeof getPublicClient>,
  abi: Abi | null,
  address: Address
): Promise<ProbeRow[]> {
  if (!abi) return [];
  const fns = (abi as any[]).filter(
    (item) =>
      item?.type === "function" &&
      (item.stateMutability === "view" || item.stateMutability === "pure") &&
      Array.isArray(item.inputs) &&
      item.inputs.length === 0 &&
      typeof item.name === "string" &&
      PROBE_NAME_RE.test(item.name)
  );
  const rows: ProbeRow[] = [];
  for (const fn of fns.slice(0, MAX_PROBE_READS)) {
    try {
      const value = await client.readContract({
        address,
        abi: abi as any,
        functionName: fn.name,
        args: [],
      } as any);
      rows.push({ name: fn.name, value: normalizeProbeValue(value) });
    } catch {
      // keep probing the rest
    }
  }
  return rows;
}

export function refineGate(probe: ProbeRow[], fallback: GateType): GateType {
  if (!probe || probe.length === 0) return fallback;
  const first = (re: RegExp) => probe.find((r) => re.test(r.name));

  const paused = first(/^paused$/i);
  if (paused && paused.value === true) return "paused";

  const open = first(
    /^(publicMintOpen|publicSaleActive|saleActive|mintOpen|isMintOpen|publicMintActive|live|active)$/i
  );
  if (open && open.value === true) return "mint_open";

  const start = first(
    /^(publicSaleStart|saleStart|mintStart|publicMintStart|startTime)$/i
  );
  if (
    start &&
    typeof start.value === "number" &&
    start.value > 0 &&
    start.value < Date.now() / 1000
  ) {
    return "mint_open";
  }

  const closed = first(
    /^(whitelistOnly|isWhitelistOnly|presaleOnly|allowlistOnly)$/i
  );
  if (closed && closed.value === true) return "whitelist";

  const presaleEnd = first(
    /^(presaleEnd|whitelistEnd|allowlistEnd|presaleEndTime|whitelistEndTime|allowlistEndTime|privateEndTime|ogEnd|earlyAccessEnd)$/i
  );
  if (
    presaleEnd &&
    typeof presaleEnd.value === "number" &&
    presaleEnd.value > 0 &&
    presaleEnd.value > Date.now() / 1000
  ) {
    return "timed";
  }

  return fallback;
}

export function detectPublicMintAt(
  probe: ProbeRow[]
): { atMs: number; label: string } | null {
  if (!probe || probe.length === 0) return null;
  const nowMs = Date.now();
  let bestMs: number | null = null;
  let keyName = "";

  for (const key of PUBLIC_START_KEYS) {
    const row = probe.find((r) => r.name.toLowerCase() === key.toLowerCase());
    if (!row || typeof row.value !== "number" || row.value <= 0) continue;
    const atMs = row.value * 1000;
    if (atMs <= nowMs) continue;
    if (bestMs === null || atMs < bestMs) {
      bestMs = atMs;
      keyName = row.name;
    }
  }

  if (bestMs === null) return null;
  return {
    atMs: bestMs,
    label: `${keyName} → ${new Date(bestMs).toUTCString()} (in ~${formatDuration(bestMs - nowMs)})`,
  };
}

function formatDuration(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs < 48) return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const remHrs = hrs % 24;
  return remHrs > 0 ? `${days}d ${remHrs}h` : `${days}d`;
}

// ---------------------------------------------------------------------------
// Calldata + simulation
// ---------------------------------------------------------------------------

function buildArgs(fn: MintFunctionInfo, fromAddress: string): unknown[] {
  const args: string[] = fn.args ?? [];
  return args.map((arg) => {
    const a = arg.trim().toLowerCase();
    if (a.startsWith("address")) {
      return a.includes("[") ? [fromAddress as Address] : (fromAddress as Address);
    }
    if (a.startsWith("uint")) return 1n;
    if (a.startsWith("int")) return 1n;
    if (a.startsWith("bool")) return true;
    if (a.startsWith("bytes32")) {
      return a.includes("[") ? [] : (("0x" + "00".repeat(32)) as Hex);
    }
    if (a.startsWith("bytes")) {
      return a.includes("[") ? [] : ("0x" as Hex);
    }
    if (a.startsWith("string")) return "";
    return "";
  });
}

function encodeCall(fn: MintFunctionInfo, args: unknown[]): Hex {
  const stateMutability =
    (fn as { stateMutability?: string }).stateMutability ?? "nonpayable";
  const fnAbi = {
    type: "function" as const,
    name: fn.name,
    stateMutability,
    inputs: (fn.args ?? []).map((arg, i) => ({
      name: `arg${i}`,
      type: arg.trim(),
    })),
    outputs: [] as { name: string; type: string }[],
  };
  return encodeFunctionData({
    abi: [fnAbi] as unknown as Abi,
    functionName: fn.name,
    args: args as readonly unknown[],
  });
}

function asDecodedError(decoded: unknown): {
  errorName: string;
  args: readonly unknown[];
} {
  const d = decoded as { errorName?: unknown; args?: unknown };
  const errorName =
    typeof d.errorName === "string" ? d.errorName : "UnknownError";
  const args = Array.isArray(d.args) ? (d.args as readonly unknown[]) : [];
  return { errorName, args };
}

export function decodeRevertReason(raw: unknown, abi?: Abi | null): string {
  let data: string | null = null;
  let message = "";

  if (typeof raw === "string") {
    message = raw;
  } else if (raw && typeof raw === "object") {
    const err = raw as {
      data?: unknown;
      message?: unknown;
      shortMessage?: unknown;
      cause?: unknown;
    };
    if (
      typeof err.data === "string" &&
      err.data.startsWith("0x") &&
      err.data.length > 2
    ) {
      data = err.data;
    }
    message =
      typeof err.shortMessage === "string"
        ? err.shortMessage
        : typeof err.message === "string"
          ? err.message
          : "";
    const cause = err.cause as { data?: unknown; message?: unknown } | undefined;
    if (
      !data &&
      cause &&
      typeof cause.data === "string" &&
      cause.data.startsWith("0x")
    ) {
      data = cause.data;
    }
    if (!message && cause && typeof cause.message === "string") {
      message = cause.message;
    }
  }

  if (data) {
    try {
      const decoded = asDecodedError(
        decodeErrorResult({
          abi: REVERT_ABI as any,
          data: data as Hex,
        })
      );
      if (
        decoded.errorName === "Error" &&
        typeof decoded.args[0] === "string"
      ) {
        return decoded.args[0];
      }
      if (decoded.errorName === "Panic") {
        return `Panic(${String(decoded.args[0] ?? "")})`;
      }
      return `${decoded.errorName}(${JSON.stringify(decoded.args)})`;
    } catch {
      // not Error(string)/Panic
    }
    if (abi) {
      try {
        const decoded = asDecodedError(
          decodeErrorResult({
            abi: abi as any,
            data: data as Hex,
          })
        );
        return decoded.args.length > 0
          ? `${decoded.errorName}(${decoded.args
              .map((a) => JSON.stringify(a))
              .join(", ")})`
          : decoded.errorName;
      } catch {
        // unknown selector
      }
    }
    return `revert 0x${data.slice(2, 10)}…`;
  }

  const cleaned = message
    .replace(/^.*?execution reverted(?:\s*\(reason="?|\s*:\s*|\s*;\s*)?/i, "")
    .replace(/^["']/, "")
    .replace(/["']\s*\).*$|["']$/, "")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 160) : "Unknown revert";
}

interface SimResult {
  ok: boolean;
  error?: string;
}

async function simulateCall(
  client: ReturnType<typeof getPublicClient>,
  address: Address,
  data: Hex,
  from: Address,
  abi?: Abi | null
): Promise<SimResult> {
  try {
    await client.call({ account: from, to: address, data });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: decodeRevertReason(err, abi) };
  }
}

// Prisma BypassLog fields: walletAddress + success (NOT fromAddress/ok)
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
        txHash: txHash ?? null,
        error: error ?? null,
      },
    });
  } catch {
    // logging must never break the user-facing flow
  }
}

// ---------------------------------------------------------------------------
// Strategy ladder
// ---------------------------------------------------------------------------

async function tryDirectMint(
  userId: bigint,
  address: string,
  result: ScanResult,
  plan: BypassPlan,
  client: ReturnType<typeof getPublicClient>,
  attempts: WalletInfo[],
  options: BypassOptions,
  base: BypassResult
): Promise<BypassResult | null> {
  const targetFn = plan.targetFn;
  if (!targetFn) return null;
  const strategyId = "mint_open_direct";
  let lastSimError: string | undefined;
  let lastSendError: string | undefined;

  for (const wallet of attempts) {
    const privateKey = await getWalletPrivateKey(wallet.id).catch(() => null);
    if (!privateKey) continue;

    const hexKey = (
      privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`
    ) as Hex;
    const fromAddress = getAddressFromPrivateKey(hexKey);

    let data: Hex;
    try {
      data = encodeCall(targetFn, buildArgs(targetFn, fromAddress));
    } catch {
      continue;
    }

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
      await logBypass(
        userId,
        address,
        strategyId,
        fromAddress,
        true,
        undefined,
        "dry-run (simulation only)"
      );
      return {
        ...base,
        success: true,
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
      const receiptTimeout = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Transaction receipt timeout")),
          RECEIPT_TIMEOUT_MS
        )
      );
      receiptTimeout.catch(() => undefined);
      await Promise.race([
        client.waitForTransactionReceipt({ hash: txHash }),
        receiptTimeout,
      ]);

      await logBypass(userId, address, strategyId, fromAddress, true, txHash);
      return {
        ...base,
        success: true,
        strategyId,
        walletAddress: fromAddress,
        txHash,
      };
    } catch (err) {
      lastSendError = err instanceof Error ? err.message : String(err);
    }
  }

  base.error = lastSimError
    ? `Simulation reverted for ${targetFn.name}(): ${lastSimError}`
    : lastSendError ?? "No usable wallet for direct mint";
  return null;
}

function buildProbeMatrix(
  fns: MintFunctionInfo[],
  fromAddress: string
): ProbeRowCall[] {
  const rows: ProbeRowCall[] = [];
  for (const fn of fns) {
    let baseArgs: unknown[];
    try {
      baseArgs = buildArgs(fn, fromAddress);
      rows.push({ fn, args: baseArgs, data: encodeCall(fn, baseArgs) });
    } catch {
      continue;
    }

    const sigIdx = fn.args.findIndex((a) =>
      /^bytes/.test(a.trim().toLowerCase())
    );
    if (sigIdx >= 0) {
      const variant = baseArgs.slice();
      const t = fn.args[sigIdx].trim().toLowerCase();
      if (t.includes("[")) {
        variant[sigIdx] = [("0x" + "00".repeat(32)) as Hex];
      } else if (t.startsWith("bytes32")) {
        variant[sigIdx] = ("0x" + "00".repeat(32)) as Hex;
      } else {
        variant[sigIdx] = "0x" as Hex;
      }
      try {
        rows.push({ fn, args: variant, data: encodeCall(fn, variant) });
      } catch {
        // skip
      }
    }

    const uintIdx = fn.args.findIndex((a) =>
      /^uint/.test(a.trim().toLowerCase())
    );
    if (uintIdx >= 0) {
      const variant = baseArgs.slice();
      variant[uintIdx] = 0n;
      try {
        rows.push({ fn, args: variant, data: encodeCall(fn, variant) });
      } catch {
        // skip
      }
    }
  }
  return rows;
}

async function findWorkingCall(
  client: ReturnType<typeof getPublicClient>,
  address: Address,
  rows: ProbeRowCall[],
  fromAddress: Address,
  abi: Abi
): Promise<ProbeRowCall | null> {
  for (const row of rows) {
    const sim = await simulateCall(
      client,
      address,
      row.data,
      fromAddress,
      abi
    );
    if (sim.ok) return row;
  }
  return null;
}

async function tryMatrix(
  userId: bigint,
  address: string,
  result: ScanResult,
  client: ReturnType<typeof getPublicClient>,
  attempts: WalletInfo[],
  options: BypassOptions,
  base: BypassResult,
  fns: MintFunctionInfo[],
  strategyId: string
): Promise<BypassResult | null> {
  if (!result.abi || fns.length === 0) return null;

  for (const wallet of attempts) {
    const privateKey = await getWalletPrivateKey(wallet.id).catch(() => null);
    if (!privateKey) continue;

    const hexKey = (
      privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`
    ) as Hex;
    const fromAddress = getAddressFromPrivateKey(hexKey);

    const rows = buildProbeMatrix(fns, fromAddress);
    const hit = await findWorkingCall(
      client,
      address as Address,
      rows,
      fromAddress,
      result.abi
    );
    if (!hit) continue;

    base.strategyId = strategyId;
    base.gateType = "mint_open";

    if (options.dryRun) {
      await logBypass(
        userId,
        address,
        strategyId,
        fromAddress,
        true,
        undefined,
        "dry-run (simulation only)"
      );
      return {
        ...base,
        success: true,
        walletAddress: fromAddress,
        dryRun: true,
      };
    }

    try {
      const walletClient = getWalletClient(hexKey);
      const txHash = await walletClient.sendTransaction({
        to: address as Address,
        data: hit.data,
        value: 0n,
      });
      const receiptTimeout = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Transaction receipt timeout")),
          RECEIPT_TIMEOUT_MS
        )
      );
      receiptTimeout.catch(() => undefined);
      await Promise.race([
        client.waitForTransactionReceipt({ hash: txHash }),
        receiptTimeout,
      ]);

      await logBypass(userId, address, strategyId, fromAddress, true, txHash);
      return {
        ...base,
        success: true,
        walletAddress: fromAddress,
        txHash,
      };
    } catch (err) {
      base.error = err instanceof Error ? err.message : String(err);
    }
  }

  if (!base.error) {
    base.error = "No mint call simulated successfully (gate not bypassable)";
  }
  return null;
}

function publicPathFunctions(result: ScanResult): MintFunctionInfo[] {
  if (!result.abi) return [];
  return analyzeAbiForMintFunctions(result.abi).filter((f) => {
    const n = f.name.toLowerCase();
    const isPublicFlavored =
      /^(public|free|claim|collect|mint|airdrop|open)/.test(n) ||
      /public|free|claim|collect|open/.test(n);
    const isGated =
      /whitelist|allowlist|presale|og|early|sig|voucher|merkle|proof|team|owner|admin|dev/.test(
        n
      );
    return isPublicFlavored && !isGated;
  });
}

function buildFinalError(
  gateType: GateType,
  simError: string | undefined,
  publicMintAt: { atMs: number; label: string } | null,
  planReason: string | undefined
): string {
  switch (gateType) {
    case "whitelist":
      return (
        `Whitelist gate: ${simError ?? "Not whitelisted"}. ` +
        (publicMintAt
          ? `Public window opens at ${publicMintAt.label} — run /bypass <addr> --probe --schedule to auto-mint the moment it opens.`
          : "The on-chain whitelist check cannot be forged. Run /bypass <addr> --probe to inspect state; if a public window exists, --schedule will auto-mint it.")
      );
    case "signature":
      return (
        `Signature-gated mint (${simError ?? "Invalid signature"}). Requires a valid off-chain signature the bot cannot forge. ` +
        `Only exploitable if the contract accepts empty/invalid signatures — the argument matrix was exhausted with no accepted call.`
      );
    case "payment":
      return `Mint requires payment (${simError ?? "no free path"}), and the bypass engine only sends value-0 simulations to protect your funds. No free mint exists on this contract.`;
    case "paused":
      return `Mint is paused (paused() == true). Nothing can mint until the owner unpauses.`;
    case "timed":
      return publicMintAt
        ? `Sale window not open yet — opens at ${publicMintAt.label}. Run /bypass <addr> --probe --schedule to auto-mint it.`
        : `Sale window not open yet (${simError ?? "timed gate"}). Run /bypass <addr> --probe to inspect phase timestamps.`;
    default:
      return simError
        ? `Simulation reverted: ${simError}`
        : planReason ?? "No bypass strategy available for this contract";
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function executeBypass(
  userId: bigint,
  rawAddress: string,
  options: BypassOptions = {}
): Promise<BypassResult> {
  const address = normalizeAddressInput(rawAddress);
  if (!address) throw new Error("Invalid address");

  const result: ScanResult = await scanContract(address);
  const client = getPublicClient();

  const probe = await probeStateVariables(
    client,
    result.abi,
    address as Address
  );
  const plan = getBypassPlan(result);
  const state = refineGate(probe, plan.gateType);
  const publicMintAt = detectPublicMintAt(probe);

  const base: BypassResult = {
    success: false,
    contractAddress: address,
    gateType: state,
    strategyId: "none",
    state,
    probe,
    publicMintAt,
  };

  if (options.probeOnly) {
    base.success = true;
    base.strategyId = "probe_matrix";
    base.probeOnly = true;
    await logBypass(
      userId,
      address,
      "probe_matrix",
      "",
      true,
      undefined,
      "probe-only (no tx)"
    );
    return base;
  }

  const gas = await checkGasSafety(userId);
  if (!gas.safe) {
    const error = `Gas too high to proceed: ${gas.currentGwei} gwei (ceiling ${gas.maxGwei} gwei)`;
    await logBypass(userId, address, "none", "", false, undefined, error);
    return { ...base, error };
  }

  const wallets = await getWallets(userId);
  if (wallets.length === 0) {
    const error = "No wallet found. Add a wallet in the Portfolio menu first.";
    await logBypass(userId, address, "none", "", false, undefined, error);
    return { ...base, error };
  }

  const attempts = [
    ...wallets.filter((w) => w.isActive),
    ...wallets.filter((w) => !w.isActive),
  ].slice(0, MAX_WALLET_ATTEMPTS);

  const bestFn =
    plan.targetFn ??
    getBestMintFunction(result.mintFunctions) ??
    result.mintFunctions[0] ??
    null;
  let simError: string | undefined;
  if (bestFn) {
    for (const wallet of attempts) {
      const privateKey = await getWalletPrivateKey(wallet.id).catch(() => null);
      if (!privateKey) continue;
      const hexKey = (
        privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`
      ) as Hex;
      const fromAddress = getAddressFromPrivateKey(hexKey);
      let data: Hex;
      try {
        data = encodeCall(bestFn, buildArgs(bestFn, fromAddress));
      } catch {
        continue;
      }
      const sim = await simulateCall(
        client,
        address as Address,
        data,
        fromAddress,
        result.abi ?? undefined
      );
      if (sim.ok) {
        simError = undefined;
        break;
      }
      simError = sim.error;
    }
  }
  const classified = simError ? classifyRevertReason(simError) : undefined;
  if (classified) base.gateType = classified;

  if (
    plan.executable &&
    plan.targetFn &&
    (!classified || classified === "mint_open")
  ) {
    const direct = await tryDirectMint(
      userId,
      address,
      result,
      plan,
      client,
      attempts,
      options,
      base
    );
    if (direct) return direct;
  }

  if (
    base.gateType === "whitelist" ||
    base.gateType === "timed" ||
    base.gateType === "paused"
  ) {
    const pubFns = publicPathFunctions(result);
    if (pubFns.length > 0) {
      const pub = await tryMatrix(
        userId,
        address,
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

  if (base.gateType !== "payment" && base.gateType !== "paused") {
    const allFns = result.abi ? analyzeAbiForMintFunctions(result.abi) : [];
    if (allFns.length > 0) {
      const matrix = await tryMatrix(
        userId,
        address,
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

  const error = buildFinalError(
    base.gateType,
    simError,
    publicMintAt,
    plan.reason
  );
  await logBypass(userId, address, base.strategyId, "", false, undefined, error);
  return { ...base, error };
}
