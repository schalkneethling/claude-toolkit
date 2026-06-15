# claude-toolkit

CLI for managing [Claude Code](https://claude.com/claude-code) hooks, skills, agents, and collections across projects. Hooks are copied into a project's `.claude/` directory; skills and agents are copied into `.claude-toolkit/` and symlinked into wherever Claude Code expects to find them; collections install any combination of those resources from a bundled root config.

## Repo layout

```plaintext
.
├── config.json                     # bundled collection definitions
├── agents/                         # Claude Code subagent Markdown files
├── hooks/
│   ├── auto-approve-safe-commands/
│   │   ├── hook.mjs                # the hook script itself
│   │   └── settings-fragment.json  # deep-merged into .claude/settings.json on install
│   └── block-dangerous-commands/
│       ├── hook.mjs
│       └── settings-fragment.json
├── skills/                         # skill directories dropped here
├── src/
│   └── index.ts                    # the toolkit CLI
├── package.json
├── README.md
├── tsconfig.json
├── tsconfig.hooks.json
└── vite.config.ts
```

## Requirements

- Node.js 22+
- `tsx` (installed as a devDependency)

From inside a consuming project, run the CLI with `tsx /path/to/claude-toolkit/src/index.ts <command>`, or link it as `toolkit` on your `PATH`.

## Commands

### `toolkit add hook <name>`

Copies `hooks/<name>/hook.ts` into `<project>/.claude/hooks/<name>.ts` and deep-merges `hooks/<name>/settings-fragment.json` into `<project>/.claude/settings.json`. Records the source hash in `.claude/toolkit-manifest.json`.

### `toolkit add skill <name> [--link <target>]...`

Copies `skills/<name>/` into `<project>/.claude-toolkit/skills/<name>/` and creates a symlink to that directory inside each `--link` target. If no `--link` is given, the default is `.claude/skills`. Repeat `--link` to create symlinks in multiple locations.

```
toolkit add skill css-shared-first --link .claude/skills --link docs/skills
```

### `toolkit add agent <name> [--link <target>]...`

Copies `agents/<name>.md` into `<project>/.claude-toolkit/agents/<name>.md` and creates a symlink to that file inside each `--link` target. If no `--link` is given, the default is `.claude/agents`. Repeat `--link` to create symlinks in multiple locations.

```
toolkit add agent technical-devils-advocate
```

### `toolkit add collections <name>`

Reads the root `config.json`, resolves the named collection, and installs each referenced hook, skill, or agent using the same underlying logic as the individual `add` commands.

```bash
toolkit add collections web
```

### `toolkit update [--force]`

For every entry in `.claude/toolkit-manifest.json`, compares the current source hash to the installed hash:

- If the source changed, shows a line-diff and prompts before overwriting.
- If the installed file was modified locally (its hash differs from the one recorded in the manifest), warns and skips unless `--force` is passed.
- Silent if everything is current.

### `toolkit list hook` / `toolkit list skill` / `toolkit list agent`

Lists available hooks, skills, or agents shipped by this repo, with the current source hash.

### `toolkit list collections`

Lists available collection names from the bundled `config.json`, along with the number of items each collection installs.

For compatibility, the CLI accepts both singular and plural forms:

```bash
toolkit add collection web
toolkit add collections web
toolkit list collection
toolkit list collections
```

## Collections config

Collections are defined in the repo root `config.json` as an array:

```json
[
  {
    "name": "web",
    "items": [
      {
        "type": "skill",
        "src": "skills/semantic-html"
      },
      {
        "type": "agent",
        "src": "agents/technical-devils-advocate.md"
      }
    ]
  }
]
```

- `name` must be unique.
- `items` may contain `skill`, `hook`, or `agent` entries.
- `src` must point to a top-level entry under `skills/`, `hooks/`, or `agents/`.
- Plural `type` values such as `skills` are also accepted for compatibility.

## Versioning

- Each hook is hashed over `hook.mjs` only (not the README or `settings-fragment.json`).
- Each skill is hashed over every file in the skill directory (sorted by path).
- Each agent is hashed over its Markdown source file.
- SHA-256, truncated to the first 7 hex characters.

## Manifest format

The CLI writes `<project>/.claude/toolkit-manifest.json`:

```json
{
  "hooks": {
    "block-dangerous-commands": {
      "hash": "a3f9c2d",
      "installedAt": "2026-04-18"
    }
  },
  "skills": {
    "css-shared-first": {
      "hash": "f91b3e1",
      "installedAt": "2026-04-18",
      "linkedTo": [".claude/skills"]
    }
  },
  "agents": {
    "technical-devils-advocate": {
      "hash": "c110f5e",
      "installedAt": "2026-04-18",
      "linkedTo": [".claude/agents"]
    }
  }
}
```

## Bundled agents

### `technical-devils-advocate`

A Claude Code project subagent for challenging feature plans, system designs, and implementation approaches before work begins. It surfaces assumptions, risks, edge cases, alternatives, dependencies, scale concerns, and operability questions, then recommends whether to proceed, pivot, or pause.

## Bundled hooks

### `block-dangerous-commands`

A `PreToolUse` hook for the `Bash` tool. Reads Claude Code's hook payload from stdin and denies commands that match any of:

- `rm -rf` (and flag variants: `-rf`, `-fr`, `--recursive --force`, etc.)
- `git push --force` / `-f` / `--force-with-lease`
- Direct push to `main`, `master`, `production`, `prod`, `release`
- `git reset --hard`
- `chmod 777` / recursive chmod granting world-write
- `dd if=…`
- Redirects into `/etc/`, `/boot/`, `/usr/`, `/bin/`, `/sbin/`
- The classic fork bomb
- Piping remote content into a shell (`curl … | bash`, `wget … | sh`)
- `pkill` and `kill -9` / `-SIGKILL`
- `npm publish`, `npm deprecate`, `npm unpublish`
- `history -c`

On a match it exits `2` with a structured JSON payload on stdout (`permissionDecision: "deny"` plus `permissionDecisionReason` explaining why). On any other input — malformed JSON, empty stdin, a non-string command — it fails open (exit `0`) so a broken hook never blocks all work.
