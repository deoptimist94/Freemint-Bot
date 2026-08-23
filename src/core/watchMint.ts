import {
  type Address,
  type Hex,
  parseAbi,
  encodeFunctionData,
  getAddress,
} from "viem";
import {
  getPublicClient,
  getWalletClient,
  getAddressFromPrivateKey,
  normalizeAddressInput,
  shortenAddress,
} from "./chain.js";
import {
  getChainConfig,
  getDefaultChainId,
  type ChainId,
} from "./chains.js";
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
  address: string;
  chain?: ChainId;
  pollIntervalMs?: number;
  maxDurationMs?: number;
  notify?: (message: string) => void;
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

function watchKey(userId: bigint, address: string, chain: ChainId): string {
  return `${userId.toString()}:${chain}:${address.toLowerCase()}`;
}

function activeWatchCount(userId: bigint): number {
  let n = 0;
  for (const [key, handles] of activeWatches) {
    if (key.startsWith(`${userId.toString()}:`)) n += handles.length;
  }
  return n;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortReason(reason: string): string {
  const cleaned = reason.replace(/\s+/g, " ").trim();
  return cleaned.length > 180 ? `${cleaned.slice(0, 177)}...` : cleaned;
}

function classifyGate(reason: string): string | undefined {
  const r = reason.toLowerCase();
  if (/whitelist|allowlist|not\s+(on|in)\s+(the\s+)?(list|whitelist)/.test(r))
    return "whitelist";
  if (/signature|invalid\s+signature/.test(r)) return "signature";
  if (/sold\s*out|max\s*(mint|supply)|already\s+minted/.test(r))
    return "soldout";
  if (/paused/.test(r)) return "paused";
  if (/not\s+started|too\s+early/.test(r)) return "not_started";
  if (/insufficient/.test(r)) return "insufficient";
  if (/mint\s*(ended|closed)|forbidden|unauthorized/.test(r)) return "closed";
  return undefined;
}

function buildMintCalldata(
  fn: MintFunctionInfo,
  fromAddress: Address
): Hex | undefined {
  try {
    const abi = parseAbi([`function ${fn.name}(${fn.args.join(", ")})`]);
    const args = fn.args.map((arg) => {
      if (/^uint(\d+)?$/.test(arg)) return 1n;
      if (/^address$/.test(arg)) return getAddress(fromAddress);
      if (/^bytes(\d+)?(\[\])?$/.test(arg)) {
        return arg.endsWith("[]") ? [] : "0x";
      }
      if (arg.endsWith("[]")) return [];
      if (arg === "bool") return true;
      return "0x";
    });
    return encodeFunctionData({
      abi,
      functionName: fn.name,
      args: args as any,
    });
  } catch {
    return undefined;
  }
}

interface SimulateResult {
  ok: boolean;
  error?: string;
}

async function simulateMintCall(
  contractAddress: Address,
  from: Address,
  data: Hex,
  chain: ChainId
): Promise<SimulateResult> {
  try {
    await getPublicClient(chain).call({
      account: from,
      to: contractAddress,
      data,
      value: 0n,
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function fireMint(
  userId: bigint,
  contractAddress: string,
  hexKey: Hex,
  fromAddress: Address,
  data: Hex,
  attempts: number,
  startedAt: number,
  chain: ChainId,
  safeNotify: (message: string) => void
): Promise<WatchResult> {
  const { badge, explorerBaseUrl } = getChainConfig(chain);
  try {
    const hash = await getWalletClient(hexKey, chain).sendTransaction({
      to: contractAddress as Address,
      data,
    });
    const txUrl = `${explorerBaseUrl}/tx/${hash}`;
    try {
      const receipt = await getPublicClient(chain).waitForTransactionReceipt({
        hash,
        timeout: RECEIPT_TIMEOUT_MS,
      });
      if (receipt.status === "success") {
        prisma.mintHistory
          .create({
            data: {
              userId,
              contractAddress,
              chain,
              txHash: hash,
              status: "success",
            },
          })
          .catch(() => {});
        safeNotify(
          `🎉 ${badge} **MINTED!**\nContract: \`${contractAddress}\`\nTX: [${shortenAddress(hash, 8, 8)}](${txUrl})\nFired after ${attempts} attempt${attempts === 1 ? "" : "s"} (${Math.round((Date.now() - startedAt) / 1000)}s).`
        );
        return {
          state: "fired",
          contractAddress,
          txHash: hash,
          walletAddress: fromAddress,
          attempts,
          elapsedMs: Date.now() - startedAt,
        };
      }
      prisma.mintHistory
        .create({
          data: {
            userId,
            contractAddress,
            chain,
            txHash: hash,
            status: "failed",
          },
        })
        .catch(() => {});
      safeNotify(
        `❌ ${badge} Transaction reverted on-chain (receipt status: failed).\nTX: ${txUrl}`
      );
      return {
        state: "failed",
        contractAddress,
        txHash: hash,
        walletAddress: fromAddress,
        attempts,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (err) {
      const reason = shortReason(
        err instanceof Error ? err.message : String(err)
      );
      safeNotify(`❌ ${badge} Mint transaction failed: ${reason}`);
      return {
        state: "failed",
        contractAddress,
        txHash: hash,
        walletAddress: fromAddress,
        attempts,
        elapsedMs: Date.now() - startedAt,
        reason,
      };
    }
  } catch (err) {
    const reason = shortReason(
      err instanceof Error ? err.message : String(err)
    );
    safeNotify(`❌ ${badge} Mint transaction failed: ${reason}`);
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

export function stopWatchMint(
  userId: bigint,
  address: string,
  chain?: ChainId
): number {
  const addr = address.toLowerCase();
  let stopped = 0;
  for (const [key, handles] of [...activeWatches.entries()]) {
    const matchChain = chain
      ? key === watchKey(userId, addr, chain)
      : key.startsWith(`${userId.toString()}:`) && key.endsWith(`:${addr}`);
    if (!matchChain) continue;
    for (const h of handles) {
      h.stop();
      stopped += 1;
    }
    activeWatches.delete(key);
  }
  return stopped;
}

export async function startWatchMint(
  options: WatchOptions
): Promise<WatchResult> {
  const chain = options.chain ?? getDefaultChainId();
  const { badge, name: chainName } = getChainConfig(chain);
  const address = normalizeAddressInput(options.address);

  const notify =
    options.notify ??
    ((message: string) => {
      console.log(`[watch] ${message}`);
    });
  const safeNotify = (message: string) => {
    try {
      notify(message);
    } catch {
      console.log(`[watch] ${message}`);
    }
  };

  const startedAt = Date.now();
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const deadline = startedAt + maxDurationMs;

  const key = watchKey(options.userId, address, chain);

  if ((activeWatches.get(key) ?? []).length >= MAX_CONCURRENT_PER_CONTRACT) {
    safeNotify(
      `⛔ ${badge} Watch limit reached for ${address} on ${chainName} — max ${MAX_CONCURRENT_PER_CONTRACT} concurrent watchers per contract.`
    );
    return {
      state: "blocked",
      contractAddress: address,
      attempts: 0,
      elapsedMs: 0,
      reason: "per-contract limit",
    };
  }

  if (activeWatchCount(options.userId) >= MAX_CONCURRENT_PER_USER) {
    safeNotify(
      `⛔ ${badge} Watch limit reached — max ${MAX_CONCURRENT_PER_USER} concurrent watchers per user.`
    );
    return {
      state: "blocked",
      contractAddress: address,
      attempts: 0,
      elapsedMs: 0,
      reason: "per-user limit",
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

  let lastGateNotifyAt = 0;

  try {
    const result = await scanContract(address, chain);
    const fn = getBestMintFunction(result.mintFunctions);
    if (!fn) {
      const reason =
        result.warning ?? "No free mint function found on this contract.";
      safeNotify(`⛔ ${badge} ${reason}`);
      return {
        state: "blocked",
        contractAddress: address,
        attempts: 0,
        elapsedMs: Date.now() - startedAt,
        reason,
      };
    }

    const wallets = await getWallets(options.userId);
    const wallet = wallets.find((w) => w.isActive) ?? wallets[0];
    if (!wallet) {
      const reason = "No active wallet found.";
      safeNotify(`⛔ ${badge} ${reason}`);
      return {
        state: "blocked",
        contractAddress: address,
        attempts: 0,
        elapsedMs: Date.now() - startedAt,
        reason,
      };
    }

    const privateKey = await getWalletPrivateKey(wallet.id);
    const hexKey = (
      privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`
    ) as Hex;
    const fromAddress = getAddressFromPrivateKey(hexKey);
    const data = buildMintCalldata(fn, fromAddress);
    if (!data) {
      const reason = `Could not build calldata for ${fn.name}().`;
      safeNotify(`⛔ ${badge} ${reason}`);
      return {
        state: "blocked",
        contractAddress: address,
        attempts: 0,
        elapsedMs: Date.now() - startedAt,
        reason,
      };
    }

    safeNotify(
      `👀 ${badge} Watching ${fn.name}() on ${address} (${chainName}) — polling every ${pollIntervalMs}ms.`
    );

    let attempts = 0;
    while (!stopped && Date.now() < deadline) {
      attempts += 1;
      const sim = await simulateMintCall(
        address as Address,
        fromAddress,
        data,
        chain
      );
      if (sim.ok) {
        return await fireMint(
          options.userId,
          address,
          hexKey,
          fromAddress,
          data,
          attempts,
          startedAt,
          chain,
          safeNotify
        );
      }
      const simReason = shortReason(sim.error ?? "");
      if (PERMANENT_REASONS.test(sim.error ?? "")) {
        const gateType = classifyGate(sim.error ?? "");
        safeNotify(
          `⛔ ${badge} Mint blocked — permanent gate detected: ${gateType ?? "unknown"} (${simReason}). Stopping watcher.`
        );
        return {
          state: "blocked",
          contractAddress: address,
          gateType,
          walletAddress: fromAddress,
          attempts,
          elapsedMs: Date.now() - startedAt,
          reason: simReason,
        };
      }
      if (Date.now() - lastGateNotifyAt >= REASON_CHANGE_MIN_INTERVAL_MS) {
        lastGateNotifyAt = Date.now();
        safeNotify(
          `🔄 ${badge} Gate signal: ${simReason} — retrying in ${pollIntervalMs}ms.`
        );
      }
      await sleep(pollIntervalMs);
    }

    if (stopped) {
      safeNotify(`⏹ ${badge} Watcher stopped (${address}).`);
      return {
        state: "stopped",
        contractAddress: address,
        attempts,
        elapsedMs: Date.now() - startedAt,
      };
    }
    safeNotify(
      `⏰ ${badge} Watch window expired for ${address} (${chainName}) after ${Math.round((Date.now() - startedAt) / 1000)}s.`
    );
    return {
      state: "timeout",
      contractAddress: address,
      attempts,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    const reason = shortReason(
      err instanceof Error ? err.message : String(err)
    );
    safeNotify(`❌ ${badge} Watch failed: ${reason}`);
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
    if (remaining.length > 0) activeWatches.set(key, remaining);
    else activeWatches.delete(key);
  }
}
