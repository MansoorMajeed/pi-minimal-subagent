# Subagent model selection

Choose by task difficulty, not agent name. Explicit user choices override these defaults.

- `gpt-6-luna`: Scouting, bounded investigation, and mechanical implementation with precise instructions. Consider `:xhigh` for implementation.
- `gpt-6.1-sol`: Substantive implementation, debugging, review, and tasks needing judgment.
- `gpt-6-astra`: Exceptionally difficult analysis, oracle consultations, and independent second opinions. Never implementation; most expensive, not merely for important tasks.

## Provider and resolution

- Use `openai-codex` for subscription access. Ask before using any separately billed provider, unless explicitly authorized.
- Resolve exact IDs with `subagent({ action: "models", query: "<model search>" })`. Never invent IDs or assume availability.
- Prefer `openai-codex` among matches; ask if still ambiguous. Report missing models.
- Pass the exact `provider/model-id` in the task’s `model` field. Append a supported thinking suffix when needed, e.g. `:xhigh`.

These are selection instructions, not enforced billing protection.
