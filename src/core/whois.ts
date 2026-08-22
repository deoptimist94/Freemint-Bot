import {
  scanContract,
  getBestMintFunction,
  ScanResult,
  MintFunctionInfo,
} from "./scanner.js";
import { normalizeAddressInput, shortenAddress } from "./chain.js";

export interface WhoisReport {
  contractAddress: string;
  isContract: boolean;
  isVerified: boolean;
  isNft: boolean;
  mintFunctions: MintFunctionInfo[];
  bestMint: MintFunctionInfo | null;
  riskScore: number;
  isSafe: boolean;
  isHoneypot: boolean;
  isDrainer: boolean;
  warnings: string[];
  warning?: string;
}

export async function runWhois(rawAddress: string): Promise<WhoisReport> {
  const address = normalizeAddressInput(rawAddress);
  if (!address) throw new Error("Invalid address");

  const result: ScanResult = await scanContract(address);
  const bestMint =
    result.mintFunctions.length > 0
      ? getBestMintFunction(result.mintFunctions)
      : null;

  return {
    contractAddress: result.contractAddress,
    isContract: result.isContract,
    isVerified: result.isVerified,
    isNft: result.mintFunctions.length > 0,
    mintFunctions: result.mintFunctions,
    bestMint,
    riskScore: result.security?.riskScore ?? 0,
    isSafe: result.security?.isSafe ?? false,
    isHoneypot: result.security?.isHoneypot ?? false,
    isDrainer: result.security?.isDrainer ?? false,
    warnings: result.security?.warnings ?? [],
    warning: result.warning,
  };
}

export function formatWhoisReport(report: WhoisReport): string {
  const lines: string[] = [];
  lines.push("📇 WHOIS Report");
  lines.push("──────────────────────────");
  lines.push(`🔤 Contract: ${shortenAddress(report.contractAddress)}`);
  lines.push(`🧾 Verified: ${report.isVerified ? "✅ Yes" : "⚠️ No — source unverified"}`);
  lines.push(`🪙 NFT: ${report.isNft ? "✅ Yes" : "❌ No mint functions found"}`);

  if (report.mintFunctions.length > 0) {
    lines.push("⛏ Mint functions:");
    for (const fn of report.mintFunctions.slice(0, 5)) {
      lines.push(
        `  • ${fn.name}(${fn.args.join(", ")}) — ${
          fn.isFreeMint ? "FREE" : fn.requiresPayment ? "paid" : "unknown"
        }`
      );
    }
    if (report.mintFunctions.length > 5) {
      lines.push(`  … +${report.mintFunctions.length - 5} more`);
    }
  }

  if (report.bestMint) {
    lines.push(`🎯 Best mint: ${report.bestMint.name}(${report.bestMint.args.join(", ")})`);
  }

  lines.push(`🛡 Security: score ${report.riskScore}/100 — ${report.isSafe ? "✅ SAFE" : "⚠️ RISKY"}`);
  if (report.isHoneypot) lines.push("🍯 ⚠️ HONEYPOT detected!");
  if (report.isDrainer) lines.push("🪤 ⚠️ DRAINER detected!");
  if (report.warnings.length > 0) {
    lines.push("⚠️ Warnings:");
    for (const w of report.warnings.slice(0, 4)) lines.push(`  • ${w}`);
  }
  if (report.warning) lines.push(`ℹ️ ${report.warning}`);

  return lines.join("\n");
}
