import { AsyncLocalStorage } from "node:async_hooks";
import type { ChainId } from "./chains.js";

const storage = new AsyncLocalStorage<{ chain: ChainId }>();

export function withChainContext<T>(chain: ChainId, fn: () => T): T {
  return storage.run({ chain }, fn);
}

export function getContextChain(): ChainId | undefined {
  return storage.getStore()?.chain;
}
