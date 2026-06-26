---
name: minimal-subagent
description: Delegate focused work to one or more child agents in parallel via the `subagent` tool. Use for code review, recon/scouting, research, planning, second opinions, or any task that benefits from a fresh focused context — especially several independent slices that can run at once.
---

# Delegating with `subagent`

You stay the orchestrator. `subagent` runs focused child agents in parallel and
returns their results. There are no chains or background jobs: for sequential
work, call the tool again with the previous result baked into the next task.

## See what's available

```
subagent({ action: "list" })
```

Lists every agent (bundled + your custom ones in `~/.pi/agent/agents/` and
`.pi/agents/`). Do this when unsure which agent to use, or when the task hints
at a role you haven't used before.

Bundled: **scout** (codebase recon), **reviewer** (diff/plan review),
**planner** (implementation plan), **oracle** (second opinion, challenges
assumptions), **worker** (implements changes).

## Run agents

```
subagent({ tasks: [
  { agent: "reviewer", task: "Review this diff for correctness and edge cases." },
  { agent: "reviewer", task: "Check test coverage for the diff." },
]})
```

- Multiple tasks run **concurrently** — split independent work into separate tasks.
- Give each child a **concrete, self-contained instruction** (it can't see this conversation).
- Set a per-task `model` to use a **cheaper/faster** model for light work (recon,
  summarizing) and a stronger one for hard work (review, planning).

## When to reach for it

- **Parallel review:** fan out reviewers on different angles (correctness, tests, simplicity).
- **Scout → plan:** `scout` to understand unfamiliar code, then `planner` to turn it into steps.
- **Second opinion:** `oracle` before a risky change — it challenges assumptions, doesn't edit.
- **Research/recon** that would flood your context with raw output — delegate, get the distilled answer back.

In zellij/tmux, each subagent streams live in its own pane and auto-closes when
done. Pass `observe: false` to skip the panes.
