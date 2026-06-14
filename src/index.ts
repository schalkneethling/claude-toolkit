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

function hashHookSource(name: string): string {
  const p = join(HOOKS_SRC, name, "hook.mjs");
  return shortHash(readFileSync(p));
}

function hashSkillSource(name: string): string {
  const dir = join(SKILLS_SRC, name);
  const files = collectFiles(dir).sort();
  const h = createHash("sha256");
  for (const f of files) {
    h.update(relative(dir, f));
    h.update("\0");
    h.update(readFileSync(f));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 7);
}

function hashAgentSource(name: string): string {
  return shortHash(readFileSync(join(AGENTS_SRC, `${name}.md`)));
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
  const expectedRoot = type === "hook" ? HOOKS_SRC : type === "skill" ? SKILLS_SRC : AGENTS_SRC;
  if (dirname(sourcePath) !== expectedRoot || !sourcePath.startsWith(expectedRoot + sep)) {
    throw new Error(
      `Collection "${collectionName}" ${type} source must point to a top-level entry under ${relative(TOOLKIT_ROOT, expectedRoot)}/: ${relative(TOOLKIT_ROOT, sourcePath)}`,
    );
  }

  if (type === "agent") {
    if (!sourcePath.endsWith(".md")) {
      throw new Error(
        `Collection "${collectionName}" agent source must point to a Markdown file: ${relative(TOOLKIT_ROOT, sourcePath)}`,
      );
    }
    return basename(sourcePath, ".md");
  }

  return basename(sourcePath);
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
  manifest.hooks[name] = { hash: hashHookSource(name), installedAt: today() };
  writeManifest(manifest);

  console.log(`Installed hook: ${name} → ${relative(PROJECT_ROOT, destHook)}`);
}

function addHook(name: string): void {
  name = sanitizeName(name, "hook");
  installHook(name, join(HOOKS_SRC, name));
}

function installSkill(name: string, srcDir: string, links: string[]): void {
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
    console.error(`Skill not found: ${name}`);
    process.exit(1);
  }

  const destDir = resolve(TOOLKIT_DIR, "skills", name);
  if (!destDir.startsWith(join(TOOLKIT_DIR, "skills") + sep)) {
    console.error("Invalid skill name");
    process.exit(1);
  }
  mkdirSync(dirname(destDir), { recursive: true });
  cpSync(srcDir, destDir, { recursive: true });

  const resolvedLinks = links.length > 0 ? links : [join(".claude", "skills")];
  for (const link of resolvedLinks) {
    const linkDir = resolve(PROJECT_ROOT, link);
    mkdirSync(linkDir, { recursive: true });

    const linkPath = join(linkDir, name);
    if (existsSync(linkPath) || lstatExists(linkPath)) {
      unlinkSync(linkPath);
    }

    const relTarget = relative(linkDir, destDir);
    symlinkSync(relTarget, linkPath, "dir");
  }

  const manifest = readManifest();
  manifest.skills[name] = {
    hash: hashSkillSource(name),
    installedAt: today(),
    linkedTo: resolvedLinks,
  };
  writeManifest(manifest);

  console.log(`Installed skill: ${name} → ${relative(PROJECT_ROOT, destDir)}`);
  for (const l of resolvedLinks) {
    console.log(`  linked: ${join(l, name)}`);
  }
}

function addSkill(name: string, links: string[]): void {
  name = sanitizeName(name, "skill");
  installSkill(name, join(SKILLS_SRC, name), links);
}

function installAgent(name: string, srcFile: string, links: string[]): void {
  if (!existsSync(srcFile) || !statSync(srcFile).isFile()) {
    console.error(`Agent not found: ${name}`);
    process.exit(1);
  }

  const agentsRoot = join(TOOLKIT_DIR, "agents");
  const destFile = resolve(agentsRoot, `${name}.md`);
  if (!destFile.startsWith(agentsRoot + sep)) {
    console.error("Invalid agent name");
    process.exit(1);
  }
  mkdirSync(dirname(destFile), { recursive: true });
  writeFileSync(destFile, readFileSync(srcFile));

  const resolvedLinks = links.length > 0 ? links : [join(".claude", "agents")];
  for (const link of resolvedLinks) {
    const linkDir = resolve(PROJECT_ROOT, link);
    mkdirSync(linkDir, { recursive: true });

    const linkPath = join(linkDir, `${name}.md`);
    if (existsSync(linkPath) || lstatExists(linkPath)) {
      unlinkSync(linkPath);
    }

    const relTarget = relative(linkDir, destFile);
    symlinkSync(relTarget, linkPath, "file");
  }

  const manifest = readManifest();
  manifest.agents[name] = {
    hash: hashAgentSource(name),
    installedAt: today(),
    linkedTo: resolvedLinks,
  };
  writeManifest(manifest);

  console.log(`Installed agent: ${name} → ${relative(PROJECT_ROOT, destFile)}`);
  for (const l of resolvedLinks) {
    console.log(`  linked: ${join(l, `${name}.md`)}`);
  }
}

function addAgent(name: string, links: string[]): void {
  name = sanitizeAgentName(name);
  installAgent(name, join(AGENTS_SRC, `${name}.md`), links);
}

function addCollection(name: string): void {
  const items = resolveCollection(name);
  for (const item of items) {
    if (!existsSync(item.sourcePath)) {
      throw new Error(
        `Collection "${item.collection}" references missing ${item.type} source: ${relative(TOOLKIT_ROOT, item.sourcePath)}`,
      );
    }

    const itemStats = statSync(item.sourcePath);
    const actualKind = itemStats.isFile()
      ? "file"
      : itemStats.isDirectory()
        ? "directory"
        : "other";

    if (item.type === "hook") {
      if (!itemStats.isDirectory()) {
        throw new Error(
          `Collection "${item.collection}" expected hook source "${item.sourcePath}" to be a directory, found ${actualKind}`,
        );
      }
      installHook(item.sourceName, item.sourcePath);
      continue;
    }

    if (item.type === "skill") {
      if (!itemStats.isDirectory()) {
        throw new Error(
          `Collection "${item.collection}" expected skill source "${item.sourcePath}" to be a directory, found ${actualKind}`,
        );
      }
      installSkill(item.sourceName, item.sourcePath, []);
      continue;
    }

    if (!itemStats.isFile()) {
      throw new Error(
        `Collection "${item.collection}" expected agent source "${item.sourcePath}" to be a file, found ${actualKind}`,
      );
    }
    installAgent(item.sourceName, item.sourcePath, []);
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

async function update(force: boolean): Promise<void> {
  const manifest = readManifest();
  let changed = false;

  for (const [name, entry] of Object.entries(manifest.hooks)) {
    const srcDir = join(HOOKS_SRC, name);
    if (!existsSync(srcDir)) {
      continue;
    }

    const sourceHash = hashHookSource(name);
    const installedPath = join(CLAUDE_DIR, "hooks", `${name}.mjs`);
    const installedHash = existsSync(installedPath) ? shortHash(readFileSync(installedPath)) : null;

    const sourceChanged = sourceHash !== entry.hash;
    const locallyModified = installedHash !== null && installedHash !== entry.hash;

    if (!sourceChanged && !locallyModified) {
      continue;
    }

    changed = true;

    if (locallyModified && !force) {
      console.warn(
        `! hook "${name}" was modified locally (installed=${installedHash}, manifest=${entry.hash}). Use --force to overwrite.`,
      );
      continue;
    }

    if (sourceChanged) {
      const oldSrc = existsSync(installedPath) ? readFileSync(installedPath, "utf8") : "";
      const newSrc = readFileSync(join(srcDir, "hook.mjs"), "utf8");
      console.log(`\n~ hook: ${name} (${entry.hash} → ${sourceHash})`);
      console.log(diffLines(oldSrc, newSrc));
      const ok = force || (await confirm(`Update hook "${name}"?`));

      if (!ok) {
        continue;
      }

      writeFileSync(installedPath, newSrc);
      manifest.hooks[name] = { hash: sourceHash, installedAt: today() };
    }
  }

  for (const [name, entry] of Object.entries(manifest.skills)) {
    const srcDir = join(SKILLS_SRC, name);
    if (!existsSync(srcDir)) {
      continue;
    }

    const sourceHash = hashSkillSource(name);
    if (sourceHash === entry.hash) {
      continue;
    }

    changed = true;
    console.log(`\n~ skill: ${name} (${entry.hash} → ${sourceHash})`);
    const ok = force || (await confirm(`Update skill "${name}"?`));
    if (!ok) {
      continue;
    }

    const destDir = join(TOOLKIT_DIR, "skills", name);
    cpSync(srcDir, destDir, { recursive: true, force: true });
    manifest.skills[name] = {
      hash: sourceHash,
      installedAt: today(),
      linkedTo: entry.linkedTo,
    };
  }

  for (const [name, entry] of Object.entries(manifest.agents)) {
    const srcFile = join(AGENTS_SRC, `${name}.md`);
    if (!existsSync(srcFile)) {
      continue;
    }

    const sourceHash = hashAgentSource(name);
    const destFile = join(TOOLKIT_DIR, "agents", `${name}.md`);
    const installedHash = existsSync(destFile) ? shortHash(readFileSync(destFile)) : null;

    const sourceChanged = sourceHash !== entry.hash;
    const locallyModified = installedHash !== null && installedHash !== entry.hash;

    if (!sourceChanged && !locallyModified) {
      continue;
    }

    changed = true;

    if (locallyModified && !force) {
      console.warn(
        `! agent "${name}" was modified locally (installed=${installedHash}, manifest=${entry.hash}). Use --force to overwrite.`,
      );
      continue;
    }

    if (sourceChanged) {
      const oldSrc = existsSync(destFile) ? readFileSync(destFile, "utf8") : "";
      const newSrc = readFileSync(srcFile, "utf8");
      console.log(`\n~ agent: ${name} (${entry.hash} → ${sourceHash})`);
      console.log(diffLines(oldSrc, newSrc));
      const ok = force || (await confirm(`Update agent "${name}"?`));

      if (!ok) {
        continue;
      }

      mkdirSync(dirname(destFile), { recursive: true });
      writeFileSync(destFile, newSrc);
      manifest.agents[name] = {
        hash: sourceHash,
        installedAt: today(),
        linkedTo: entry.linkedTo,
      };
    }
  }

  if (changed) {
    writeManifest(manifest);
  }
}

function list(kind: CollectionItemKind): void {
  const dir = kind === "hook" ? HOOKS_SRC : kind === "skill" ? SKILLS_SRC : AGENTS_SRC;
  if (!existsSync(dir)) {
    console.log(`(no ${kind}s available)`);
    return;
  }
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter(
      (e) =>
        (kind !== "agent" && (e.isDirectory() || (kind === "skill" && e.isSymbolicLink()))) ||
        (kind === "agent" && e.isFile() && e.name.endsWith(".md")),
    )
    .map((e) => (kind === "agent" ? basename(e.name, ".md") : e.name));

  if (entries.length === 0) {
    console.log(`(no ${kind}s available)`);
    return;
  }

  for (const name of entries) {
    const hash =
      kind === "hook" ? hashHookSource(name) : kind === "skill" ? hashSkillSource(name) : hashAgentSource(name);
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

    addSkill(name, linkTargets);
    return;
  }

  if (command === "add" && resource === "agent") {
    if (!name) {
      usage();
    }

    addAgent(name, linkTargets);
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
