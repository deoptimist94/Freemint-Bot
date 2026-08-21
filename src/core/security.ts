import { getAddress } from "viem";
import { getPublicClient } from "./chain.js";

export interface SecurityReport {
  isSafe: boolean;
  isHoneypot: boolean;
  isDrainer: boolean;
  riskScore: number; // 0 (Clean) to 100 (Dangerous)
  warnings: string[];
}

const GO_PLUS_TIMEOUT_MS = 10_000;

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`GoPlus API HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function auditContractSecurity(contractAddress: string): Promise<SecurityReport> {
  const cleanAddr = getAddress(contractAddress);
  const publicClient = getPublicClient();

  const report: SecurityReport = {
    isSafe: true,
    isHoneypot: false,
    isDrainer: false,
    riskScore: 0,
    warnings: [],
  };

  // 1. Bytecode verification (always required)
  try {
    const bytecode = await publicClient.getBytecode({ address: cleanAddr });
    if (!bytecode || bytecode === "0x") {
      return {
        ...report,
        isSafe: false,
        riskScore: 100,
        warnings: ["No contract bytecode deployed at this address"],
      };
    }
  } catch (err) {
    return {
      ...report,
      isSafe: false,
      riskScore: 100,
      warnings: [
        `Unable to read contract bytecode (RPC error): ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  // 2. GoPlus NFT Security screening (Base = chain 8453).
  //    FAIL-CLOSED: if the indexer is unreachable, the contract is NOT approved.
  let goplusData: any = null;
  try {
    const nftUrl = `https://api.gopluslabs.io/api/v1/nft_security/8453?contract_addresses=${cleanAddr}`;
    const json = await fetchJsonWithTimeout(nftUrl, GO_PLUS_TIMEOUT_MS);
    goplusData = json?.result?.[cleanAddr.toLowerCase()] ?? null;
  } catch (err) {
    return {
      ...report,
      isSafe: false,
      isDrainer: false,
      riskScore: 60,
      warnings: [
        `Security indexer unavailable — FAILED CLOSED (no mint allowed). ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  // 3. If the NFT record is missing, supplement with the token-security record
  //    (catches drainer / hidden-owner signals for collections GoPlus tracks there).
  if (!goplusData) {
    try {
      const tokenUrl = `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${cleanAddr}`;
      const json = await fetchJsonWithTimeout(tokenUrl, GO_PLUS_TIMEOUT_MS);
      goplusData = json?.result?.[cleanAddr.toLowerCase()] ?? null;
    } catch {
      // Non-fatal: the NFT record was already consulted.
    }
  }

  // 4. Apply findings
  if (goplusData) {
    if (goplusData.is_honeypot === "1") {
      report.isHoneypot = true;
      report.isSafe = false;
      report.riskScore = 100;
      report.warnings.push("Identified as Honeypot: restricted transfers/sales detected");
    }

    if (goplusData.cannot_sell_all === "1") {
      report.isHoneypot = true;
      report.isSafe = false;
      report.riskScore = 100;
      report.warnings.push("Cannot sell all: transfer restrictions may trap your NFTs");
    }

    if (goplusData.is_blacklisted === "1") {
      report.isSafe = false;
      report.riskScore = 100;
      report.warnings.push("Contract/collection flagged as blacklisted by GoPlus");
    }

    if (goplusData.is_drainer === "1") {
      report.isDrainer = true;
      report.isSafe = false;
      report.riskScore = 100;
      report.warnings.push("Contract flagged as a drainer (may attempt to steal approvals)");
    }

    if (goplusData.is_transfer_pausable === "1" || goplusData.transfer_pausable === "1") {
      report.riskScore += 25;
      report.warnings.push("Transfer function can be paused by owner");
    }

    if (goplusData.is_proxy === "1") {
      report.riskScore += 15;
      report.warnings.push("Contract is a proxy — implementation may be upgradeable");
    }

    if (goplusData.is_owner_change_balance === "1") {
      report.riskScore += 20;
      report.warnings.push("Owner can modify balances");
    }

    if (goplusData.hidden_owner === "1") {
      report.riskScore += 20;
      report.warnings.push("Hidden contract owner detected");
    }

    if (goplusData.selfdestruct === "1") {
      report.riskScore += 30;
      report.warnings.push("Contract contains self-destruct opcode");
    }

    if (goplusData.is_anti_whale === "1") {
      report.riskScore += 10;
      report.warnings.push("Anti-whale transfer restrictions detected");
    }
  } else {
    // GoPlus responded but has no record for this collection. Not a pass —
    // fresh collections are often untracked; flag it for caution.
    report.riskScore += 10;
    report.warnings.push("GoPlus has no security record for this NFT contract — treat with caution");
  }

  if (report.riskScore >= 50) {
    report.isSafe = false;
  }

  return report;
}
