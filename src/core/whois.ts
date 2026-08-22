import { getAddress } from "viem";
import { getPublicClient } from "./chain.js";

export interface WhoisReport {
  contractAddress: string;
  contractName?: string;
  symbol?: string;
  collectionName?: string;
  externalUrl?: string;
  metadataUrl?: string;
  openseaUrl?: string;
  notes: string[];
}

const METADATA_ABI = [
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function uri(uint256 id) view returns (string)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
] as const;

const FETCH_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url: string, ms: number = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Convert a raw tokenURI into a fetchable URL and/or inline JSON metadata.
function decodeTokenUri(uri: string): { url?: string; json?: any } {
  if (!uri) return {};

  if (uri.startsWith("data:application/json;base64,")) {
    try {
      const json = JSON.parse(Buffer.from(uri.slice(29), "base64").toString("utf8"));
      return { json };
    } catch {
      return {};
    }
  }

  if (uri.startsWith("data:application/json,")) {
    try {
      const json = JSON.parse(decodeURIComponent(uri.slice("data:application/json,".length)));
      return { json };
    } catch {
      return {};
    }
  }

  if (uri.startsWith("ipfs://")) {
    return { url: `https://ipfs.io/ipfs/${uri.slice(7)}` };
  }

  if (uri.startsWith("ar://")) {
    return { url: `https://arweave.net/${uri.slice(5)}` };
  }

  if (/^https?:\/\//i.test(uri)) {
    return { url: uri };
  }

  return {};
}

// Extract useful fields from a decoded metadata JSON object.
function applyMetadataJson(report: WhoisReport, json: any, isTokenLevel: boolean): void {
  if (!json || typeof json !== "object") return;

  if (!report.collectionName) {
    const candidate = json.collection?.name || json.name;
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      report.collectionName = candidate;
    }
  }

  if (!report.externalUrl && typeof json.external_url === "string") {
    report.externalUrl = json.external_url;
  }

  if (isTokenLevel && report.collectionName) {
    report.notes.push(
      `Metadata name may be token-level ("${report.collectionName}") — verify against the explorer`
    );
  }
}

export async function whoisContract(rawAddress: string): Promise<WhoisReport> {
  const ca = getAddress(rawAddress.trim());
  const report: WhoisReport = { contractAddress: ca, notes: [] };
  const client = getPublicClient();

  // 1. name()/symbol() straight from the chain (no explorer needed).
  try {
    const name = (await client.readContract({
      address: ca,
      abi: METADATA_ABI as any,
      functionName: "name",
    })) as string;
    report.contractName = name;
  } catch {
    /* not every NFT implements name() */
  }
  try {
    const symbol = (await client.readContract({
      address: ca,
      abi: METADATA_ABI as any,
      functionName: "symbol",
    })) as string;
    report.symbol = symbol;
  } catch {
    /* ignore */
  }

  // 2. tokenURI / uri metadata (try token 1, then token 0).
  for (const [functionName, id] of [
    ["tokenURI", 1n],
    ["tokenURI", 0n],
    ["uri", 1n],
    ["uri", 0n],
  ] as const) {
    try {
      const uri = (await client.readContract({
        address: ca,
        abi: METADATA_ABI as any,
        functionName,
        args: [id],
      })) as string;

      const decoded = decodeTokenUri(uri);

      // Inline JSON (base64/data URI) — no extra fetch needed.
      if (decoded.json) {
        applyMetadataJson(report, decoded.json, true);
        break;
      }

      if (decoded.url) {
        report.metadataUrl = decoded.url;
        // Fetch the JSON metadata to resolve external_url / collection name.
        try {
          const metaRes = await fetchWithTimeout(decoded.url);
          if (metaRes.ok) {
            const metaJson = await metaRes.json();
            applyMetadataJson(report, metaJson, true);
          }
        } catch {
          report.notes.push(`Metadata fetch failed (${decoded.url})`);
        }
        break;
      }
    } catch {
      /* tokenURI may be unset for unrevealed collections */
    }
  }

  // 3. BaseScan verified contract name (authoritative for the source contract).
  try {
    const apiKey = process.env.BASESCAN_API_KEY || "";
    const res = await fetchWithTimeout(
      `https://api.basescan.org/api?module=contract&action=getsourcecode&address=${ca}&apikey=${apiKey}`
    );
    if (res.ok) {
      const json = (await res.json()) as any;
      const src = json?.result?.[0];
      if (src?.ContractName) {
        report.contractName = src.ContractName;
        if (!report.collectionName) report.collectionName = src.ContractName;
      }
    }
  } catch (err) {
    report.notes.push(`BaseScan lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. OpenSea v2 — resolve slug + marketplace URL (fails soft on rate limits).
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (process.env.OPENSEA_API_KEY) headers["X-API-KEY"] = process.env.OPENSEA_API_KEY;

    const res = await fetchWithTimeout(
      `https://api.opensea.io/api/v2/chain/base/contract/${ca}`,
      6000
    );
    if (res.ok) {
      const json = (await res.json()) as any;

      // `collection` may be a slug string OR a nested object depending on API version.
      if (typeof json?.collection === "string") {
        const slug = json.collection;
        report.openseaUrl = `https://opensea.io/collection/${slug}`;

        if (!report.collectionName && typeof json?.name === "string") {
          report.collectionName = json.name;
        }

        // Enrich with the full collection object (external_url etc.).
        try {
          const colRes = await fetchWithTimeout(
            `https://api.opensea.io/api/v2/collections/${slug}`,
            6000
          );
          if (colRes.ok) {
            const col = (await colRes.json()) as any;
            report.collectionName = report.collectionName ?? col?.name;
            if (!report.externalUrl && typeof col?.external_url === "string") {
              report.externalUrl = col.external_url;
            }
          }
        } catch {
          /* collection details optional */
        }
      } else if (json?.collection && typeof json.collection === "object") {
        const slug = json.collection.slug;
        report.collectionName = report.collectionName ?? json.collection.name;
        report.externalUrl = report.externalUrl ?? json.collection.external_url;
        if (slug) report.openseaUrl = `https://opensea.io/collection/${slug}`;
      }
    }
  } catch {
    /* OpenSea rate limit — skip */
  }

  // 5. Last resort: generic OpenSea asset URL.
  if (!report.openseaUrl) {
    report.openseaUrl = `https://opensea.io/assets/base/${ca}/1`;
  }

  report.notes.push(
    report.collectionName
      ? `Identified project: ${report.collectionName}`
      : "No collection name found — collection may be unrevealed or metadata-only"
  );

  return report;
}
