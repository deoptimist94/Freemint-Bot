// Multi-chain registry — the single source of truth for Base + Robinhood Chain.
//
// Every chain-specific fact (RPC resolution, explorer, ABI source, NFT API,
// floor ladder, badge) lives here so that scanner / autoLister / portfolio /
// watch / UI only ever branch on a ChainId and read the rest from
// getChainConfig(). Batch 3's /chain toggle and 🌐 button use
// ChainSelection + parseChainSelection on top of this.

import { type Chain } from "viem";
import { base } from "viem/chains";

export type ChainId = "base" | "robinhood";
export type ChainSelection = ChainId | "both";

export const CHAIN_IDS: readonly ChainId[] = ["base", "robinhood"] as const;

function alchemyApiKey(): string {
  return (process.env.ALCHEMY_API_KEY || "").trim();
}

// --- RPC resolution ---------------------------------------------------------

// Prefer explicit BASE_RPC_URL, then Alchemy (same key as the NFT API), then
// public Base. Public mainnet.base.org rate-limits eth_call hard — that was
// the "RPC Request failed" issue.
export function resolveBaseRpcUrl(): string {
  const explicit = (process.env.BASE_RPC_URL || "").trim();
  if (explicit) return explicit;
  const alchemy = alchemyApiKey();
  if (alchemy) return `https://base-mainnet.g.alchemy.com/v2/${alchemy}`;
  return "https://mainnet.base.org";
}

// Robinhood Chain has NO public free RPC — an Alchemy key with the Robinhood
// network enabled (or an explicit ROBINHOOD_RPC_URL) is required. Throwing a
// clear error here (instead of silently falling back to Base) keeps misconfig
// obvious at the first Robinhood call rather than mid-mint.
export function resolveRobinhoodRpcUrl(): string {
  const explicit = (process.env.ROBINHOOD_RPC_URL || "").trim();
  if (explicit) return explicit;
  const alchemy =
    (process.env.ROBINHOOD_ALCHEMY_API_KEY || "").trim() || alchemyApiKey();
  if (alchemy) return `https://robinhood-mainnet.g.alchemy.com/v2/${alchemy}`;
  throw new Error(
    "Robinhood Chain RPC is not configured. Set ROBINHOOD_RPC_URL, or enable the Robinhood network in your Alchemy app and set ROBINHOOD_ALCHEMY_API_KEY (or reuse ALCHEMY_API_KEY)."
  );
}

// --- Server-wide default chain ----------------------------------------------

export function getDefaultChainId(): ChainId {
  const raw = (process.env.CHAIN || "").trim().toLowerCase();
  if (raw === "robinhood" || raw === "rh" || raw === "hood") return "robinhood";
  return "base";
}

export function parseChainSelection(input: string): ChainSelection {
  const raw = (input || "").trim().toLowerCase();
  if (raw === "both" || raw === "all" || raw === "2") return "both";
  if (raw === "robinhood" || raw === "rh" || raw === "hood") return "robinhood";
  return "base";
}

export function selectionToChains(selection: ChainSelection): ChainId[] {
  return selection === "both" ? [...CHAIN_IDS] : [selection];
}

// --- viem chain objects ------------------------------------------------------

// Same shape the repo already used for Base (spread of viem's `base` with the
// RPC URLs overridden) so nothing downstream changes.
export const baseViemChain: Chain = {
  ...base,
  rpcUrls: {
    default: {
      http: [resolveBaseRpcUrl()],
    },
  },
};

// Robinhood Chain (chainId 46630, native ETH). No public free RPC exists, so
// rpcUrls carries only metadata; the real transport is built per call from
// resolveRobinhoodRpcUrl() in chain.ts's getPublicClient/getWalletClient.
export const robinhoodViemChain: Chain = {
  id: 46630,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: ["https://robinhoodchain.blockscout.com"],
    },
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://robinhoodchain.blockscout.com",
    },
  },
};

// --- Chain registry ----------------------------------------------------------

export type AbiSource =
  | {
      type: "etherscanV2";
      apiUrl: string;
      chainParam: number;
      apiKeyEnv: string;
    }
  | {
      type: "blockscout";
      apiUrl: string;
    };

export interface ChainConfig {
  id: ChainId;
  chainId: number;
  name: string;
  badge: string;
  resolveRpcUrl: () => string;
  alchemyNetwork: string;
  alchemyNftBase: string;
  abiSource: AbiSource;
  explorerBaseUrl: string;
  explorerApiUrl: string;
  openseaChain: string;
  floorSources: readonly string[];
  reservoirBase?: string;
  viemChain: Chain;
}

export function getChainConfig(chain: ChainId): ChainConfig {
  switch (chain) {
    case "base":
      return {
        id: "base",
        chainId: 8453,
        name: "Base",
        badge: "⛽",
        resolveRpcUrl: resolveBaseRpcUrl,
        alchemyNetwork: "base-mainnet",
        alchemyNftBase: "https://base-mainnet.g.alchemy.com/nft/v3",
        abiSource: {
          type: "etherscanV2",
          apiUrl: "https://api.etherscan.io/v2/api",
          chainParam: 8453,
          apiKeyEnv: "BASESCAN_API_KEY",
        },
        explorerBaseUrl: "https://basescan.org",
        explorerApiUrl: "https://api.basescan.org/api",
        openseaChain: "base",
        floorSources: ["reservoir", "opensea", "alchemy"],
        reservoirBase: "https://api-base.reservoir.tools",
        viemChain: baseViemChain,
      };
    case "robinhood":
      return {
        id: "robinhood",
        chainId: 46630,
        name: "Robinhood Chain",
        badge: "🏹",
        resolveRpcUrl: resolveRobinhoodRpcUrl,
        alchemyNetwork: "robinhood-mainnet",
        alchemyNftBase: "https://robinhood-mainnet.g.alchemy.com/nft/v3",
        abiSource: {
          type: "blockscout",
          apiUrl: "https://robinhoodchain.blockscout.com/api",
        },
        explorerBaseUrl: "https://robinhoodchain.blockscout.com",
        explorerApiUrl: "https://robinhoodchain.blockscout.com/api",
        openseaChain: "robinhood",
        floorSources: ["opensea", "alchemy"],
        viemChain: robinhoodViemChain,
      };
  }
}
