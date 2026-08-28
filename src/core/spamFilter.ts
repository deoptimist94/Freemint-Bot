// src/core/spamFilter.ts
//
// Discovery quality gate — filters "free mint" candidates that are actually
// UnlimitedMint-style spam farms before any alert / simulation / auto-mint.
//
// Kill rules (each is sufficient on its own):
//   1. Deployer is a known spam-farm wallet (built-in list + SPAM_DEPLOYERS env)
//   2. Verified contract name matches a spam template (e.g. "UnlimitedMintNFT")
//   3. Template fingerprint: verified ERC721 with a bare mint() and NONE of the
//      guardrail functions a real collection exposes (supply cap, price, pause,
//      withdraw, metadata control, allowlist)
//   4. Contract older than SPAM_MAX_AGE_DAYS (default 7) — "NEW FREE MINT" means
//      newly deployed; old contracts with a perpetual free mint() are farms.
//
// Metadata (name / deployer / creation time) comes from Blockscout v2 — public,
// no API key. All lookups fail OPEN: an indexer hiccup never blocks a real drop.

import type { ChainId } from "./chains.js";
import type { ScanResult } from "./scanner.js";
import { readFile, writeFile } from "node:fs/promises";

export interface SpamVerdict {
  isSpam: boolean;
  reason?: string;
}

const DEFAULT_MAX_AGE_DAYS = 2;

// Deployers observed deploying UnlimitedMintNFT spam farms on Base
// (verified 2026-08-24 across 5 flagged contracts).
const KNOWN_SPAM_DEPLOYERS = new Set([
  "0x11315cce8f009e4cb4234ffeaf2e860b84e5b0f6",
  "0x31b6aac6220806251c5019077a911fb348590cb4",
]);

const SPAM_NAME_PATTERNS: RegExp[] = [
  /unlimited\s?mint/i,
  /basenft/i,
  /free\s?mint\s?farm/i,
];

// A REAL free-mint collection virtually always exposes at least one of these.
// UnlimitedMint-style templates expose none of them.
const FARM_GUARDRAILS: RegExp[] = [
  /maxsupply/i,
  /supplycap/i,
  /mintprice/i,
  /setprice/i,
  /price/i,
  /paused/i,
  /setpaused/i,
  /pause$/i,
  /withdraw/i,
  /rescue/i,
  /setbaseuri/i,
  /seturi/i,
  /mintlimit/i,
  /maxperwallet/i,
  /allowlist/i,
  /whitelist/i,
  /merkle/i,
  /signature/i,
  /deadline/i,
];

const BARE_MINT_SELECTOR = "0x1249c58b"; // mint()
const BS_TIMEOUT_MS = 8_000;
const MAX_CACHE = 1000;

interface ContractMeta {
  name?: string;
  creator?: string;
  creationTxHash?: string;
  createdMs?: number;
}

const metaCache = new Map<string, ContractMeta>();
const VERDICT_TTL_MS = 24 * 60 * 60 * 1000;
const verdictCache = new Map<string, { expiresAt: number; permanent: boolean; verdict: SpamVerdict }>();
let verdictCacheLoaded = false;

async function loadVerdictCache(): Promise<void> {
  if (verdictCacheLoaded) return;
  verdictCacheLoaded = true;
  try {
    const raw = JSON.parse(await readFile(".freemint-spam-cache.json", "utf8")) as Record<string, { expiresAt?: number; permanent?: boolean; verdict: SpamVerdict }>;
    for (const [key, value] of Object.entries(raw)) {
      if (value.permanent || (value.expiresAt ?? 0) > Date.now()) {
        verdictCache.set(key, { expiresAt: value.expiresAt ?? Number.MAX_SAFE_INTEGER, permanent: value.permanent ?? false, verdict: value.verdict });
      }
    }
  } catch {
    // A missing or corrupt local cache should never block discovery.
  }
}

async function cacheVerdict(key: string, verdict: SpamVerdict): Promise<void> {
  const permanent = verdict.isSpam;
  verdictCache.set(key, { expiresAt: permanent ? Number.MAX_SAFE_INTEGER : Date.now() + VERDICT_TTL_MS, permanent, verdict });
  try {
    const serialized = Object.fromEntries(verdictCache.entries());
    await writeFile(".freemint-spam-cache.json", JSON.stringify(serialized), "utf8");
  } catch {
    // Cache persistence is best effort.
  }
}

// --- env config ------------------------------------------------------------

function maxAgeDays(): number {
  const raw = Number(process.env.SPAM_MAX_AGE_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_AGE_DAYS;
}

function envSpamDeployers(): Set<string> {
  const raw = (process.env.SPAM_DEPLOYERS || "").trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

// --- helpers ---------------------------------------------------------------

function blockscoutBaseUrl(chain: ChainId): string {
  return chain === "robinhood"
    ? "https://robinhoodchain.blockscout.com"
    : "https://base.blockscout.com";
}

async function bsJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BS_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Blockscout HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function abiFunctionNames(abi: ScanResult["abi"]): string[] {
  if (!abi || !Array.isArray(abi)) return [];
  const names: string[] = [];
  for (const item of abi) {
    const fn = item as { type?: string; name?: string };
    if (
      fn &&
      typeof fn === "object" &&
      fn.type === "function" &&
      typeof fn.name === "string"
    ) {
      names.push(fn.name);
    }
  }
  return names;
}

function runtimeHasSelector(
  bytecode: string | null,
  selector: string
): boolean {
  if (!bytecode) return false;
  return bytecode.toLowerCase().includes(selector.slice(2).toLowerCase());
}

function parseIsoTimestamp(ts: string): number | undefined {
  // Blockscout emits microseconds; normalize to the 3 digits JS guarantees.
  const normalized = ts.replace(/\.(\d{3})\d+Z$/, ".$1Z");
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? undefined : parsed;
}

async function fetchContractMeta(
  address: string,
  chain: ChainId
): Promise<ContractMeta> {
  const key = `${chain}:${address.toLowerCase()}`;
  const cached = metaCache.get(key);
  if (cached) return cached;

  let meta: ContractMeta = {};
  try {
    const res = await bsJson(
      `${blockscoutBaseUrl(chain)}/api/v2/addresses/${address}`
    );
    meta = {
      name: typeof res?.name === "string" ? res.name : undefined,
      creator:
        typeof res?.creator_address_hash === "string"
          ? res.creator_address_hash
          : undefined,
      creationTxHash:
        typeof res?.creation_transaction_hash === "string"
          ? res.creation_transaction_hash
          : undefined,
    };
  } catch {
    // fail open
  }

  if (metaCache.size >= MAX_CACHE) metaCache.clear();
  metaCache.set(key, meta);
  return meta;
}

async function resolveCreationTime(
  meta: ContractMeta,
  chain: ChainId
): Promise<number | undefined> {
  if (meta.createdMs !== undefined) return meta.createdMs;
  if (!meta.creationTxHash) return undefined;
  try {
    const res = await bsJson(
      `${blockscoutBaseUrl(chain)}/api/v2/transactions/${meta.creationTxHash}`
    );
    if (typeof res?.timestamp === "string") {
      meta.createdMs = parseIsoTimestamp(res.timestamp);
    }
  } catch {
    // fail open
  }
  return meta.createdMs;
}

// --- main gate -------------------------------------------------------------

export async function evaluateSpamContract(
  scan: ScanResult,
  chain: ChainId
): Promise<SpamVerdict> {
  const address = scan.contractAddress;
  const cacheKey = `${chain}:${address.toLowerCase()}`;
  await loadVerdictCache();
  const cached = verdictCache.get(cacheKey);
  if (cached && (cached.permanent || cached.expiresAt > Date.now())) return cached.verdict;

  const finish = async (verdict: SpamVerdict): Promise<SpamVerdict> => {
    await cacheVerdict(cacheKey, verdict);
    return verdict;
  };

  if (scan.rejectionReason) {
    return finish({ isSpam: true, reason: scan.rejectionReason });
  }

  // 1) Known spam deployer — one cheap Blockscout v2 call.
  const meta = await fetchContractMeta(address, chain);
  const creator = meta.creator?.toLowerCase();
  if (creator) {
    if (KNOWN_SPAM_DEPLOYERS.has(creator)) {
      return finish({
        isSpam: true,
        reason: `deployed by known spam-farm wallet ${meta.creator}`,
      });
    }
    if (envSpamDeployers().has(creator)) {
      return finish({ isSpam: true, reason: "deployer on SPAM_DEPLOYERS blacklist" });
    }
  }

  // 2) Verified contract name matches a spam template.
  const contractName = meta.name || "";
  if (
    contractName &&
    SPAM_NAME_PATTERNS.some((re) => re.test(contractName))
  ) {
    return finish({
      isSpam: true,
      reason: `contract name "${contractName}" matches spam template`,
    });
  }

  // 3) UnlimitedMint farm fingerprint: bare mint() with no guardrails at all.
  const fnNames = abiFunctionNames(scan.abi);
  const hasBareMint = scan.mintFunctions.some(
    (f) => f.selector === BARE_MINT_SELECTOR
  );
  const hasGuardrails = fnNames.some((n) =>
    FARM_GUARDRAILS.some((re) => re.test(n))
  );
  if (
    hasBareMint &&
    !hasGuardrails &&
    runtimeHasSelector(scan.bytecode, BARE_MINT_SELECTOR)
  ) {
    return finish({
      isSpam: true,
      reason:
        "UnlimitedMint farm template: bare mint() with no supply/payment/pause guardrails",
    });
  }

  // 4) Age gate: only NEWLY deployed contracts qualify as "new free mints".
  if (meta.creationTxHash) {
    const createdMs = await resolveCreationTime(meta, chain);
    if (createdMs !== undefined) {
      const ageDays = (Date.now() - createdMs) / 86_400_000;
      const limit = maxAgeDays();
      if (ageDays > limit) {
        return finish({
          isSpam: true,
          reason: `contract deployed ${ageDays.toFixed(1)} days ago (limit ${limit}) — not a new free mint`,
        });
      }
    }
  }

  return finish({ isSpam: false });
}
