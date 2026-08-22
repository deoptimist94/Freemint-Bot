import { type Address, getAddress, isAddress, formatEther } from "viem";
import { getPublicClient } from "./chain.js";

export interface WhoisReport {
  address: Address;
  isContract: boolean;
  bytecodeSize: number;
  ethBalance: string;
  txCount: number;
  basescanUrl: string;
  notes: string[];
}

export async function lookupWhois(raw: string): Promise<WhoisReport> {
  if (!isAddress(raw)) {
    throw new Error("Invalid address. Expected 0x + 40 hex characters.");
  }

  const address = getAddress(raw);
  const client = getPublicClient();

  const [code, balance, txCount] = await Promise.all([
    client.getBytecode({ address }),
    client.getBalance({ address }),
    client.getTransactionCount({ address }),
  ]);

  const bytecodeSize =
    code && code !== "0x" ? Math.floor((code.length - 2) / 2) : 0;
  const isContract = bytecodeSize > 0;
  const notes: string[] = [];

  if (isContract) {
    notes.push(`On-chain contract bytecode ~${bytecodeSize} bytes`);
  } else {
    notes.push("EOA (no contract code at this address)");
  }
  if (txCount === 0) notes.push("No outbound transactions from this address");
  if (balance === 0n) notes.push("Zero ETH balance");

  return {
    address,
    isContract,
    bytecodeSize,
    ethBalance: Number(formatEther(balance)).toFixed(6),
    txCount,
    basescanUrl: `https://basescan.org/address/${address}`,
    notes,
  };
}

export function formatWhoisReport(r: WhoisReport): string {
  let t = `🔎 **Whois**\n\n`;
  t += `Address: \`${r.address}\`\n`;
  t += `Type: ${r.isContract ? "📄 Contract" : "👤 EOA"}\n`;
  if (r.isContract) t += `Bytecode: ~${r.bytecodeSize} bytes\n`;
  t += `ETH Balance: \`${r.ethBalance}\` ETH\n`;
  t += `Nonce / tx count: \`${r.txCount}\`\n`;
  t += `Basescan: [open](${r.basescanUrl})\n`;
  if (r.notes.length > 0) {
    t += `\n**Notes:**\n`;
    for (const n of r.notes) t += `• ${n}\n`;
  }
  return t;
}
