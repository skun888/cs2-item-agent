import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fetch as undiciFetch, ProxyAgent } from "undici";

import { readConfig, requireSteamDtApiKey } from "../src/config/env.js";
import { SteamInventoryClient } from "../src/adapters/steam-inventory/client.js";

interface ApiSummary {
  readonly label: string;
  readonly endpoint: string;
  readonly httpStatus?: number;
  readonly elapsedMs: number;
  readonly envelopeSuccess: boolean;
  readonly providerCode?: string | number;
  readonly providerMessage?: string;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly transportError?: string;
}

const config = readConfig();
const apiKey = requireSteamDtApiKey(config);
const customCode = readOption("--custom-code");
const database = new DatabaseSync(config.databasePath, { readOnly: true });

try {
  let sample = database.prepare(`
    SELECT assets.inspect_link, assets.paint_wear, assets.paint_seed, assets.paint_index
    FROM inventory_assets assets
    JOIN inventory_snapshots snapshots ON snapshots.id = assets.snapshot_id
    WHERE assets.inspect_link IS NOT NULL AND assets.inspect_link <> ''
    ORDER BY snapshots.observed_at DESC, assets.paint_wear IS NOT NULL DESC
    LIMIT 1
  `).get() as Readonly<Record<string, unknown>> | undefined;

  let steamSampleSource = "local Steam public-inventory snapshot";
  let liveSteamSummary: Readonly<Record<string, unknown>> | undefined;
  if (!sample || typeof sample.inspect_link !== "string") {
    const stored = database.prepare(`
      SELECT assets.raw_json, assets.paint_wear, assets.paint_seed, assets.paint_index, snapshots.steam_id
      FROM inventory_assets assets
      JOIN inventory_snapshots snapshots ON snapshots.id = assets.snapshot_id
      WHERE assets.raw_json LIKE '%propid:6%'
        AND assets.raw_json LIKE '%asset_accessories%'
        AND assets.market_hash_name LIKE '%|%'
      ORDER BY assets.paint_index IS NOT NULL DESC, snapshots.observed_at DESC
      LIMIT 1
    `).get() as Readonly<Record<string, unknown>> | undefined;
    const recovered = stored && typeof stored.raw_json === "string" && typeof stored.steam_id === "string"
      ? recoverStoredSteamInspectLink(stored.raw_json, stored.steam_id)
      : undefined;
    if (recovered) {
      sample = {
        inspect_link: recovered,
        paint_wear: stored?.paint_wear,
        paint_seed: stored?.paint_seed,
        paint_index: stored?.paint_index,
      };
      steamSampleSource = "stored Steam public-inventory item certificate";
    }
  }
  if (!sample || typeof sample.inspect_link !== "string") {
    const account = database.prepare(`
      SELECT steam_id
      FROM inventory_snapshots
      ORDER BY observed_at DESC
      LIMIT 1
    `).get() as Readonly<Record<string, unknown>> | undefined;
    if (!account || typeof account.steam_id !== "string") {
      throw new Error("No monitored public SteamID is available for a live Steam inventory audit.");
    }
    const inventory = await new SteamInventoryClient({
      baseUrl: config.steamCommunityBaseUrl,
      ...(config.steamProxyUrl ? { proxyUrl: config.steamProxyUrl } : {}),
    }).getCs2Inventory(account.steam_id);
    const asset = inventory.assets.find((candidate) => candidate.inspectLink);
    liveSteamSummary = {
      status: inventory.status,
      complete: inventory.complete,
      returnedAssetCount: inventory.assets.length,
      totalInventoryCount: inventory.totalInventoryCount ?? null,
      pageCount: inventory.pageCount,
      inspectableAssetCount: inventory.assets.filter((candidate) => candidate.inspectLink).length,
      itemCertificateCount: inventory.assets.filter((candidate) => candidate.itemCertificate).length,
    };
    if (asset?.inspectLink) {
      sample = {
        inspect_link: asset.inspectLink,
        paint_wear: asset.paintWear,
        paint_seed: asset.paintSeed,
        paint_index: asset.paintIndex,
      };
      steamSampleSource = "live Steam public-inventory response";
    }
  }
  let steamMarketSummary: Readonly<Record<string, unknown>> | undefined;
  if (!sample || typeof sample.inspect_link !== "string") {
    const marketItem = database.prepare(`
      SELECT assets.market_hash_name
      FROM inventory_assets assets
      JOIN inventory_snapshots snapshots ON snapshots.id = assets.snapshot_id
      WHERE assets.market_hash_name IS NOT NULL
        AND assets.market_hash_name LIKE '%|%'
        AND assets.marketable = 1
        AND COALESCE(assets.commodity, 0) = 0
      ORDER BY snapshots.observed_at DESC
      LIMIT 1
    `).get() as Readonly<Record<string, unknown>> | undefined;
    if (!marketItem || typeof marketItem.market_hash_name !== "string") {
      throw new Error("No non-commodity marketable CS2 skin is available for a Steam market sample.");
    }
    const market = await fetchSteamMarketInspectLink(marketItem.market_hash_name);
    steamMarketSummary = market.summary;
    if (!market.inspectLink) {
      throw new Error(`Steam market audit returned HTTP ${market.summary.httpStatus ?? "unknown"} but no inspectable listing action.`);
    }
    sample = { inspect_link: market.inspectLink };
    steamSampleSource = "live Steam Community Market listing response";
  }

  const asmd = parseAsmd(sample.inspect_link);
  const report: Record<string, unknown> = {
    auditedAt: new Date().toISOString(),
    privacy: "SteamID, asset ID, inspect token, inspect URL and API key are redacted.",
    steamSample: {
      source: steamSampleSource,
      inspectLinkKind: asmd?.kind ?? "masked-item-certificate",
      hasExactWearFromSteam: typeof sample.paint_wear === "number",
      hasPaintSeedFromSteam: typeof sample.paint_seed === "number",
      hasPaintIndexFromSteam: typeof sample.paint_index === "number",
      sampleFingerprint: createHash("sha256").update(sample.inspect_link).digest("hex").slice(0, 12),
    },
    ...(liveSteamSummary ? { liveSteam: liveSteamSummary } : {}),
    ...(steamMarketSummary ? { steamMarket: steamMarketSummary } : {}),
    calls: [] as ApiSummary[],
    limitations: [
      "No notifyUrl was supplied because a local-only agent has no public callback endpoint and must not send inventory payloads to an unrelated third party.",
      "Inspect calls consume SteamDT's documented daily quota; this audit intentionally avoids duplicate retries.",
    ],
  };
  const calls = report.calls as ApiSummary[];

  calls.push(await request("real-v1-wear", "/open/cs2/v1/wear", jsonBody({ inspectUrl: sample.inspect_link })));
  calls.push(await request("real-v1-inspect", "/open/cs2/v1/inspect", jsonBody({ inspectUrl: sample.inspect_link })));

  const realMaskedCode = extractMaskedCode(sample.inspect_link);
  if (asmd) {
    const asmdBody = exactAsmdJson(asmd);
    calls.push(await request("real-v2-wear", "/open/cs2/v2/wear", asmdBody));
    calls.push(await request("real-v2-inspect", "/open/cs2/v2/inspect", asmdBody));
  } else if (realMaskedCode) {
    const certificateBody = jsonBody({ s: 0, m: 0, a: 0, d: realMaskedCode });
    const firstWear = await request("real-certificate-v2-wear", "/open/cs2/v2/wear", certificateBody);
    calls.push(firstWear);
    if (isPending(firstWear)) {
      await delay(5_000);
      calls.push(await request("real-certificate-v2-wear-poll", "/open/cs2/v2/wear", certificateBody));
    }
    calls.push(await request("real-certificate-v2-inspect", "/open/cs2/v2/inspect", certificateBody));
    report.v2Asmd = "tested current Steam item certificate as d with s/m/a set to zero";
  } else {
    report.v2Asmd = "not applicable: current Steam response uses a self-encoded item certificate and exposes no S/M/A/D tuple";
  }

  if (customCode) {
    const inspectUrl = toMaskedInspectLink(customCode);
    calls.push(await request("custom-masked-v1-wear", "/open/cs2/v1/wear", jsonBody({ inspectUrl })));
    calls.push(await request("custom-masked-v1-inspect", "/open/cs2/v1/inspect", jsonBody({ inspectUrl })));
    const normalizedCustomCode = extractMaskedCode(inspectUrl);
    if (normalizedCustomCode) {
      const customV2Body = jsonBody({ s: 0, m: 0, a: 0, d: normalizedCustomCode });
      const firstWear = await request("custom-certificate-v2-wear", "/open/cs2/v2/wear", customV2Body);
      calls.push(firstWear);
      if (isPending(firstWear)) {
        await delay(5_000);
        calls.push(await request("custom-certificate-v2-wear-poll", "/open/cs2/v2/wear", customV2Body));
      }
      calls.push(await request("custom-certificate-v2-inspect", "/open/cs2/v2/inspect", customV2Body));
    }
  } else {
    report.customMaskedCode = "not tested; pass --custom-code to include the DIY path";
  }

  console.log(JSON.stringify(report, null, 2));
} finally {
  database.close();
}

async function request(label: string, endpoint: string, body: string): Promise<ApiSummary> {
  const started = Date.now();
  try {
    const response = await fetch(`${config.steamDtBaseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "cs2-item-agent-inspect-audit/0.1",
      },
      body,
      signal: AbortSignal.timeout(45_000),
    });
    const payload: unknown = await response.json().catch(() => undefined);
    return summarize(label, endpoint, response.status, Date.now() - started, payload);
  } catch (error) {
    return {
      label,
      endpoint,
      elapsedMs: Date.now() - started,
      envelopeSuccess: false,
      transportError: error instanceof Error ? error.message : "unknown transport error",
    };
  }
}

function summarize(label: string, endpoint: string, httpStatus: number, elapsedMs: number, payload: unknown): ApiSummary {
  if (!isRecord(payload)) {
    return { label, endpoint, httpStatus, elapsedMs, envelopeSuccess: false, providerMessage: "non-object response" };
  }
  const success = payload.success === true;
  const code = scalar(payload.errorCode ?? payload.code);
  const message = text(payload.errorMsg ?? payload.errorMessage ?? payload.message ?? payload.msg);
  return {
    label,
    endpoint,
    httpStatus,
    elapsedMs,
    envelopeSuccess: success,
    ...(code !== undefined ? { providerCode: code } : {}),
    ...(message ? { providerMessage: message } : {}),
    ...(isRecord(payload.data) ? { data: summarizeData(payload.data) } : {}),
  };
}

function summarizeData(data: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const screenshot = isRecord(data.screenshot) ? data.screenshot : undefined;
  const screenshots = screenshot && isRecord(screenshot.screenshots) ? screenshot.screenshots : undefined;
  const item = isRecord(data.itemPreviewData) ? data.itemPreviewData : undefined;
  return {
    keys: Object.keys(data).sort(),
    ...(typeof data.sync === "boolean" ? { sync: data.sync } : {}),
    ...(typeof data.success === "boolean" ? { success: data.success } : {}),
    hasTaskId: typeof data.taskId === "string" && data.taskId.length > 0,
    hasScreenshotObject: Boolean(screenshot),
    ...(screenshot ? {
      screenshotKeys: Object.keys(screenshot).sort(),
      hasFingerprint: typeof screenshot.fingerprint === "string" && screenshot.fingerprint.length > 0,
      hasProtoEncodeStr: typeof screenshot.protoEncodeStr === "string" && screenshot.protoEncodeStr.length > 0,
      ...(typeof screenshot.existSticker === "boolean" ? { existSticker: screenshot.existSticker } : {}),
      screenshotFieldShapes: {
        front: arrayShape(screenshots?.front),
        back: arrayShape(screenshots?.back),
        detail: arrayShape(screenshots?.detail),
      },
    } : {}),
    screenshotCounts: {
      front: urlCount(screenshots?.front),
      back: urlCount(screenshots?.back),
      detail: urlCount(screenshots?.detail),
    },
    hasItemPreviewData: Boolean(item),
    ...(item ? {
      itemPreviewKeys: Object.keys(item).sort(),
      stickerCount: Array.isArray(item.stickers) ? item.stickers.length : 0,
      hasDefIndex: finite(item.defindex),
      hasPaintIndex: finite(item.paintindex),
      hasPaintWear: finite(item.paintwear) || typeof item.floatWear === "string",
      hasPaintSeed: finite(item.paintseed),
    } : {}),
  };
}

function parseAsmd(inspectLink: string): { readonly kind: "S" | "M"; readonly s: string; readonly m: string; readonly a: string; readonly d: string } | undefined {
  const decoded = decodeURIComponent(inspectLink);
  const match = /([SM])(\d+)A(\d+)D(\d+)/.exec(decoded);
  if (!match) return undefined;
  const kind = match[1] as "S" | "M";
  return { kind, s: kind === "S" ? match[2]! : "0", m: kind === "M" ? match[2]! : "0", a: match[3]!, d: match[4]! };
}

function recoverStoredSteamInspectLink(rawJson: string, steamId: string): string | undefined {
  const raw: unknown = JSON.parse(rawJson);
  if (!isRecord(raw) || !isRecord(raw.asset) || !isRecord(raw.description) || !isRecord(raw.assetProperties)) return undefined;
  const assetId = text(raw.asset.assetid);
  const actions = Array.isArray(raw.description.actions) ? raw.description.actions : [];
  const properties = Array.isArray(raw.assetProperties.asset_properties) ? raw.assetProperties.asset_properties : [];
  const values = new Map<number, string>();
  for (const value of properties) {
    if (!isRecord(value) || !finite(value.propertyid)) continue;
    const propertyValue = text(value.string_value) ?? scalar(value.int_value) ?? scalar(value.float_value);
    if (propertyValue !== undefined) values.set(Number(value.propertyid), String(propertyValue));
  }
  for (const action of actions) {
    if (!isRecord(action) || typeof action.link !== "string" || !action.link.includes("csgo_econ_action_preview")) continue;
    const resolved = action.link
      .replaceAll("%owner_steamid%", steamId)
      .replaceAll("%assetid%", assetId ?? "")
      .replace(/%propid:(\d+)%/g, (placeholder, id: string) => values.get(Number(id)) ?? placeholder);
    if (!/%(?:owner_steamid|assetid|propid:\d+)%/.test(resolved)) return resolved;
  }
  return undefined;
}

function exactAsmdJson(asmd: { readonly s: string; readonly m: string; readonly a: string; readonly d: string }): string {
  for (const value of [asmd.s, asmd.m, asmd.a, asmd.d]) {
    if (!/^\d+$/.test(value)) throw new Error("ASMD values must contain digits only.");
  }
  return `{"s":${asmd.s},"m":${asmd.m},"a":${asmd.a},"d":"${asmd.d}"}`;
}

function toMaskedInspectLink(input: string): string {
  let code = input.trim();
  const marker = "csgo_econ_action_preview";
  const index = code.indexOf(marker);
  if (index >= 0) code = code.slice(index + marker.length).trim();
  if (!/^[0-9a-f]+$/i.test(code)) throw new Error("--custom-code must be a masked hexadecimal inspect code.");
  return `steam://rungame/730/76561202255233023/+csgo_econ_action_preview ${code.toUpperCase()}`;
}

function extractMaskedCode(inspectLink: string): string | undefined {
  const decoded = decodeURIComponent(inspectLink);
  const marker = "csgo_econ_action_preview";
  const index = decoded.indexOf(marker);
  if (index < 0) return undefined;
  const suffix = decoded.slice(index + marker.length).trim();
  return /^[0-9a-f]+$/i.test(suffix) ? suffix.toUpperCase() : undefined;
}

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() || undefined : undefined;
}

function jsonBody(value: unknown): string { return JSON.stringify(value); }
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function scalar(value: unknown): string | number | undefined { return typeof value === "string" || typeof value === "number" ? value : undefined; }
function finite(value: unknown): boolean { return typeof value === "number" && Number.isFinite(value); }
function urlCount(value: unknown): number { return Array.isArray(value) ? value.filter((entry) => typeof entry === "string" && /^https?:\/\//.test(entry)).length : 0; }
function isPending(result: ApiSummary): boolean { return result.envelopeSuccess && result.data?.sync === false && result.data?.hasTaskId === true; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function arrayShape(value: unknown): Readonly<Record<string, unknown>> {
  if (!Array.isArray(value)) return { type: typeof value, length: null };
  return {
    type: "array",
    length: value.length,
    nonEmptyStringCount: value.filter((entry) => typeof entry === "string" && entry.length > 0).length,
    httpUrlCount: urlCount(value),
    entryTypes: [...new Set(value.map((entry) => Array.isArray(entry) ? "array" : entry === null ? "null" : typeof entry))],
  };
}

async function fetchSteamMarketInspectLink(marketHashName: string): Promise<{
  readonly inspectLink?: string;
  readonly summary: Readonly<Record<string, unknown>>;
}> {
  const url = new URL(`${config.steamCommunityBaseUrl}/market/listings/730/${encodeURIComponent(marketHashName)}/render/`);
  url.searchParams.set("query", "");
  url.searchParams.set("start", "0");
  url.searchParams.set("count", "10");
  url.searchParams.set("currency", "23");
  url.searchParams.set("language", "english");
  url.searchParams.set("format", "json");
  const dispatcher = config.steamProxyUrl ? new ProxyAgent(config.steamProxyUrl) : undefined;
  const response = await undiciFetch(url, {
    headers: { Accept: "application/json", "User-Agent": "cs2-item-agent-inspect-audit/0.1" },
    signal: AbortSignal.timeout(30_000),
    ...(dispatcher ? { dispatcher } : {}),
  });
  const payload: unknown = await response.json().catch(() => undefined);
  if (!isRecord(payload)) return { summary: { httpStatus: response.status, objectResponse: false } };
  const listingInfo = isRecord(payload.listinginfo) ? payload.listinginfo : {};
  const appAssets = isRecord(payload.assets) && isRecord(payload.assets["730"]) ? payload.assets["730"] : {};
  const contextAssets = isRecord(appAssets["2"]) ? appAssets["2"] : {};
  for (const [listingId, rawListing] of Object.entries(listingInfo)) {
    if (!isRecord(rawListing) || !isRecord(rawListing.asset)) continue;
    const assetId = text(rawListing.asset.id);
    if (!assetId) continue;
    const description = isRecord(contextAssets[assetId]) ? contextAssets[assetId] : undefined;
    const actions = description && Array.isArray(description.actions) ? description.actions : [];
    for (const action of actions) {
      if (!isRecord(action) || typeof action.link !== "string" || !action.link.includes("csgo_econ_action_preview")) continue;
      const inspectLink = action.link.replaceAll("%listingid%", listingId).replaceAll("%assetid%", assetId);
      return {
        inspectLink,
        summary: {
          httpStatus: response.status,
          success: payload.success === true,
          listingCount: Object.keys(listingInfo).length,
          assetDescriptionCount: Object.keys(contextAssets).length,
          hasInspectAction: true,
        },
      };
    }
  }
  return {
    summary: {
      httpStatus: response.status,
      success: payload.success === true,
      listingCount: Object.keys(listingInfo).length,
      assetDescriptionCount: Object.keys(contextAssets).length,
      hasInspectAction: false,
    },
  };
}
