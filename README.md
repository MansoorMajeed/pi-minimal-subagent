# pi-minimal-subagent

A deliberately small Pi extension: **one tool** that fans out N child agents in
parallel, returns their results, and (in zellij/tmux) shows each one live in its
own pane. No chains, no acceptance gates, no background job tracking, no
worktrees — the parent session stays the orchestrator.

~700 lines. If you want the full orchestration framework, use
[`pi-subagents`](https://github.com/nicobailon/pi-subagents) instead.

## Install

(via git ssh)
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

Sequential work needs no special syntax — Pi just calls the tool again with the
previous result baked into the next task.

### The tool

```ts
subagent({
  tasks: [
    { agent: "scout",    task: "map the auth flow",           model: "anthropic/claude-haiku-4-5" },
    { agent: "reviewer", task: "review this diff for bugs" },
  ],
  observe: true,   // default: true when zellij/tmux is detected
})
```

The tool's text content is a per-task summary; the structured results are on
`details.results`, one per task: `{ agent, ok, answer, exitCode, logPath, timedOut, error? }`.
Up to 8 tasks per call, run with a concurrency of 4; the call returns when every
child is done. Use `subagent({ action: "list" })` to enumerate available agents.

## Models — use cheap ones where you can

Two ways to pick a model (cheaper/faster for light work, stronger for hard work):

- **Per task:** `model` field on a task (highest precedence).
- **Per agent (default):** `model:` in the agent's frontmatter.

If neither is set, the child inherits Pi's current default model. List options
with `pi --list-models`.

## Agents

An agent is a markdown file: frontmatter + a system-prompt body. Resolved from,
lowest to highest precedence:

1. bundled (`agents/` in this package)
2. user (`~/.pi/agent/agents/`)
3. project (`.pi/agents/`)

Bundled: `scout`, `reviewer`, `planner`, `oracle`, `worker`. Frontmatter fields:

```yaml
---
name: scout
description: short description
tools: read, grep, find, ls, bash   # builtin tool allowlist (string or YAML list; omit = all)
thinking: medium                     # off | minimal | low | medium | high | xhigh
model: anthropic/claude-haiku-4-5   # optional default model
systemPromptMode: append             # append (default) | replace
---
Body becomes the child's system prompt.
```

## The observer (zellij / tmux)

When a multiplexer is detected, each subagent gets a live pane:

- **zellij:** a right-hand column splits into N stacked panes (one per agent),
  focus returns to your Pi pane. Each pane streams the child's text and tool
  calls, then **auto-closes ~4s after that agent finishes**.
- **tmux:** best-effort equivalent via `split-window`.
- **no multiplexer:** the tool prints a `tail -F` hint instead.

Set `observe: false` to skip the panes.

## How it works

Each subagent is a headless `pi --print --mode json` child process. Its JSONL
event stream is written to a per-run log under `$TMPDIR/pi-minsub/<run>/`. The
parent parses the final `agent_end` event to recover the answer; the observer
pane follows the same log and renders it live. Per-task timeout defaults to 10
minutes.
