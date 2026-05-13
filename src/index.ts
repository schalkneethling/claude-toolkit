#!/usr/bin/env node

/**
 * toolkit — personal CLI for managing Claude Code hooks, skills, and commands.
 *
 * Commands:
 *   toolkit add hook <name>
 *   toolkit add skill <name> [--link <target>...]
 *   toolkit add command <name>
 *   toolkit add collections <name>
 *   toolkit update [--force]
 *   toolkit list hook
 *   toolkit list skill
 *   toolkit list command
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
const COMMANDS_SRC = join(TOOLKIT_ROOT, "commands");
const CONFIG_PATH = join(TOOLKIT_ROOT, "config.json");

const PROJECT_ROOT = process.cwd();
const CLAUDE_DIR = join(PROJECT_ROOT, ".claude");
const TOOLKIT_DIR = join(PROJECT_ROOT, ".claude-toolkit");
const MANIFEST_PATH = join(CLAUDE_DIR, "toolkit-manifest.json");

type HookEntry = { hash: string; installedAt: string };
type SkillEntry = { hash: string; installedAt: string; linkedTo: string[] };
type CommandEntry = { hash: string; installedAt: string };
type Manifest = {
  commands: Record<string, CommandEntry>;
  hooks: Record<string, HookEntry>;
  skills: Record<string, SkillEntry>;
};
type CollectionItemKind = "command" | "hook" | "skill";
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
    return { commands: {}, hooks: {}, skills: {} };
  }

  try {
    const parsed = JSON.parse(
      readFileSync(MANIFEST_PATH, "utf8"),
    ) as Partial<Manifest>;
    return {
      commands: parsed.commands ?? {},
      hooks: parsed.hooks ?? {},
      skills: parsed.skills ?? {},
    };
  } catch {
    return { commands: {}, hooks: {}, skills: {} };
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

function hashCommandSource(name: string): string {
  const p = join(COMMANDS_SRC, `${name}.md`);
  return shortHash(readFileSync(p));
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

// ---------- commands ----------

function sanitizeName(name: string, kind: string): string {
  name = basename(name);
  if (!name) {
    console.error(`Invalid ${kind} name`);
    process.exit(1);
  }
  return name;
}

function normalizeCollectionItemType(
  type: CollectionItemConfig["type"],
  collectionName: string,
): CollectionItemKind {
  if (type === "command" || type === "commands") {
    return "command";
  }
  if (type === "hook" || type === "hooks") {
    return "hook";
  }
  if (type === "skill" || type === "skills") {
    return "skill";
  }

  throw new Error(
    `Collection "${collectionName}" has unsupported item type "${type}"`,
  );
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
  if (type === "command") {
    if (
      dirname(sourcePath) !== COMMANDS_SRC ||
      !sourcePath.startsWith(COMMANDS_SRC + sep) ||
      !sourcePath.endsWith(".md")
    ) {
      throw new Error(
        `Collection "${collectionName}" command source must point to a markdown file directly under commands/: ${relative(TOOLKIT_ROOT, sourcePath)}`,
      );
    }
    return basename(sourcePath, ".md");
  }

  const expectedRoot = type === "hook" ? HOOKS_SRC : SKILLS_SRC;
  if (dirname(sourcePath) !== expectedRoot || !sourcePath.startsWith(expectedRoot + sep)) {
    throw new Error(
      `Collection "${collectionName}" ${type} source must point to a top-level entry under ${relative(TOOLKIT_ROOT, expectedRoot)}/: ${relative(TOOLKIT_ROOT, sourcePath)}`,
    );
  }

  return basename(sourcePath);
}

function readCollectionsConfig(): CollectionConfig[] {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `Collections config not found: ${relative(TOOLKIT_ROOT, CONFIG_PATH)}`,
    );
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
        throw new Error(
          `Collection "${name}" item at index ${itemIndex} must be an object`,
        );
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

function installCommand(name: string, src: string): void {
  if (!existsSync(src)) {
    console.error(`Command not found: ${name}`);
    process.exit(1);
  }

  const commandsDir = join(CLAUDE_DIR, "commands");
  mkdirSync(commandsDir, { recursive: true });
  const dest = resolve(commandsDir, `${name}.md`);
  if (!dest.startsWith(commandsDir + sep)) {
    console.error("Invalid command name");
    process.exit(1);
  }
  writeFileSync(dest, readFileSync(src));

  const manifest = readManifest();
  manifest.commands[name] = {
    hash: hashCommandSource(name),
    installedAt: today(),
  };
  writeManifest(manifest);

  console.log(`Installed command: ${name} → ${relative(PROJECT_ROOT, dest)}`);
}

function addCommand(name: string): void {
  name = sanitizeName(name, "command");
  installCommand(name, join(COMMANDS_SRC, `${name}.md`));
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
    const current = existsSync(settingsPath)
      ? JSON.parse(readFileSync(settingsPath, "utf8"))
      : {};
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

function addCollection(name: string): void {
  const items = resolveCollection(name);
  for (const item of items) {
    if (!existsSync(item.sourcePath)) {
      throw new Error(
        `Collection "${item.collection}" references missing ${item.type} source: ${relative(TOOLKIT_ROOT, item.sourcePath)}`,
      );
    }

    if (item.type === "command") {
      installCommand(item.sourceName, item.sourcePath);
      continue;
    }

    if (item.type === "hook") {
      installHook(item.sourceName, item.sourcePath);
      continue;
    }

    installSkill(item.sourceName, item.sourcePath, []);
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
    const installedHash = existsSync(installedPath)
      ? shortHash(readFileSync(installedPath))
      : null;

    const sourceChanged = sourceHash !== entry.hash;
    const locallyModified =
      installedHash !== null && installedHash !== entry.hash;

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
      const oldSrc = existsSync(installedPath)
        ? readFileSync(installedPath, "utf8")
        : "";
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

  for (const [name, entry] of Object.entries(manifest.commands)) {
    const src = join(COMMANDS_SRC, `${name}.md`);
    if (!existsSync(src)) {
      continue;
    }

    const sourceHash = hashCommandSource(name);
    if (sourceHash === entry.hash) {
      continue;
    }

    changed = true;
    console.log(`\n~ command: ${name} (${entry.hash} → ${sourceHash})`);
    const ok = force || (await confirm(`Update command "${name}"?`));
    if (!ok) {
      continue;
    }

    const dest = join(CLAUDE_DIR, "commands", `${name}.md`);
    writeFileSync(dest, readFileSync(src));
    manifest.commands[name] = { hash: sourceHash, installedAt: today() };
  }

  if (changed) {
    writeManifest(manifest);
  }
}

function list(kind: "hook" | "skill" | "command"): void {
  if (kind === "command") {
    if (!existsSync(COMMANDS_SRC)) {
      console.log("(no commands available)");
      return;
    }
    const files = readdirSync(COMMANDS_SRC)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
    if (files.length === 0) {
      console.log("(no commands available)");
      return;
    }
    for (const name of files) {
      console.log(`${name}  ${hashCommandSource(name)}`);
    }
    return;
  }

  const dir = kind === "hook" ? HOOKS_SRC : SKILLS_SRC;
  if (!existsSync(dir)) {
    console.log(`(no ${kind}s available)`);
    return;
  }
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() || (kind === "skill" && e.isSymbolicLink()))
    .map((e) => e.name);

  if (entries.length === 0) {
    console.log(`(no ${kind}s available)`);
    return;
  }

  for (const name of entries) {
    const hash = kind === "hook" ? hashHookSource(name) : hashSkillSource(name);
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
  toolkit add command <name>
  toolkit add collections <name>
  toolkit update [--force]
  toolkit list hook
  toolkit list skill
  toolkit list command
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
      links: {
        multiple: true,
        type: "string",
      },
    },
    allowPositionals: true,
  });

  const { force, links } = values;
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

    addSkill(name, links ? links : []);
    return;
  }

  if (command === "add" && resource === "command") {
    if (!name) {
      usage();
    }

    addCommand(name);
    return;
  }

  if (
    command === "add" &&
    (resource === "collection" || resource === "collections")
  ) {
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

  if (
    command === "list" &&
    (resource === "hook" || resource === "skill" || resource === "command")
  ) {
    list(resource as "hook" | "skill" | "command");
    return;
  }

  if (
    command === "list" &&
    (resource === "collection" || resource === "collections")
  ) {
    listCollections();
    return;
  }

  usage();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
