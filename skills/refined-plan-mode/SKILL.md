# Refined Plan Mode

Use this skill when the user asks to plan, review, revise, continue, checkpoint, handoff, reset, or execute work using Refined Plan Mode.

This skill is additive to the agent's current planning guidance. It turns a plan into a versioned Markdown artifact that can be reviewed with line, range, and text-selection comments. The agent remains responsible for reading feedback, revising the plan, and moving only when the user has approved the plan or explicitly asks to proceed.

## Core Protocol

Before deciding what to do, inspect the local `.plan-review` state:

- `.plan-review/.current-version`
- `.plan-review/approved-plan.md`
- `.plan-review/plans/`
- `.plan-review/feedback/`

Then choose the next state transition:

1. If `.plan-review/approved-plan.md` exists, read it and execute the approved plan carefully.
2. If a current version exists and `.plan-review/feedback/plan-vN-feedback.json` exists for it, read the current plan and feedback, address every feedback item in a revised next plan version, update `.plan-review/.current-version`, and stop for review.
3. If a current version exists with no feedback and no approval, report that the plan is awaiting review and include the reviewer launch command.
4. If no current plan exists, clarify only what is necessary, inspect the repository enough to produce a useful plan, write `.plan-review/plans/plan-v1.md`, write `v1` to `.plan-review/.current-version`, and stop for review.

Users can ask for checkpoint, handoff, or reset in natural language:

- For a checkpoint, report the current version, latest plan path, feedback status, approval status, and recommended next action.
- For a handoff, summarize the goal, current plan, feedback status, approval status, important assumptions, unresolved decisions, and recommended next action.
- For a reset, empty only `.plan-review` while keeping the `.plan-review` directory itself. Do not remove source files or any other workspace files.

## File Convention

```text
.plan-review/
  .current-version
  plans/
    plan-v1.md
    plan-v2.md
  feedback/
    plan-v1-feedback.json
    plan-v2-feedback.json
  approved-plan.md
```

Create missing directories when needed. Never summarize or truncate the plan file itself. The file should be self-contained enough for another agent to understand the goal, context, constraints, implementation steps, validation steps, and open questions.

## Plan Shape

Prefer this structure unless the task clearly calls for something else:

```markdown
# Plan vN: Short Title

## Goal

## Current Understanding

## Assumptions

## Open Questions

## Proposed Changes

## Validation

## Risks

## Rollback or Recovery
```

Keep the plan practical. Include file paths, commands, and decision points when known. Call out assumptions explicitly instead of hiding uncertainty inside confident prose.

## Reviewer Launch Command

Whenever you write or advance to a plan version that is ready for user review, include a command the user can run from the Refined Plan Mode project root.

Prefer an absolute path to the target project's `.plan-review` directory when you know it:

```sh
PLAN_REVIEW_DIR=/absolute/path/to/project/.plan-review vp dev --host 127.0.0.1 --port 5173
```

If only a home-relative path is known, shell expansion is acceptable:

```sh
PLAN_REVIEW_DIR=~/dev/target-project/.plan-review vp dev --host 127.0.0.1 --port 5173
```

Use the toolchain command documented by the Refined Plan Mode project. For the Vite+ project, use `vp dev` rather than invoking the package manager directly.

## Feedback Handling

When feedback exists:

- Read the relevant JSON feedback file before revising.
- Treat every unresolved comment as actionable until clearly addressed.
- Preserve useful parts of the previous plan.
- Add a short `Feedback Addressed` section to the revised plan that maps comments to the changes made.
- If feedback conflicts or cannot be satisfied safely, explain that in the revised plan and ask the user for the smallest useful decision.

## Execution Gate

Do not begin implementation from an unapproved plan unless the user explicitly asks you to proceed. Once `.plan-review/approved-plan.md` exists or the user directly approves the plan in conversation, execute the approved plan and keep the normal agent workflow: inspect files, make focused edits, validate, and report the outcome.

## User Updates

In conversation, keep updates brief:

- Say which plan version was written.
- Say where feedback should be submitted.
- Include the reviewer launch command when a plan is ready for review.
- Say which feedback file was read when revising.
- Say when the plan is approved and execution is beginning.

The plan file carries the detail; the chat message should help the user orient without duplicating the full artifact.
