import { AppError } from "../../core/errors.js";
import { fetch as undiciFetch, ProxyAgent } from "undici";

const DEFAULT_STICKERS_URL = "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/stickers.json";

export interface StickerKitCatalogEntry {
  readonly stickerKitId: number;
  readonly marketHashName: string;
  readonly name: string;
  readonly imageUrl?: string;
}

export class CsSchemaClient {
  readonly #url: string;
  readonly #fetch: typeof fetch;

  constructor(options: { readonly url?: string; readonly fetchImpl?: typeof fetch; readonly proxyUrl?: string } = {}) {
    this.#url = options.url ?? DEFAULT_STICKERS_URL;
    this.#fetch = options.fetchImpl ?? createFetch(options.proxyUrl);
  }

  async getStickerKits(): Promise<readonly StickerKitCatalogEntry[]> {
    let response: Response;
    try {
      response = await this.#fetch(this.#url, { signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      throw new AppError("HTTP_ERROR", "CS2 sticker schema request failed.", {
        cause: error instanceof Error ? error.message : "unknown network error",
      });
    }
    if (!response.ok) throw new AppError("HTTP_ERROR", `CS2 sticker schema returned HTTP ${response.status}.`);
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new AppError("CONTRACT_ERROR", "CS2 sticker schema must be an array.");
    return payload.flatMap((value): StickerKitCatalogEntry[] => {
      if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return [];
      const match = /^sticker-(\d+)$/.exec(value.id);
      const marketHashName = typeof value.market_hash_name === "string" ? value.market_hash_name.trim() : value.name.trim();
      if (!match || !marketHashName) return [];
      return [{
        stickerKitId: Number(match[1]),
        marketHashName,
        name: value.name.trim(),
        ...(typeof value.image === "string" && value.image.trim() ? { imageUrl: value.image.trim() } : {}),
      }];
    });
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createFetch(proxyUrl: string | undefined): typeof fetch {
  if (!proxyUrl) return fetch;
  const dispatcher = new ProxyAgent(proxyUrl);
  return ((input: string | URL | Request, init?: RequestInit) =>
    undiciFetch(input as string | URL, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    }) as unknown as Promise<Response>) as typeof fetch;
}
