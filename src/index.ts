#!/usr/bin/env node

/**
 * toolkit — personal CLI for managing Claude Code hooks, skills, and agents.
 *
 * Commands:
 *   toolkit add hook <name>
 *   toolkit add skill <name> [--link <target>...]
 *   toolkit add agent <name> [--link <target>...]
 *   toolkit add collections <name>
 *   toolkit update [--force]
 *   toolkit list hook
 *   toolkit list skill
 *   toolkit list agent
 *   toolkit list collections
 */

import { createHash } from "node:crypto";
import {
  cpSync,
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const TOOLKIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS_SRC = join(TOOLKIT_ROOT, "hooks");
const SKILLS_SRC = join(TOOLKIT_ROOT, "skills");
const AGENTS_SRC = join(TOOLKIT_ROOT, "agents");
const CONFIG_PATH = join(TOOLKIT_ROOT, "config.json");

const PROJECT_ROOT = process.cwd();
const CLAUDE_DIR = join(PROJECT_ROOT, ".claude");
const TOOLKIT_DIR = join(PROJECT_ROOT, ".claude-toolkit");
const MANIFEST_PATH = join(CLAUDE_DIR, "toolkit-manifest.json");

type HookEntry = { hash: string; installedAt: string };
type SkillEntry = { hash: string; installedAt: string; linkedTo: string[] };
type AgentEntry = { hash: string; installedAt: string; linkedTo: string[] };
type Manifest = {
  hooks: Record<string, HookEntry>;
  skills: Record<string, SkillEntry>;
  agents: Record<string, AgentEntry>;
};
type CollectionItemKind = "hook" | "skill" | "agent";
type CollectionItemConfig = {
  type: CollectionItemKind | `${CollectionItemKind}s`;
  src: string;
};
type CollectionConfig = {
  name: string;
  items: CollectionItemConfig[];
};
type ResolvedCollectionItem = {
  collection: string;
  sourcePath: string;
  sourceName: string;
  type: CollectionItemKind;
};
type SourceKind = "directory" | "file";
type ResourceConfig = {
  manifestKey: keyof Manifest;
  sourceRoot: string;
  sourceKind: SourceKind;
  sourcePath: (name: string) => string;
  installPath: (name: string) => string;
  hashSource: (sourcePath: string) => string;
  copySource: (sourcePath: string, installPath: string) => void;
  readSourceText: (sourcePath: string) => string;
  checksLocalModification: boolean;
  listName: (entryName: string) => string;
  listFilter: (entry: Dirent) => boolean;
};
type LinkedResourceKind = "skill" | "agent";
type LinkedResourceConfig = ResourceConfig & {
  manifestKey: "skills" | "agents";
  installRoot: string;
  defaultLinkTarget: string;
  linkName: (name: string) => string;
  symlinkType: "dir" | "file";
};

// ---------- helpers ----------

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function shortHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 7);
}

function readManifest(): Manifest {
  if (!existsSync(MANIFEST_PATH)) {
    return { hooks: {}, skills: {}, agents: {} };
  }

  try {
    const parsed = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Partial<Manifest>;
    return {
      hooks: parsed.hooks ?? {},
      skills: parsed.skills ?? {},
      agents: parsed.agents ?? {},
    };
  } catch {
    return { hooks: {}, skills: {}, agents: {} };
  }
}

function writeManifest(m: Manifest): void {
  mkdirSync(CLAUDE_DIR, { recursive: true });
  writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2) + "\n");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge<T>(target: T, source: T): T {
  if (Array.isArray(target) && Array.isArray(source)) {
    return [...target, ...source] as T;
  }
  if (isPlainObject(target) && isPlainObject(source)) {
    const out: Record<string, unknown> = { ...target };
    for (const [k, v] of Object.entries(source)) {
      out[k] = k in out ? deepMerge(out[k], v) : v;
    }
    return out as T;
  }
  return source;
}

function hashHookPath(sourcePath: string): string {
  return shortHash(readFileSync(join(sourcePath, "hook.mjs")));
}

function hashDirectorySource(sourcePath: string): string {
  const files = collectFiles(sourcePath).sort();
  const h = createHash("sha256");
  for (const f of files) {
    h.update(relative(sourcePath, f));
    h.update("\0");
    h.update(readFileSync(f));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 7);
}

function hashFileSource(sourcePath: string): string {
  return shortHash(readFileSync(sourcePath));
}

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) {
    return out;
  }

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".gitkeep") {
      continue;
    }

    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

const RESOURCE_CONFIGS = {
  hook: {
    manifestKey: "hooks",
    sourceRoot: HOOKS_SRC,
    sourceKind: "directory",
    sourcePath: (name: string) => join(HOOKS_SRC, name),
    installPath: (name: string) => join(CLAUDE_DIR, "hooks", `${name}.mjs`),
    hashSource: hashHookPath,
    copySource: (sourcePath: string, installPath: string) => {
      mkdirSync(dirname(installPath), { recursive: true });
      writeFileSync(installPath, readFileSync(join(sourcePath, "hook.mjs")));
    },
    readSourceText: (sourcePath: string) => readFileSync(join(sourcePath, "hook.mjs"), "utf8"),
    checksLocalModification: true,
    listName: (entryName: string) => entryName,
    listFilter: (entry: Dirent) => entry.isDirectory(),
  },
  skill: {
    manifestKey: "skills",
    sourceRoot: SKILLS_SRC,
    sourceKind: "directory",
    sourcePath: (name: string) => join(SKILLS_SRC, name),
    installPath: (name: string) => resolve(TOOLKIT_DIR, "skills", name),
    hashSource: hashDirectorySource,
    copySource: (sourcePath: string, installPath: string) => {
      mkdirSync(dirname(installPath), { recursive: true });
      cpSync(sourcePath, installPath, { recursive: true });
    },
    readSourceText: () => "",
    checksLocalModification: false,
    listName: (entryName: string) => entryName,
    listFilter: (entry: Dirent) => entry.isDirectory() || entry.isSymbolicLink(),
    installRoot: join(TOOLKIT_DIR, "skills"),
    defaultLinkTarget: join(".claude", "skills"),
    linkName: (name: string) => name,
    symlinkType: "dir",
  },
  agent: {
    manifestKey: "agents",
    sourceRoot: AGENTS_SRC,
    sourceKind: "file",
    sourcePath: (name: string) => join(AGENTS_SRC, `${name}.md`),
    installPath: (name: string) => resolve(TOOLKIT_DIR, "agents", `${name}.md`),
    hashSource: hashFileSource,
    copySource: (sourcePath: string, installPath: string) => {
      mkdirSync(dirname(installPath), { recursive: true });
      writeFileSync(installPath, readFileSync(sourcePath));
    },
    readSourceText: (sourcePath: string) => readFileSync(sourcePath, "utf8"),
    checksLocalModification: true,
    listName: (entryName: string) => basename(entryName, ".md"),
    listFilter: (entry: Dirent) => entry.isFile() && entry.name.endsWith(".md"),
    installRoot: join(TOOLKIT_DIR, "agents"),
    defaultLinkTarget: join(".claude", "agents"),
    linkName: (name: string) => `${name}.md`,
    symlinkType: "file",
  },
} satisfies Record<CollectionItemKind, ResourceConfig | LinkedResourceConfig>;

function resourceConfig(kind: CollectionItemKind): ResourceConfig {
  return RESOURCE_CONFIGS[kind];
}

function linkedResourceConfig(kind: LinkedResourceKind): LinkedResourceConfig {
  return RESOURCE_CONFIGS[kind];
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}

function diffLines(oldStr: string, newStr: string): string {
  const a = oldStr.split("\n");
  const b = newStr.split("\n");
  const out: string[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) {
      continue;
    }

    if (a[i] !== undefined) {
      out.push(`- ${a[i]}`);
    }

    if (b[i] !== undefined) {
      out.push(`+ ${b[i]}`);
    }
  }
  return out.join("\n");
}

// ---------- resources ----------

function sanitizeName(name: string, kind: string): string {
  name = basename(name);
  if (!name) {
    console.error(`Invalid ${kind} name`);
    process.exit(1);
  }
  return name;
}

function sanitizeAgentName(name: string): string {
  const sanitized = sanitizeName(name, "agent");
  return sanitized.endsWith(".md") ? sanitized.slice(0, -3) : sanitized;
}

function normalizeCollectionItemType(
  type: CollectionItemConfig["type"],
  collectionName: string,
): CollectionItemKind {
  if (type === "hook" || type === "hooks") {
    return "hook";
  }
  if (type === "skill" || type === "skills") {
    return "skill";
  }
  if (type === "agent" || type === "agents") {
    return "agent";
  }

  throw new Error(`Collection "${collectionName}" has unsupported item type "${type}"`);
}

function resolveSourcePath(src: string, kind: string, collectionName: string): string {
  const sourcePath = resolve(TOOLKIT_ROOT, src);
  if (!sourcePath.startsWith(TOOLKIT_ROOT + sep)) {
    throw new Error(
      `Collection "${collectionName}" ${kind} source must stay within the toolkit root: ${src}`,
    );
  }
  return sourcePath;
}

function inferItemNameFromSource(
  type: CollectionItemKind,
  sourcePath: string,
  collectionName: string,
): string {
  const config = resourceConfig(type);
  const expectedRoot = config.sourceRoot;
  if (dirname(sourcePath) !== expectedRoot || !sourcePath.startsWith(expectedRoot + sep)) {
    throw new Error(
      `Collection "${collectionName}" ${type} source must point to a top-level entry under ${relative(TOOLKIT_ROOT, expectedRoot)}/: ${relative(TOOLKIT_ROOT, sourcePath)}`,
    );
  }

  if (config.sourceKind === "file") {
    if (!sourcePath.endsWith(".md")) {
      throw new Error(
        `Collection "${collectionName}" agent source must point to a Markdown file: ${relative(TOOLKIT_ROOT, sourcePath)}`,
      );
    }
  }

  return config.listName(basename(sourcePath));
}

function readCollectionsConfig(): CollectionConfig[] {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Collections config not found: ${relative(TOOLKIT_ROOT, CONFIG_PATH)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (error) {
    throw new Error(
      `Invalid collections config in ${relative(TOOLKIT_ROOT, CONFIG_PATH)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Collections config must be an array");
  }

  const names = new Set<string>();
  return parsed.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new Error(`Collection at index ${index} must be an object`);
    }

    const { name, items } = entry;
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error(`Collection at index ${index} must have a non-empty name`);
    }
    if (names.has(name)) {
      throw new Error(`Duplicate collection name: ${name}`);
    }
    names.add(name);

    if (!Array.isArray(items)) {
      throw new Error(`Collection "${name}" must have an items array`);
    }

    const validatedItems = items.map((item, itemIndex) => {
      if (!isPlainObject(item)) {
        throw new Error(`Collection "${name}" item at index ${itemIndex} must be an object`);
      }
      if (typeof item.type !== "string" || item.type.trim().length === 0) {
        throw new Error(
          `Collection "${name}" item at index ${itemIndex} must have a non-empty type`,
        );
      }
      if (typeof item.src !== "string" || item.src.trim().length === 0) {
        throw new Error(
          `Collection "${name}" item at index ${itemIndex} must have a non-empty src`,
        );
      }

      return {
        type: item.type as CollectionItemConfig["type"],
        src: item.src,
      };
    });

    return {
      name,
      items: validatedItems,
    };
  });
}

function resolveCollection(name: string): ResolvedCollectionItem[] {
  const collectionName = sanitizeName(name, "collection");
  const collections = readCollectionsConfig();
  const collection = collections.find((entry) => entry.name === collectionName);

  if (!collection) {
    throw new Error(`Collection not found: ${collectionName}`);
  }

  const deduped = new Map<string, ResolvedCollectionItem>();

  for (const item of collection.items) {
    const type = normalizeCollectionItemType(item.type, collection.name);
    const sourcePath = resolveSourcePath(item.src, type, collection.name);
    const sourceName = inferItemNameFromSource(type, sourcePath, collection.name);
    const key = `${type}:${sourceName}`;

    if (!deduped.has(key)) {
      deduped.set(key, {
        collection: collection.name,
        sourcePath,
        sourceName,
        type,
      });
    }
  }

  return [...deduped.values()];
}

function installHook(name: string, srcDir: string): void {
  if (!existsSync(srcDir)) {
    console.error(`Hook not found: ${name}`);
    process.exit(1);
  }

  const hookSrc = join(srcDir, "hook.mjs");
  const fragmentPath = join(srcDir, "settings-fragment.json");

  const hooksDir = join(CLAUDE_DIR, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const destHook = resolve(hooksDir, `${name}.mjs`);
  if (!destHook.startsWith(hooksDir + sep)) {
    console.error("Invalid hook name");
    process.exit(1);
  }
  writeFileSync(destHook, readFileSync(hookSrc));

  if (existsSync(fragmentPath)) {
    const fragment = JSON.parse(readFileSync(fragmentPath, "utf8"));
    const settingsPath = join(CLAUDE_DIR, "settings.json");
    const current = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
    const merged = deepMerge(current, fragment);
    writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n");
  }

  const manifest = readManifest();
  const config = resourceConfig("hook");
  manifest.hooks[name] = { hash: config.hashSource(config.sourcePath(name)), installedAt: today() };
  writeManifest(manifest);

  console.log(`Installed hook: ${name} → ${relative(PROJECT_ROOT, destHook)}`);
}

function addHook(name: string): void {
  name = sanitizeName(name, "hook");
  installHook(name, join(HOOKS_SRC, name));
}

function sourceExists(sourcePath: string, sourceKind: SourceKind): boolean {
  if (!existsSync(sourcePath)) {
    return false;
  }

  const stats = statSync(sourcePath);
  return sourceKind === "directory" ? stats.isDirectory() : stats.isFile();
}

function installLinkedResource(
  kind: LinkedResourceKind,
  name: string,
  sourcePath: string,
  links: string[],
): void {
  const config = linkedResourceConfig(kind);
  if (!sourceExists(sourcePath, config.sourceKind)) {
    console.error(`${kind.slice(0, 1).toUpperCase() + kind.slice(1)} not found: ${name}`);
    process.exit(1);
  }

  const installPath = config.installPath(name);
  if (!installPath.startsWith(config.installRoot + sep)) {
    console.error(`Invalid ${kind} name`);
    process.exit(1);
  }

  config.copySource(sourcePath, installPath);

  const resolvedLinks = links.length > 0 ? links : [config.defaultLinkTarget];
  const linkName = config.linkName(name);
  for (const link of resolvedLinks) {
    const linkDir = resolve(PROJECT_ROOT, link);
    mkdirSync(linkDir, { recursive: true });

    const linkPath = join(linkDir, linkName);
    if (existsSync(linkPath) || lstatExists(linkPath)) {
      unlinkSync(linkPath);
    }

    const relTarget = relative(linkDir, installPath);
    symlinkSync(relTarget, linkPath, config.symlinkType);
  }

  const manifest = readManifest();
  manifest[config.manifestKey][name] = {
    hash: config.hashSource(sourcePath),
    installedAt: today(),
    linkedTo: resolvedLinks,
  };
  writeManifest(manifest);

  console.log(`Installed ${kind}: ${name} → ${relative(PROJECT_ROOT, installPath)}`);
  for (const l of resolvedLinks) {
    console.log(`  linked: ${join(l, linkName)}`);
  }
}

function addLinkedResource(kind: LinkedResourceKind, name: string, links: string[]): void {
  name = kind === "agent" ? sanitizeAgentName(name) : sanitizeName(name, kind);
  installLinkedResource(kind, name, linkedResourceConfig(kind).sourcePath(name), links);
}

function addCollection(name: string): void {
  const items = resolveCollection(name);
  for (const item of items) {
    if (!existsSync(item.sourcePath)) {
      throw new Error(
        `Collection "${item.collection}" references missing ${item.type} source: ${relative(TOOLKIT_ROOT, item.sourcePath)}`,
      );
    }

    const config = resourceConfig(item.type);
    const itemStats = statSync(item.sourcePath);
    const actualKind = itemStats.isFile()
      ? "file"
      : itemStats.isDirectory()
        ? "directory"
        : "other";

    if (!sourceExists(item.sourcePath, config.sourceKind)) {
      throw new Error(
        `Collection "${item.collection}" expected ${item.type} source "${item.sourcePath}" to be a ${config.sourceKind}, found ${actualKind}`,
      );
    }

    if (item.type === "hook") {
      installHook(item.sourceName, item.sourcePath);
    } else {
      installLinkedResource(item.type, item.sourceName, item.sourcePath, []);
    }
  }
}

function lstatExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

async function updateResources(
  kind: CollectionItemKind,
  manifest: Manifest,
  force: boolean,
): Promise<boolean> {
  const config = resourceConfig(kind);
  const entries = manifest[config.manifestKey] as Record<
    string,
    HookEntry | SkillEntry | AgentEntry
  >;
  let changed = false;

  for (const [name, entry] of Object.entries(entries)) {
    const sourcePath = config.sourcePath(name);
    if (!existsSync(sourcePath)) {
      continue;
    }

    const sourceHash = config.hashSource(sourcePath);
    const installPath = config.installPath(name);
    const installedHash =
      config.checksLocalModification && existsSync(installPath)
        ? shortHash(readFileSync(installPath))
        : null;

    const sourceChanged = sourceHash !== entry.hash;
    const locallyModified = installedHash !== null && installedHash !== entry.hash;

    if (!sourceChanged && !locallyModified) {
      continue;
    }

    changed = true;

    if (locallyModified && !force) {
      console.warn(
        `! ${kind} "${name}" was modified locally (installed=${installedHash}, manifest=${entry.hash}). Use --force to overwrite.`,
      );
      continue;
    }

    if (!sourceChanged) {
      continue;
    }

    console.log(`\n~ ${kind}: ${name} (${entry.hash} → ${sourceHash})`);
    if (config.checksLocalModification) {
      const oldSrc = existsSync(installPath) ? readFileSync(installPath, "utf8") : "";
      console.log(diffLines(oldSrc, config.readSourceText(sourcePath)));
    }

    const ok = force || (await confirm(`Update ${kind} "${name}"?`));
    if (!ok) {
      continue;
    }

    config.copySource(sourcePath, installPath);
    if (kind === "hook") {
      manifest.hooks[name] = { hash: sourceHash, installedAt: today() };
    } else {
      manifest[linkedResourceConfig(kind).manifestKey][name] = {
        hash: sourceHash,
        installedAt: today(),
        linkedTo: (entry as SkillEntry | AgentEntry).linkedTo,
      };
    }
  }

  return changed;
}

async function update(force: boolean): Promise<void> {
  const manifest = readManifest();
  let changed = await updateResources("hook", manifest, force);
  changed = (await updateResources("skill", manifest, force)) || changed;
  changed = (await updateResources("agent", manifest, force)) || changed;

  if (changed) {
    writeManifest(manifest);
  }
}

function list(kind: CollectionItemKind): void {
  const config = resourceConfig(kind);
  const dir = config.sourceRoot;
  if (!existsSync(dir)) {
    console.log(`(no ${kind}s available)`);
    return;
  }
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter(config.listFilter)
    .map((e) => config.listName(e.name));

  if (entries.length === 0) {
    console.log(`(no ${kind}s available)`);
    return;
  }

  for (const name of entries) {
    const hash = config.hashSource(config.sourcePath(name));
    console.log(`${name}  ${hash}`);
  }
}

function listCollections(): void {
  const collections = readCollectionsConfig();
  if (collections.length === 0) {
    console.log("(no collections available)");
    return;
  }

  for (const collection of collections) {
    console.log(`${collection.name}  ${collection.items.length} item(s)`);
  }
}

// ---------- argv ----------

function usage(): never {
  console.error(
    `Usage:
  toolkit add hook <name>
  toolkit add skill <name> [--link <target>]...
  toolkit add agent <name> [--link <target>]...
  toolkit add collections <name>
  toolkit update [--force]
  toolkit list hook
  toolkit list skill
  toolkit list agent
  toolkit list collections`,
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      force: {
        default: false,
        type: "boolean",
      },
      link: {
        multiple: true,
        type: "string",
      },
      links: {
        multiple: true,
        type: "string",
      },
    },
    allowPositionals: true,
  });

  const { force, link, links } = values;
  const linkTargets = [...(link ?? []), ...(links ?? [])];
  const [command, resource, name] = positionals;

  if (command === "add" && resource === "hook") {
    if (!name) {
      usage();
    }

    addHook(name);
    return;
  }

  if (command === "add" && resource === "skill") {
    if (!name) {
      usage();
    }

    addLinkedResource("skill", name, linkTargets);
    return;
  }

  if (command === "add" && resource === "agent") {
    if (!name) {
      usage();
    }

    addLinkedResource("agent", name, linkTargets);
    return;
  }

  if (command === "add" && (resource === "collection" || resource === "collections")) {
    if (!name) {
      usage();
    }

    addCollection(name);
    return;
  }

  if (command === "update") {
    await update(force);
    return;
  }

  if (command === "list" && (resource === "hook" || resource === "skill" || resource === "agent")) {
    list(resource);
    return;
  }

  if (command === "list" && (resource === "collection" || resource === "collections")) {
    listCollections();
    return;
  }

  usage();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
