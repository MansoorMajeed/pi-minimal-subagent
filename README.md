# pi-minimal-subagent

A deliberately small Pi extension: **one tool** that fans out focused child
agents in parallel, streams compact activity inline, and returns their results.
No chains, background jobs, wait tool, forked sessions, intercom, worktrees, or
persistent child sessions — the parent stays the orchestrator.

If you need the full orchestration framework, use
[`pi-subagents`](https://github.com/nicobailon/pi-subagents) instead.

## Install

```bash
pi install git:git@github.com:MansoorMajeed/pi-minimal-subagent.git
```

## Use

Ask in plain language — Pi calls the `subagent` tool:

```text
Run two reviewers in parallel: one on correctness, one on test coverage.
```

```text
Use scout to map the auth flow while a researcher checks the upstream API docs.
```

Sequential work needs no special syntax: Pi calls the tool again with the
previous result included in the next task.

```ts
subagent({
  tasks: [
    { agent: "scout", task: "map the auth flow", model: "anthropic/claude-haiku-4-5" },
    { agent: "reviewer", task: "review this diff for bugs" },
  ],
})
```

Up to 8 tasks run with concurrency 4. Use
`subagent({ action: "list" })` to enumerate bundled and custom agents.

## Inline activity

While a call is running, each child keeps a six-row status tail in any terminal
or multiplexer:

```text
● scout running model: anthropic/claude-haiku-4-5
  ↳ queued
  ↳ started
  ↳ thinking
  ↳ read src/auth.ts
  ↳ bash git diff --stat
```

The status always uses exactly six display rows per child: a header and the five
most recent activities, padded above until history fills in. `Ctrl+O` does not
change the status block; after completion it shows or hides the full child
output below it. Status rows are clipped to the terminal width instead of
wrapping, so the block stays in place while activity changes. The header shows
the configured model until the child reports its resolved provider/model, and
includes turns, tokens, and cost when available. Updates come directly from
each child's JSONL event stream and TUI rendering is throttled to avoid churn;
streaming text replaces one live tail entry instead of adding a row per delta.

There is no split-pane observer or `observe` parameter.

## Models

Model precedence is:

1. `model` on an individual task.
2. `model:` in the agent's frontmatter.
3. Pi's configured default model.

Use cheaper/faster models for recon and stronger models for difficult review or
implementation. List available models with `pi --list-models`.

## Agents

An agent is a Markdown file containing frontmatter and a system-prompt body.
Sources, lowest to highest precedence:

1. bundled (`agents/`)
2. user (`~/.pi/agent/agents/`)
3. project (`.pi/agents/`)

The format remains compatible with pi-subagents/tmux-subagent agent files:

```yaml
---
name: scout
description: Fast codebase recon
tools: read, grep, find, ls, bash
thinking: medium
model: anthropic/claude-haiku-4-5
systemPromptMode: append
inheritProjectContext: true
maxTurns: 12
---

Agent system prompt.
```

Supported runtime frontmatter:

| Field | Behavior |
|---|---|
| `model` | Default child model. |
| `thinking` | Child thinking level unless the model already includes one. |
| `tools` | Pi tool allowlist. Omitted keeps Pi's normal active tools. |
| `systemPromptMode` | `append` (default) or `replace`. |
| `extensions` | Omitted loads normal extensions; empty disables discovery; values explicitly allowlist extension paths. |
| `inheritProjectContext` | Defaults to `true`; `false` passes `--no-context-files`. |
| `maxTurns` | Positive integer hard cap; defaults to 50 completed assistant turns. |

Extension allowlist examples:

```yaml
# Disable extension discovery for this child.
extensions:

# Or load only explicit extensions.
extensions: /absolute/path/a.ts, /absolute/path/b.ts
```

Disabling extensions also removes extension-provided safety guards. Do not do it
for a mutating worker unless its tool allowlist and execution environment are
safe without those guards.

## Safety and limits

- Child processes receive `PI_MINIMAL_SUBAGENT_CHILD=1`; this package does not
  register another `subagent` tool inside them, preventing recursive fan-out.
- Children run with `--no-session` and a 10-minute wall-clock timeout.
- `maxTurns` defaults to 50. A child may finish naturally on turn 50; it is
  stopped only if it attempts turn 51. Its last completed answer is retained.
- The parent abort signal terminates the child's whole process group, with a
  SIGKILL fallback.
- Child-derived terminal controls are stripped at the TUI boundary without
  changing the stored or model-facing answer.

## Results, usage, and large outputs

The model-facing result is a per-task summary. Structured results are available
on `details.results`, one per task:

```text
agent, ok, answer, inlineAnswer, outputPath?, exitCode, logPath,
timedOut, turnLimitExceeded, error?, usage, activity
```

`answer` always retains the complete child response in structured details.
Answers over 16 KiB are also written to `<task>-output.md` beside the JSONL log;
`inlineAnswer` contains an approximately 8 KiB excerpt and the file path. If the
file write fails, the full answer stays inline rather than being lost. Failed
child stderr diagnostics are capped at 4 KiB.

`usage` aggregates provider-reported input, output, cache-read, cache-write,
total/context tokens, cost, and assistant turns. Usage stays in details and TUI
rendering rather than adding accounting prose to model context.

Run artifacts live under `$TMPDIR/pi-minsub/<run>/` and include one JSONL event
log per child plus any spilled Markdown output.

## How it works

Each child is a headless `pi --print --mode json --no-session` process. The
parent incrementally parses stdout, tees it to a JSONL log, derives activity and
usage, and extracts the last assistant message. Calls remain synchronous: the
parent tool returns only after every child completes, fails, times out, or hits
its turn limit.

## Development

```bash
npm test
npm run check
npm pack --dry-run
```
