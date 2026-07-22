import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import sharp from "sharp";

import type { DiyPaletteColor } from "../domain/diy.js";

export interface DiyVisualFeatures {
  readonly localImagePath: string;
  readonly palette: readonly DiyPaletteColor[];
  readonly visualTags: readonly string[];
  readonly brightness: number;
  readonly saturation: number;
  readonly complexity: number;
}

export class DiyImageService {
  readonly #imageDir: string;
  readonly #previewDir: string;
  readonly #fetch: typeof fetch;

  constructor(dataDir: string, fetchImpl: typeof fetch = fetch) {
    this.#imageDir = resolve(dataDir, "diy-images");
    this.#previewDir = resolve(dataDir, "diy-previews");
    this.#fetch = fetchImpl;
  }

  async analyzeRemoteImage(imageUrl: string, key: string): Promise<DiyVisualFeatures> {
    const url = new URL(imageUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("DIY image URL must use HTTP or HTTPS.");
    }
    const response = await this.#fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`DIY image request failed with HTTP ${response.status}.`);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > 8_000_000) throw new Error("DIY image exceeds 8 MB.");
    const input = Buffer.from(await response.arrayBuffer());
    if (input.length > 8_000_000) throw new Error("DIY image exceeds 8 MB.");
    const fileName = `${safeKey(key)}-${createHash("sha256").update(imageUrl).digest("hex").slice(0, 10)}.png`;
    const localImagePath = join(this.#imageDir, fileName);
    await mkdir(dirname(localImagePath), { recursive: true });
    await sharp(input).png().toFile(localImagePath);

    const { data, info } = await sharp(input)
      .ensureAlpha()
      .resize(96, 96, { fit: "inside", withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixels: Array<{ r: number; g: number; b: number }> = [];
    let brightnessSum = 0;
    let saturationSum = 0;
    for (let index = 0; index < data.length; index += info.channels) {
      const alpha = data[index + 3] ?? 255;
      if (alpha < 40) continue;
      const r = data[index] ?? 0;
      const g = data[index + 1] ?? 0;
      const b = data[index + 2] ?? 0;
      pixels.push({ r, g, b });
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      brightnessSum += (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255;
      saturationSum += max === 0 ? 0 : (max - min) / max;
    }
    const brightness = pixels.length ? brightnessSum / pixels.length : 0;
    const saturation = pixels.length ? saturationSum / pixels.length : 0;
    const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
    for (const pixel of pixels) {
      const qr = Math.round(pixel.r / 48) * 48;
      const qg = Math.round(pixel.g / 48) * 48;
      const qb = Math.round(pixel.b / 48) * 48;
      const bucketKey = `${qr},${qg},${qb}`;
      const bucket = buckets.get(bucketKey) ?? { count: 0, r: 0, g: 0, b: 0 };
      bucket.count += 1;
      bucket.r += pixel.r;
      bucket.g += pixel.g;
      bucket.b += pixel.b;
      buckets.set(bucketKey, bucket);
    }
    const dominant = [...buckets.values()].sort((a, b) => b.count - a.count).slice(0, 5);
    const palette = dominant.map((bucket): DiyPaletteColor => ({
      hex: rgbToHex(bucket.r / bucket.count, bucket.g / bucket.count, bucket.b / bucket.count),
      weight: Math.round(bucket.count / Math.max(pixels.length, 1) * 1000) / 1000,
    }));
    const complexity = Math.min(1, buckets.size / 30);
    return {
      localImagePath,
      palette,
      visualTags: deriveVisualTags(palette, brightness, saturation, complexity),
      brightness: round3(brightness),
      saturation: round3(saturation),
      complexity: round3(complexity),
    };
  }

  async cacheRenderedPreview(imageUrl: string, key: string): Promise<string> {
    const url = new URL(imageUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Rendered preview URL must use HTTP or HTTPS.");
    const response = await this.#fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Rendered preview request failed with HTTP ${response.status}.`);
    const input = Buffer.from(await response.arrayBuffer());
    if (input.length > 15_000_000) throw new Error("Rendered preview exceeds 15 MB.");
    await mkdir(this.#previewDir, { recursive: true });
    const path = join(this.#previewDir, `${safeKey(key)}-steamdt.png`);
    await sharp(input).png().toFile(path);
    return path;
  }
}

function deriveVisualTags(palette: readonly DiyPaletteColor[], brightness: number, saturation: number, complexity: number): readonly string[] {
  const tags = new Set<string>();
  tags.add(brightness < 0.33 ? "dark" : brightness > 0.72 ? "bright" : "mid_tone");
  tags.add(saturation < 0.2 ? "low_saturation" : saturation > 0.58 ? "high_saturation" : "balanced_saturation");
  tags.add(complexity < 0.28 ? "simple" : complexity > 0.7 ? "complex" : "balanced_detail");
  for (const color of palette.slice(0, 3)) {
    const { r, g, b } = hexToRgb(color.hex);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max < 55) tags.add("black");
    else if (min > 205) tags.add("white");
    else if (max - min < 25) tags.add("gray");
    else if (r > g * 1.25 && r > b * 1.2) tags.add(r > 180 && g > 90 ? "orange" : "red");
    else if (g > r * 1.2 && g > b * 1.1) tags.add("green");
    else if (b > r * 1.2 && b > g * 1.1) tags.add("blue");
    if (r > 150 && b > 130 && g < Math.min(r, b) * 0.8) tags.add(r > 210 ? "pink" : "purple");
    if (g > 130 && b > 150 && r < 130) tags.add("cyan");
    if (r > 150 && g > 115 && b < 95) tags.add(g > 160 ? "yellow" : "gold");
  }
  if (saturation > 0.62 && brightness > 0.45) tags.add("neon");
  return [...tags];
}

function safeKey(value: string): string { return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 60); }
function round3(value: number): number { return Math.round(value * 1000) / 1000; }
function rgbToHex(r: number, g: number, b: number): string { return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`; }
function hexToRgb(hex: string): { r: number; g: number; b: number } { return { r: Number.parseInt(hex.slice(1, 3), 16), g: Number.parseInt(hex.slice(3, 5), 16), b: Number.parseInt(hex.slice(5, 7), 16) }; }
