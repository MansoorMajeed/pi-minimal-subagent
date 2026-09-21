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
    { agent: "scout", task: "map the auth flow", label: "Map auth flow", model: "anthropic/claude-haiku-4-5" },
    { agent: "reviewer", task: "review this diff for bugs", label: "Review correctness" },
  ],
})
```

Up to 8 tasks run with concurrency 4. Use
`subagent({ action: "list" })` to enumerate bundled and custom agents and read
model-selection guidance.

| Task field | Behavior |
|---|---|
| `agent` | Required agent name. |
| `task` | Required complete child instructions. |
| `label` | Optional concise display goal; never replaces or modifies `task`. |
| `model` | Optional per-task model override. |

## Inline activity

While a call is running, each child keeps a six-row status tail in any terminal
or multiplexer:

```text
● scout running model: anthropic/claude-haiku-4-5 [12,400 tok · $0.0310]
  Goal: Map auth flow
  Elapsed 3m 12s · timeout in 26m 48s · 17 turns
  Reported: mapped middleware; checking refresh-token handling
  ↳ read src/auth.ts
  ↳ bash git diff --stat
```

The status always uses exactly six display rows per child: a header, goal,
elapsed/timeout budget, latest reported milestone, and the two latest observed
activities. Missing rows are padded above the activity tail. Queued children do
not accrue runtime; terminal elapsed time freezes. An explicit turn cap appears
as, for example, `17/80 turns`. The timeout countdown is a hard execution budget,
not an ETA.

The optional task `label` is display-only. Without one, the goal is a clipped
single-line preview of the task; the complete original task remains available
in expanded view while the child is running. `Ctrl+O` shows assigned tasks and,
after completion, the full child output below the fixed status block. Rows are
Unicode-safely clipped to terminal width rather than wrapped.

Children are instructed to emit sparse standalone
`Progress: <completed milestone; next step or blocker>` lines. `Reported:` shows
the latest such completed assistant message. This is self-reported, may be
omitted or inaccurate, and does not imply a percentage or ETA. Observed tool
activity remains separate. Updates come from the child's JSONL stream; one
clock refresh per tool call advances timing during silence without adding model
messages or transcript entries.

There is no split-pane observer or `observe` parameter.

## Models

Model precedence is:

1. `model` on an individual task.
2. `model:` in the agent's frontmatter.
3. Pi's configured default model.

### Selection guidance

`subagent({ action: "list" })` includes the bundled
[`SUBAGENT_MODELS.md`](SUBAGENT_MODELS.md): opinionated Luna/Sol/Astra recommendations
and a preference for `openai-codex` subscription access over separately billed
providers. These are author preferences, not universal rankings, automatic routing,
or enforced billing protection. Explicit user choices take precedence.

Create `~/.pi/agent/SUBAGENT_MODELS.md` to **replace the entire guide** with your own
model and provider preferences. If you use `PI_CODING_AGENT_DIR`, place the file in
that directory instead. For example:

```markdown
# My subagent models

Prefer my local Qwen model for bounded scouting and mechanical changes.
Ask me before selecting a separately billed provider.
Search available models before choosing an exact provider/model ID.
```

The file is read on every `action: "list"` call; no restart is needed. An empty
file removes model guidance, and deleting the file restores bundled defaults.
Unreadable files report an error rather than silently restoring another policy.
There is no project override or merging. The response identifies the active file;
guidance is returned on discovery, not injected into every system prompt. Keep it
short: discovery exceeding 50KB or 2000 lines is rejected rather than returning
an incomplete policy.

### Find actual model IDs

```ts
subagent({ action: "models", query: "luna" })
subagent({ action: "models", query: "openai-codex/gpt-5.6-sol" })
```

A nonblank query is required. Searches filter Pi's available registry locally by
case-insensitive literal substring of the model name or `provider/model-id`.
They return exact IDs and names, sorted by provider/ID, with **at most 50 matches**
and a 50KB/2000-line output bound. Broad searches tell the parent to narrow the
query; the full catalogue is never dumped automatically. Multiple providers
remain visible so the parent can apply the guide's preferences.

Registry availability means configured authentication, not verified quota, billing,
or a successful live request. Search does not call a model, refresh remote
catalogues, expose credentials, or filter to the parent's model-cycling scope.
Children are separate Pi processes: a model registered only in the parent may
not exist in a child's differently configured environment.

Pass the chosen exact ID through the existing task `model` field. A supported
thinking suffix (e.g. `openai-codex/gpt-5.6-luna:xhigh`) overrides agent thinking.
Discovery never changes model precedence or silently substitutes another model.

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
timeoutMs: 1800000
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
| `maxTurns` | Optional positive-integer hard cap. Omitted, invalid, or nonpositive values mean no turn cap. |
| `timeoutMs` | Positive integer wall-clock timeout in milliseconds; defaults to 1,800,000 (30 minutes). Values outside Node's supported timer range use the default. |

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
- Children run with `--no-session` and a 30-minute wall-clock timeout by
  default. Agent frontmatter can set `timeoutMs` to another supported positive
  integer.
- There is no default turn cap. A positive-integer `maxTurns` stops the child
  before the next turn after that many completed assistant turns; its last
  completed answer is retained.
- Each child receives its hard timeout, absolute UTC deadline, and optional turn
  cap in the task message. Deadline awareness and a pre-deadline handoff are
  best effort: there is no guaranteed warning, checkpoint, or safe interruption
  boundary. The existing hard timeout still terminates the process group.
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
