import {
  createWalletClient,
  http,
  createPublicClient,
  type Address,
  type Hex,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

export type { Hex, Address };

export const BASE_CHAIN_ID = 8453;

// Prefer explicit BASE_RPC_URL, then Alchemy (same key as NFT API), then public Base.
// Public mainnet.base.org rate-limits eth_call hard — that was the "RPC Request failed".
export function getBaseRpcUrl(): string {
  const explicit = (process.env.BASE_RPC_URL || "").trim();
  if (explicit) return explicit;
  const alchemy = (process.env.ALCHEMY_API_KEY || "").trim();
  if (alchemy) return `https://base-mainnet.g.alchemy.com/v2/${alchemy}`;
  return "https://mainnet.base.org";
}

export const baseChain: Chain = {
  ...base,
  rpcUrls: {
    default: {
      http: [getBaseRpcUrl()],
    },
  },
};

export function getPublicClient() {
  return createPublicClient({
    chain: baseChain,
    transport: http(getBaseRpcUrl(), {
      timeout: 20_000,
      retryCount: 2,
      retryDelay: 400,
    }),
  });
}

export function getWalletClient(privateKey: Hex) {
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({
    account,
    chain: baseChain,
    transport: http(getBaseRpcUrl(), {
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
