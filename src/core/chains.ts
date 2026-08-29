import { type Chain } from "viem";
import { base } from "viem/chains";
import { getContextChain } from "./chainContext.js";

export type ChainId = "base" | "robinhood";
export type ChainSelection = ChainId | "both";

export const CHAIN_IDS: readonly ChainId[] = ["base", "robinhood"] as const;

function alchemyBaseKey(): string {
  return (process.env.ALCHEMY_BASE_API_KEY || "").trim();
}

function alchemyRobinhoodKey(): string {
  return (process.env.ALCHEMY_ROBINHOOD_API_KEY || "").trim();
}

export function resolveBaseRpcUrl(): string {
  const key = alchemyBaseKey();
  return key
    ? `https://base-mainnet.g.alchemy.com/v2/${key}`
    : "https://mainnet.base.org";
}

export function resolveRobinhoodRpcUrl(): string {
  const key = alchemyRobinhoodKey();
  return key
    ? `https://robinhood-mainnet.g.alchemy.com/v2/${key}`
    : "https://robinhoodchain.blockscout.com";
}

export function getDefaultChainId(): ChainId {
  const ctx = getContextChain();
  if (ctx) return ctx;
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

export const baseViemChain: Chain = {
  ...base,
  rpcUrls: {
    default: { http: [resolveBaseRpcUrl()] },
    public: { http: ["https://mainnet.base.org"] },
  },
};

export const robinhoodViemChain: Chain = {
  id: 46630,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [resolveRobinhoodRpcUrl()] },
    public: { http: ["https://robinhoodchain.blockscout.com"] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
};

export type AbiSource =
  | { type: "etherscanV2"; apiUrl: string; chainParam: number; apiKeyEnv: string }
  | { type: "blockscout"; apiUrl: string };

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
