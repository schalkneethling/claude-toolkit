#!/usr/bin/env node

/**
 * toolkit — personal CLI for managing Claude Code hooks and skills.
 *
 * Commands:
 *   toolkit add hook <name>
 *   toolkit add skill <name> [--link <target>...]
 *   toolkit update [--force]
 *   toolkit list hook
 *   toolkit list skill
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
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const TOOLKIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS_SRC = join(TOOLKIT_ROOT, "hooks");
const SKILLS_SRC = join(TOOLKIT_ROOT, "skills");

const PROJECT_ROOT = process.cwd();
const CLAUDE_DIR = join(PROJECT_ROOT, ".claude");
const TOOLKIT_DIR = join(PROJECT_ROOT, ".claude-toolkit");
const MANIFEST_PATH = join(CLAUDE_DIR, "toolkit-manifest.json");

type HookEntry = { hash: string; installedAt: string };
type SkillEntry = { hash: string; installedAt: string; linkedTo: string[] };
type Manifest = {
  hooks: Record<string, HookEntry>;
  skills: Record<string, SkillEntry>;
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
    return { hooks: {}, skills: {} };
  }

  try {
    const parsed = JSON.parse(
      readFileSync(MANIFEST_PATH, "utf8"),
    ) as Partial<Manifest>;
    return { hooks: parsed.hooks ?? {}, skills: parsed.skills ?? {} };
  } catch {
    return { hooks: {}, skills: {} };
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

function addHook(name: string): void {
  const srcDir = join(HOOKS_SRC, name);
  if (!existsSync(srcDir)) {
    console.error(`Hook not found: ${name}`);
    process.exit(1);
  }

  const hookSrc = join(srcDir, "hook.mjs");
  const fragmentPath = join(srcDir, "settings-fragment.json");

  const hooksDir = join(CLAUDE_DIR, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const destHook = join(hooksDir, `${name}.ts`);
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

function addSkill(name: string, links: string[]): void {
  const srcDir = join(SKILLS_SRC, name);
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
    console.error(`Skill not found: ${name}`);
    process.exit(1);
  }

  const destDir = join(TOOLKIT_DIR, "skills", name);
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
    const installedPath = join(CLAUDE_DIR, "hooks", `${name}.ts`);
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

  if (changed) {
    writeManifest(manifest);
  }
}

function list(kind: "hook" | "skill"): void {
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

// ---------- argv ----------

function usage(): never {
  console.error(
    `Usage:
  toolkit add hook <name>
  toolkit add skill <name> [--link <target>]...
  toolkit update [--force]
  toolkit list hook
  toolkit list skill`,
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

  if (command === "update") {
    await update(force);
    return;
  }

  if (command === "list" && (resource === "hook" || resource === "skill")) {
    list(resource);
    return;
  }

  usage();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
