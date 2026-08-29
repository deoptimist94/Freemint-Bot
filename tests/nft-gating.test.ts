import assert from "node:assert/strict";
import test from "node:test";

import { classifyMintError } from "../src/core/mint.js";
import { analyzeAbiForMintFunctions, evaluateNftEligibility } from "../src/core/scanner.js";
import { encodeErrorResult, parseAbi } from "viem";

test("rejects router-like ERC-20 ABI before minting", () => {
  const result = evaluateNftEligibility({
    abi: [
      { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
      { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
      { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }] },
    ],
    bytecode: "0x1234567890abcdef",
  });

  assert.equal(result.isNft, false);
  assert.match(result.reason ?? "", /ERC-20|router|NFT/i);
});

test("accepts real ERC-721 surface with interface support", () => {
  const result = evaluateNftEligibility({
    abi: [
      { type: "function", name: "supportsInterface", stateMutability: "view", inputs: [{ type: "bytes4" }], outputs: [{ type: "bool" }] },
      { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
      { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
      { type: "function", name: "tokenURI", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "string" }] },
      { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [] },
    ],
    bytecode: "0x00" + "80ac58cd".padEnd(64, "0"),
  });

  assert.equal(result.isNft, true);
  assert.equal(result.reason, undefined);
});

test("blocks administrative setter functions from free-mint scans", () => {
  const functions = analyzeAbiForMintFunctions([
    { type: "function", name: "updateAllowedSeaDrop", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "bool" }] },
    { type: "function", name: "mintPublic", stateMutability: "nonpayable", inputs: [] },
    { type: "function", name: "setBaseURI", stateMutability: "nonpayable", inputs: [{ type: "string" }] },
  ] as any);

  assert.equal(functions.some((fn) => fn.name === "updateAllowedSeaDrop"), false);
  assert.equal(functions.some((fn) => fn.name === "setBaseURI"), false);
  assert.equal(functions.some((fn) => fn.name === "mintPublic"), true);
});

test("maps custom revert bytes to readable mint explanations", () => {
  const data = encodeErrorResult({
    abi: parseAbi(["error MaxSupplyReached()"]),
    functionName: "MaxSupplyReached",
  });
  const info = classifyMintError({ data });
  assert.equal(info.category, "SOLD_OUT");
  assert.match(info.userFriendly, /max supply|sold out/i);
});
