# Stats Accounting Integration Recommendations

`pi-minimal-subagent` runs child agents as separate `pi --print --mode json --no-session` processes. Their provider calls are billed independently, but their assistant messages are not persisted as native assistant messages in the parent session. A stats consumer that only sums parent `AssistantMessage.usage` therefore misses child usage.

The extension currently preserves recoverable child usage in the parent `subagent` tool result. This is enough for combined cost and token totals, but not enough for reliable model attribution, exact daily attribution, completeness reporting, or correlation with telemetry emitted inside child processes.

## Current Consumer Contract

A parent-session stats consumer should match finalized entries where:

```text
entry.type == "message"
entry.message.role == "toolResult"
entry.message.toolName == "subagent"
```

The canonical child records are:

```text
entry.message.details.results[index]
entry.message.details.results[index].usage
```

Consumers must not also sum:

```text
details.activities[index].usage
details.results[index].activity.usage
```

Those are duplicate views of the same usage.

Usage from failed, timed-out, aborted, or turn-limited children remains billable and should be counted whenever captured. `contextTokens` is a latest-context indicator and must not be added to cumulative totals. Older result shapes may omit `totalTokens`; consumers may fall back to the sum of the four reported token components when they are present.

The current details format is intentionally extension-specific but unversioned. Consumers must validate every level and tolerate missing fields.

## Recommended Versioned Accounting Envelope

Add a stable identifier and versioned accounting envelope while retaining the existing fields for compatibility:

```ts
{
  details: {
    schema: "pi-minimal-subagent/result@1",
    runId: "...",
    parent: {
      sessionId: "...",
      toolCallId: "..."
    },
    results: [
      {
        taskIndex: 0,
        agent: "reviewer",
        ok: true,
        timedOut: false,
        turnLimitExceeded: false,
        startedAt: "2026-07-17T20:00:00.000Z",
        endedAt: "2026-07-17T20:01:00.000Z",
        effectiveModel: {
          provider: "anthropic",
          id: "claude-sonnet-4",
          thinkingLevel: "high"
        },
        accounting: {
          schema: "pi-usage@1",
          completeness: "complete",
          usage: {
            input: 100,
            output: 20,
            cacheRead: 80,
            cacheWrite: 0,
            totalTokens: 200,
            cost: 0.03,
            turns: 1
          },
          byDay: [
            {
              date: "2026-07-17",
              input: 100,
              output: 20,
              cacheRead: 80,
              cacheWrite: 0,
              totalTokens: 200,
              cost: 0.03,
              turns: 1
            }
          ]
        }
      }
    ]
  }
}
```

### Field semantics

- `schema`: lets consumers reject unknown incompatible shapes instead of guessing.
- `runId`: a stable ID independent of parsing `runDir`.
- `parent.sessionId`: value from the parent `SessionManager` when persisted; absent for an ephemeral parent.
- `parent.toolCallId`: the custom tool execution ID.
- `taskIndex`: stable identity within a run; agent names are not unique.
- `startedAt` / `endedAt`: ISO timestamps for duration and coarse attribution.
- `effectiveModel`: the actual provider/model/thinking selection after applying per-task override, agent frontmatter, and Pi defaults. Do not ask consumers to reconstruct this precedence.
- `accounting.completeness`:
  - `complete`: every completed assistant event produced usable provider usage and the child ended normally.
  - `partial`: some usage was captured, but timeout, abort, forced termination, stream loss, or another condition may have omitted billable work.
  - `unavailable`: assistant work occurred but no usable provider accounting was reported.
- `accounting.usage`: cumulative provider-reported totals. Keep `contextTokens` outside cumulative accounting or omit it from this envelope.
- `accounting.byDay`: optional compact aggregation of completed assistant events by UTC day. This gives durable daily attribution without persisting every event in the parent session.

If one child can change models, replace singular `effectiveModel` with an accounting breakdown keyed by provider/model, or add `accounting.byModel`. Do not silently assign all usage to the initially selected model.

## Correlation for Child-Loaded Telemetry

When spawning each child, pass non-secret correlation metadata in environment variables:

```text
PI_MINIMAL_SUBAGENT_CHILD=1
PI_MINIMAL_SUBAGENT_RUN_ID=<run-id>
PI_MINIMAL_SUBAGENT_TASK_INDEX=<index>
PI_MINIMAL_SUBAGENT_PARENT_SESSION_ID=<session-id, when available>
PI_MINIMAL_SUBAGENT_PARENT_TOOL_CALL_ID=<tool-call-id>
```

This lets an event-driven extension loaded in the child associate native provider events with the persisted parent result. Environment values should identify the run, not contain task text or prompts.

Direct child telemetry and parent-result ingestion are two views of the same calls. A stats system using both must deduplicate by run ID, task index, and provider-event identity. Until correlation IDs exist, consumers should choose one source as authoritative rather than attempting heuristic deduplication.

## Consumer Accounting Rules

A durable stats integration should:

1. Use only `details.results[index].usage` for the legacy schema, or `results[index].accounting` for the versioned schema.
2. Deduplicate copied parent session history using the persisted tool-result entry identity plus result index. Forked or cloned session files can contain the same historical entry more than once.
3. Count all executed branches for financial spend; abandoning a branch does not undo provider billing.
4. Include failed child usage when present.
5. Keep parent/native, child/subagent, and combined totals separately visible.
6. Never infer a child model from the parent model or from task arguments alone.
7. Treat absent usage as unknown, not zero, when evidence shows a child assistant turn occurred.
8. Ignore `contextTokens` when summing cumulative tokens.
9. Avoid using temporary child JSONL artifacts as the only durable accounting source.

## Backward Compatibility

- Continue writing the existing top-level `result.usage` during a transition period.
- Add the versioned `accounting` object alongside it.
- Derive both views from one internal accumulator so they cannot diverge.
- Consumers should prefer the versioned envelope when recognized and fall back to legacy `result.usage` otherwise; never add both.
- Unknown future schema versions should be surfaced as unsupported/incomplete rather than silently interpreted.

Historical parent results with no `usage` cannot be made accurate after the temporary child artifacts disappear. Schema evolution improves future accounting; it does not justify fabricated backfill.

## Recommended Tests

Add tests covering:

- one-turn and multi-turn aggregation without double-counting repeated lifecycle events;
- multiple tasks with repeated agent names but distinct task indexes;
- complete, partial, and unavailable usage;
- normal failure, timeout, abort, and turn-limit behavior;
- provider usage with missing individual fields;
- exact provider/model selection after every precedence path;
- per-day aggregation across a UTC boundary;
- parent/session/tool/run correlation propagation into child environments;
- legacy and versioned result views generated from the same accumulator;
- consumers choosing the versioned view without also counting legacy or activity copies.

## Privacy

Accounting metadata should not include task text, prompts, child answers, credentials, or raw provider payloads. Provider/model IDs, timestamps, status, token counts, costs, and opaque correlation IDs are sufficient for stats integration.
