# Subagent model selection

Opinionated defaults, not an allowlist or universal model ranking. Select by task
difficulty, not agent name alone. Explicit user model/provider choices take precedence.

## Luna — fast, economical execution

Search: `gpt-6-luna`

Prefer for scouting, file mapping, bounded investigation, and mechanical
implementation with precise instructions. Consider `xhigh` thinking for
implementation. Escalate when substantial judgment or ambiguity resolution is needed.

## Sol — general-purpose strong model

Search: `gpt-6-sol`

Prefer for substantive implementation, debugging, code review, and tasks requiring
judgment. Default when Luna is insufficient and Astra is unnecessary.

## Astra — exceptional reasoning

Search: `gpt-6-astra`

Reserve for genuinely difficult analysis, oracle consultations, and independent
second opinions. Do not choose for implementation. Treat as the most expensive
option here; do not use merely because a task is important.

## Provider preference

Prefer `openai-codex` when it offers the selected model, to use the subscription
rather than separately billed API access. Avoid `openrouter` and other separately
billed providers unless the user explicitly authorizes them. If the recommended
model is unavailable through `openai-codex`, ask before using another provider.

These are instructions for selection, not enforced billing protection.

## Resolve before selecting

Use `subagent({ action: "models", query: "luna" })` (or another search term) to
find exact available `provider/model-id` values. Do not assume a recommendation
is installed or invent an identifier. For multiple matches, apply the provider
preference above; ask if that does not resolve the choice. If none match, report it.

Pass the selected exact ID in the task's `model` field. To override agent thinking,
append a Pi thinking suffix, e.g. `openai-codex/gpt-6-luna:xhigh`, when supported.
