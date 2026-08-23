import {
  createWalletClient,
  http,
  createPublicClient,
  type Address,
  type Hex,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  baseViemChain,
  robinhoodViemChain,
  getChainConfig,
  getDefaultChainId,
  resolveBaseRpcUrl,
  resolveRobinhoodRpcUrl,
  type ChainId,
  type ChainSelection,
} from "./chains.js";

export type { Hex, Address };
export type { ChainId, ChainSelection };
export { getDefaultChainId, resolveBaseRpcUrl, resolveRobinhoodRpcUrl };

export const BASE_CHAIN_ID = 8453;

// Backward-compatible aliases: existing Base-only callers keep working
// unchanged. The viem Chain objects live in chains.ts (single source of truth).
export const baseChain: Chain = baseViemChain;
export const robinhoodChain: Chain = robinhoodViemChain;

// Per-chain RPC with a clear error when a chain has no RPC configured
// (Robinhood requires ROBINHOOD_RPC_URL or an Alchemy key with Robinhood
// enabled — it has no public free RPC).
export function getRpcUrl(chain: ChainId = "base"): string {
  return getChainConfig(chain).resolveRpcUrl();
}

// Kept as an alias for existing callers; use getRpcUrl("robinhood") for RH.
export function getBaseRpcUrl(): string {
  return resolveBaseRpcUrl();
}

export function getPublicClient(chain?: ChainId) {
  const target = chain ?? getDefaultChainId();
  return createPublicClient({
    chain: getChainConfig(target).viemChain,
    transport: http(getRpcUrl(target), {
      timeout: 20_000,
      retryCount: 2,
      retryDelay: 400,
    }),
  });
}

export function getWalletClient(privateKey: Hex, chain?: ChainId) {
  const target = chain ?? getDefaultChainId();
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({
    account,
    chain: getChainConfig(target).viemChain,
    transport: http(getRpcUrl(target), {
      timeout: 20_000,
      retryCount: 2,
      retryDelay: 400,
    }),
  });
}

export function getAddressFromPrivateKey(privateKey: Hex): Address {
  return privateKeyToAccount(privateKey).address;
}

export function shortenAddress(addr: string, prefix = 4, suffix = 4): string {
  if (!addr || addr.length <= prefix + suffix + 2) return addr;
  return `${addr.slice(0, prefix + 2)}..${addr.slice(-suffix)}`;
}

export function isValidAddress(addr: string): boolean {
  const stripped = addr.startsWith("0x") ? addr.slice(2) : addr;
  return /^[a-fA-F0-9]{40}$/.test(stripped);
}

export function normalizeAddressInput(addr: string): string {
  const stripped = addr.startsWith("0x") ? addr.slice(2) : addr;
  return `0x${stripped.toLowerCase()}`;
}

export function isValidPrivateKey(key: string): boolean {
  const stripped = key.startsWith("0x") ? key.slice(2) : key;
  return /^[a-fA-F0-9]{64}$/.test(stripped);
}

export function normalizePrivateKey(key: string): Hex {
  const stripped = key.startsWith("0x") ? key.slice(2) : key;
  return `0x${stripped.toLowerCase()}` as Hex;
}

export function normalizeAddress(addr: string): string {
  return addr.toLowerCase();
}
