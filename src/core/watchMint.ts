import {
  type Address,
  type Hex,
  parseAbi,
  encodeFunctionData,
  getAddress,
} from "viem";
import {
  getPublicClient,
  getAddressFromPrivateKey,
  getWalletClient,
  normalizeAddressInput,
} from "./chain.js";
import { getWallets, getWalletPrivateKey } from "./wallet.js";
import {
  scanContract,
  getBestMintFunction,
  type MintFunctionInfo,
} from "./scanner.js";
import { prisma } from "../db/client.js";

export type WatchState =
  | "watching"
  | "fired"
  | "stopped"
  | "timeout"
  | "blocked"
  | "failed";

export interface WatchResult {
  state: WatchState;
  contractAddress: string;
  gateType?: string;
  walletAddress?: string;
  txHash?: string;
  attempts: number;
  elapsedMs: number;
  reason?: string;
}

export interface WatchHandle {
  userId: bigint;
  contractAddress: string;
  readonly startedAt: number;
  readonly stopped: boolean;
  stop(): void;
}

export interface WatchOptions {
  userId: bigint;
  rawAddress: string;
  pollIntervalMs?: number;
  maxDurationMs?: number;
  notify?: (message: string) => void | Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 2_500;
const DEFAULT_MAX_DURATION_MS = 3 * 60 * 60 * 1000;
const RECEIPT_TIMEOUT_MS = 60_000;
const MAX_CONCURRENT_PER_CONTRACT = 3;
const MAX_CONCURRENT_PER_USER = 5;
const REASON_CHANGE_MIN_INTERVAL_MS = 30_000;

const PERMANENT_REASONS =
  /whitelist|allowlist|not\s+(on|in)\s+(the\s+)?(list|whitelist)|signature|invalid\s+signature|insufficient|sold\s*out|max\s*(mint|supply)|already\s+minted|mint\s*(ended|closed)|forbidden|unauthorized/i;

const activeWatches = new Map<string, WatchHandle[]>();

function watchKey(userId: bigint, address: string): string {
  return `${userId.toString()}:${address.toLowerCase()}`;
}

export function isWatchActive(userId: bigint, address: string): boolean {
  return (activeWatches.get(watchKey(userId, address)) ?? []).length > 0;
}

export function activeWatchCount(userId: bigint): number {
  let total = 0;
  const prefix = `${userId.toString()}:`;
  for (const [key, handles] of activeWatches) {
    if (key.startsWith(prefix)) total += handles.length;
  }
  return total;
}

export function stopWatch(userId: bigint, address: string): number {
  const key = watchKey(userId, address);
  const handles = activeWatches.get(key);
  if (!handles || handles.length === 0) return 0;
  for (const handle of handles) handle.stop();
  activeWatches.delete(key);
  return handles.length;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function shortReason(reason: string): string {
  const cleaned = reason.replace(/\s+/g, " ").trim();
  return cleaned.length > 80 ? `${cleaned.slice(0, 80)}…` : cleaned;
}

function classifyGate(reason: string): string {
  if (/whitelist|allowlist/i.test(reason)) return "whitelist";
  if (/signature/i.test(reason)) return "signature";
  if (/payment|insufficient|funds|price|cost/i.test(reason)) return "payment";
  if (/paused/i.test(reason)) return "paused";
  if (/sold\s*out|max\s*(mint|supply)|already|minted/i.test(reason))
    return "soldout";
  if (/not\s+(open|live|started|active)|soon|waiting|coming/i.test(reason))
    return "timed";
  return "unknown";
}

function buildArgs(types: string[], fromAddress: string): unknown[] {
  return types.map((type) => {
    if (type.startsWith("uint") || type.startsWith("int")) return 1n;
    if (type === "address") return getAddress(fromAddress);
    if (type === "bool") return true;
    if (type.endsWith("[]")) return [];
    if (type.startsWith("bytes")) return "0x";
    return "0x";
  });
}

function buildMintCalldata(
  fn: MintFunctionInfo,
  fromAddress: string
): Hex | null {
  try {
    const abiItem = parseAbi([
      `function ${fn.name}(${fn.args.join(",")})`,
    ] as const);
    return encodeFunctionData({
      abi: abiItem,
      functionName: fn.name,
      args: buildArgs(fn.args, fromAddress) as any,
    });
  } catch {
    return null;
  }
}

async function simulateMintCall(
  contractAddress: Address,
  fromAddress: string,
  data: Hex
): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = getPublicClient();
    await client.call({
      data,
      to: contractAddress,
      account: getAddress(fromAddress),
      value: 0n,
    });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

async function fireMint(
  userId: bigint,
  contractAddress: string,
  hexKey: Hex,
  fromAddress: string,
  data: Hex,
  attempts: number,
  startedAt: number,
  notify: (message: string) => void | Promise<void>
): Promise<WatchResult> {
  try {
    const publicClient = getPublicClient();
    const walletClient = getWalletClient(hexKey);

    let gas: bigint;
    try {
      gas =
        (await publicClient.estimateGas({
          account: getAddress(fromAddress),
          to: contractAddress as Address,
          data,
          value: 0n,
        })) + 100_000n;
    } catch {
      gas = 1_500_000n;
    }

    const txHash = await walletClient.sendTransaction({
      to: contractAddress as Address,
      data,
      value: 0n,
      gas,
    });

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: RECEIPT_TIMEOUT_MS,
    });

    const success = receipt.status === "success";
    await prisma.bypassLog
      .create({
        data: {
          userId,
          contractAddress,
          strategyId: "watch",
          walletAddress: fromAddress,
          success,
          txHash,
          error: success ? undefined : `Receipt status ${receipt.status}`,
        },
      })
      .catch(() => undefined);

    const result: WatchResult = {
      state: success ? "fired" : "failed",
      contractAddress,
      walletAddress: fromAddress,
      txHash,
      attempts,
      elapsedMs: Date.now() - startedAt,
      reason: success
        ? undefined
        : `Transaction mined but reverted (status ${receipt.status}).`,
    };
    await notify(
      success
        ? `🎯 MINT FIRED!\n\nTx: ${txHash}\nWallet: ${fromAddress}`
        : `⚠️ Mint tx sent but reverted: ${txHash}`
    );
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await notify(`❌ Mint failed: ${shortReason(reason)}`);
    return {
      state: "failed",
      contractAddress,
      walletAddress: fromAddress,
      attempts,
      elapsedMs: Date.now() - startedAt,
      reason,
    };
  }
}

export async function startWatchMint(
  options: WatchOptions
): Promise<WatchResult> {
  const address = normalizeAddressInput(options.rawAddress);
  if (!address) throw new Error("Invalid address");

  const startedAt = Date.now();
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const deadline = startedAt + maxDurationMs;
  const notify =
    options.notify ??
    (async (message: string) => {
      console.log(`[watch] ${message}`);
    });

  const safeNotify = async (message: string): Promise<void> => {
    try {
      await notify(message);
    } catch {
      // Telegram send failures must never kill the watcher loop
    }
  };

  const key = watchKey(options.userId, address);
  if ((activeWatches.get(key) ?? []).length >= MAX_CONCURRENT_PER_CONTRACT) {
    const reason =
      "A watcher is already active for this contract. Stop it with /bypass <addr> --stop or the ⏹ button.";
    await safeNotify(`⛔ ${reason}`);
    return {
      state: "blocked",
      contractAddress: address,
      attempts: 0,
      elapsedMs: 0,
      reason,
    };
  }
  if (activeWatchCount(options.userId) >= MAX_CONCURRENT_PER_USER) {
    const reason =
      "Too many active watchers (max 5). Stop one first with /bypass <addr> --stop.";
    await safeNotify(`⛔ ${reason}`);
    return {
      state: "blocked",
      contractAddress: address,
      attempts: 0,
      elapsedMs: 0,
      reason,
    };
  }

  let stopped = false;
  const handle: WatchHandle = {
    userId: options.userId,
    contractAddress: address,
    startedAt,
    get stopped() {
      return stopped;
    },
    stop() {
      stopped = true;
    },
  };
  const handles = activeWatches.get(key) ?? [];
  handles.push(handle);
  activeWatches.set(key, handles);

  try {
    const result = await scanContract(address);
    const fn = getBestMintFunction(result.mintFunctions);

    if (!fn) {
      const reason =
        result.warning ?? "No free mint function found on this contract.";
      await safeNotify(`⛔ ${reason}`);
      return {
        state: "blocked",
        contractAddress: address,
        attempts: 0,
        elapsedMs: 0,
        reason,
      };
    }

    const wallets = await getWallets(options.userId);
    const candidate = wallets.find((w) => w.isActive) ?? wallets[0];
    if (!candidate) {
      const reason = "No wallet found. Add a wallet in the Portfolio menu first.";
      await safeNotify(`⛔ ${reason}`);
      return {
        state: "blocked",
        contractAddress: address,
        attempts: 0,
        elapsedMs: 0,
        reason,
      };
    }

    const privateKey = await getWalletPrivateKey(candidate.id).catch(
      () => null
    );
    if (!privateKey) {
      const reason = "Could not unlock the wallet key for this contract.";
      await safeNotify(`⛔ ${reason}`);
      return {
        state: "blocked",
        contractAddress: address,
        attempts: 0,
        elapsedMs: 0,
        reason,
      };
    }

    const hexKey = (
      privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`
    ) as Hex;
    const fromAddress = getAddressFromPrivateKey(hexKey);

    const data = buildMintCalldata(fn, fromAddress);
    if (!data) {
      const reason = `Could not encode mint call for ${fn.name}(${fn.args.join(", ")})`;
      await safeNotify(`⛔ ${reason}`);
      return {
        state: "blocked",
        contractAddress: address,
        attempts: 0,
        elapsedMs: 0,
        reason,
      };
    }

    await safeNotify(
      `👀 Watching ${fn.name}() on ${address} — polling every ${Math.round(pollIntervalMs / 1000)}s.\n` +
        `Will fire the instant the gate opens. Max watch window: ${Math.round(maxDurationMs / 60_000)} min.`
    );

    let attempts = 0;
    let lastReasonCategory = "";
    let lastReasonChangeAt = 0;
    let final: WatchResult | undefined;

    while (!stopped && Date.now() < deadline) {
      attempts++;
      const sim = await simulateMintCall(
        address as Address,
        fromAddress,
        data
      );

      if (sim.ok) {
        final = await fireMint(
          options.userId,
          address,
          hexKey,
          fromAddress,
          data,
          attempts,
          startedAt,
          safeNotify
        );
        break;
      }

      const reason = sim.error ?? "Unknown revert";
      if (PERMANENT_REASONS.test(reason)) {
        const gateType = classifyGate(reason);
        await safeNotify(
          `⛔ Mint blocked — permanent gate detected: ${gateType}.\n${shortReason(reason)}\n\nStopping the watcher.`
        );
        final = {
          state: "blocked",
          contractAddress: address,
          gateType,
          walletAddress: fromAddress,
          attempts,
          elapsedMs: Date.now() - startedAt,
          reason,
        };
        break;
      }

      const category = classifyGate(reason);
      if (
        category !== lastReasonCategory &&
        Date.now() - lastReasonChangeAt >= REASON_CHANGE_MIN_INTERVAL_MS
      ) {
        lastReasonCategory = category;
        lastReasonChangeAt = Date.now();
        await safeNotify(
          `🔄 Gate signal: ${shortReason(reason)}\n(attempt #${attempts}, still watching…)`
        );
      }

      await sleep(pollIntervalMs);
    }

    if (final) return final;

    if (stopped) {
      await safeNotify(`⏹ Watcher stopped (${attempts} attempts).`);
      return {
        state: "stopped",
        contractAddress: address,
        walletAddress: fromAddress,
        attempts,
        elapsedMs: Date.now() - startedAt,
        reason: "Stopped by user",
      };
    }

    await safeNotify(
      `⏰ Watch window expired after ${Math.round(maxDurationMs / 60_000)} min — the mint never opened.`
    );
    return {
      state: "timeout",
      contractAddress: address,
      walletAddress: fromAddress,
      attempts,
      elapsedMs: Date.now() - startedAt,
      reason: "Watch window expired",
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await safeNotify(`❌ Watch failed: ${shortReason(reason)}`);
    return {
      state: "failed",
      contractAddress: address,
      attempts: 0,
      elapsedMs: Date.now() - startedAt,
      reason,
    };
  } finally {
    const remaining = (activeWatches.get(key) ?? []).filter(
      (h) => h !== handle
    );
    if (remaining.length > 0) {
      activeWatches.set(key, remaining);
    } else {
      activeWatches.delete(key);
    }
  }
}
