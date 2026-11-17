import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env, PRODUCT } from "./name";

export interface Endpoint {
  /** OpenAI-compatible base address, e.g. http://127.0.0.1:8080/v1 */
  baseURL: string;
  model: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  /** Sent as-is in each request body, e.g. {"chat_template_kwargs":{"enable_thinking":false}} */
  extraBody?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface PaletteColor {
  name: string;
  /** Hex colour used in drawings, e.g. #0F766E */
  value: string;
  /** Optional replacement for the dark variant */
  dark?: string;
}

export interface Config {
  coder: Endpoint;
  /** Model that can see pictures. Can be the same as coder. */
  vision: Endpoint;
  palette: PaletteColor[];
  /** If true, colours outside the palette are errors; if false, warnings. */
  strictPalette: boolean;
  examplesDir: string;
  styleFile?: string;
  outDir: string;
  canvas: number;
  maxElements: number;
  candidates: number;
  rounds: number;
  keep: number;
  /** Review renders at these pixel sizes. */
  reviewSizes: number[];
  exportSizes: number[];
  /** Score (0-10) at which a candidate stops being revised. */
  goodEnough: number;
  fontDirs?: string[];
}

const DEFAULTS: Omit<Config, "coder" | "vision"> = {
  palette: [
    { name: "ink", value: "#1F2937", dark: "#E5E7EB" },
    { name: "accent", value: "#0F766E", dark: "#2DD4BF" },
    { name: "warm", value: "#F59E0B" },
    { name: "paper", value: "#FFFFFF" },
  ],
  strictPalette: false,
  examplesDir: "examples",
  styleFile: "style.md",
  outDir: "out",
  canvas: 256,
  maxElements: 24,
  candidates: 3,
  rounds: 2,
  keep: 2,
  reviewSizes: [32, 256],
  exportSizes: [16, 32, 64, 128, 256, 512],
  goodEnough: 8,
};

/**
 * Folder holding the shipped files (examples/, style.md):
 * next to the binary when compiled; the package root when run from source (src/) or from the npm build (dist/).
 */
export function programDir(): string {
  const exe = basename(process.execPath).toLowerCase().replace(/\.exe$/, "");
  if (exe === "bun" || exe === "node") return resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return dirname(process.execPath);
}

/** Find the config: explicit path, $SVGLOOP_CONFIG, ./svgloop.config.json, then next to the program. */
export function configPath(explicit?: string): string | undefined {
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  const candidates = [env("CONFIG"), resolve(process.cwd(), PRODUCT.configFile), resolve(programDir(), PRODUCT.configFile)];
  return candidates.find((p) => p && existsSync(p)) ?? undefined;
}

/** Replace {env:NAME} in every string (same syntax as OpenCode's config), so a host can pass a port or key. */
function expandEnv<T>(v: T): T {
  if (typeof v === "string") return v.replace(/\{env:([A-Za-z0-9_]+)\}/g, (_, n) => process.env[n] ?? "") as T;
  if (Array.isArray(v)) return v.map(expandEnv) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandEnv(x)])) as T;
  return v;
}

/**
 * Environment overrides, for hosts that start the model server themselves (e.g. a random port and a fresh key),
 * and for MCP clients that pass settings as env vars instead of a config file:
 * SVGLOOP_BASE_URL, SVGLOOP_API_KEY, SVGLOOP_MODEL apply to both endpoints;
 * SVGLOOP_VISION_BASE_URL, SVGLOOP_VISION_API_KEY, SVGLOOP_VISION_MODEL override the reviewer only;
 * SVGLOOP_OUT_DIR sets where results go.
 */
function applyEnv(cfg: Config): void {
  const set = (ep: Endpoint | undefined, url?: string, key?: string, model?: string): Endpoint | undefined => {
    if (!url && !key && !model) return ep;
    const out = { ...(ep ?? { baseURL: "", model: "" }) } as Endpoint;
    if (url) out.baseURL = url;
    if (key) out.apiKey = key;
    if (model) out.model = model;
    return out;
  };
  const visionInherits = !cfg.vision || cfg.vision === cfg.coder;
  cfg.coder = set(cfg.coder, env("BASE_URL"), env("API_KEY"), env("MODEL"))!;
  cfg.vision = visionInherits ? cfg.coder : set(cfg.vision, env("BASE_URL"), env("API_KEY"), env("MODEL"))!;
  cfg.vision = set(cfg.vision, env("VISION_BASE_URL"), env("VISION_API_KEY"), env("VISION_MODEL"))!;
  // SVGLOOP_EXTRA_BODY: JSON merged into every request, e.g. {"chat_template_kwargs":{"enable_thinking":false}}
  const extra = env("EXTRA_BODY");
  if (extra) {
    let parsed: unknown;
    try { parsed = JSON.parse(extra); } catch { throw new Error(`${PRODUCT.envPrefix}_EXTRA_BODY is not valid JSON.`); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${PRODUCT.envPrefix}_EXTRA_BODY must be a JSON object.`);
    const add = (ep?: Endpoint) => (ep ? { ...ep, extraBody: { ...(ep.extraBody ?? {}), ...(parsed as object) } } : ep);
    const same = cfg.vision === cfg.coder;
    cfg.coder = add(cfg.coder)!;
    cfg.vision = same ? cfg.coder : add(cfg.vision)!;
  }
}

export function loadConfig(explicit?: string, overrides: Partial<Config> = {}): Config {
  const path = configPath(explicit);
  if (explicit && !path) throw new Error(`Config not found: ${explicit}`);
  // Strip a byte-order mark: Notepad and Windows PowerShell add one.
  const raw = path ? expandEnv(JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""))) : {};
  const merged = { ...DEFAULTS, ...raw, ...overrides } as Config;
  if (!merged.vision) merged.vision = merged.coder;
  applyEnv(merged);

  // Paths in a config file are relative to that file. The shipped examples and style rules are used
  // unless the config names its own. Without a config file, results go to ~/SVGLoop (never into the
  // install folder, which may be an npm cache or read-only).
  const base = path ? dirname(path) : process.cwd();
  const abs = (p: string, from: string) => (isAbsolute(p) ? p : resolve(from, p));
  const has = (k: keyof Config) => (raw as Record<string, unknown>)[k] !== undefined || overrides[k] !== undefined;
  merged.examplesDir = abs(merged.examplesDir, has("examplesDir") ? base : programDir());
  merged.styleFile = merged.styleFile ? abs(merged.styleFile, has("styleFile") ? base : programDir()) : undefined;
  merged.outDir = env("OUT_DIR") ?? (has("outDir") || path ? abs(merged.outDir, base) : join(homedir(), PRODUCT.outFolder));
  merged.fontDirs = merged.fontDirs?.map((d) => abs(d, base));
  return merged;
}

/** Commands that call models need endpoints; render/validate/export do not. */
export function requireModels(cfg: Config): Config {
  if (!cfg.coder?.baseURL || !cfg.coder?.model) {
    throw new Error(
      `No model endpoint configured. Set ${PRODUCT.envPrefix}_BASE_URL and ${PRODUCT.envPrefix}_MODEL, ` +
        `or copy ${PRODUCT.id}.config.example.json to ${PRODUCT.configFile} and edit it.`,
    );
  }
  return cfg;
}
