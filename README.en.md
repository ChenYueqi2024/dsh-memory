# dsh-memory

[![test](https://github.com/ChenYueqi2024/dsh-memory/actions/workflows/test.yml/badge.svg)](https://github.com/ChenYueqi2024/dsh-memory/actions/workflows/test.yml)

**Cross-session project memory for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness)** — a native Cordis plugin (MIT).

Current version: **v0.5.1**. Hot installation now attaches memory injection to existing Agents, and unloading closes the storage domain for reactivation. See the [v0.5.1 release](https://github.com/ChenYueqi2024/dsh-memory/releases/tag/v0.5.1). The paid-model study belongs to **v0.4.1**; it does not evaluate this fix. See [hot-install validation](docs/hot-install-validation.md).

Every dsh session starts amnesiac: project conventions, tech decisions, and your preferences must be restated each time, or hand-maintained in AGENTS.md files. dsh-memory gives the agent durable project memory instead:

- **Auto-sedimentation** — at each turn boundary (`agent/turn-stopping`), one auxiliary LLM call extracts durable facts/decisions/conventions/preferences from the conversation (JSON contract, no impact on the main agent loop).
- **Semantic dedupe + conflict adjudication** — rephrased duplicates reinforce the original row; when new information overturns an old memory, the LLM emits `supersede` and the stale row is retired (kept for audit, never injected again).
- **Workspace scoping** — injection and management tools see the current workspace plus globals; extraction modifies only the current workspace. Missing-session and subagent tool calls are rejected.
- **Relevance-ranked injection** — ordinary memories use per-kind half-life decay (facts 14d, decisions/conventions 30d, preferences 45d) + keyword overlap, bounded by a character budget. These durations are engineering heuristics, not calibrated optima.
- **User-selected persistence** — `memory_pin({id, pinned: true})` exempts one approved, active row from time decay; `false` resumes decay using its original age, possibly immediately excluding it. Use list/extract to identify the row first. Dedupe and reinforcement preserve the flag, but replacement rows do not inherit it. Pins still obey scope, approval, retirement, relevance and prompt budgets; they can be deleted. Extraction cannot nominate pins. Explicit user intent is followed through a model-callable tool, not a separate authentication boundary. Five tools: memory_list / memory_forget / memory_extract / memory_approve / memory_pin.
- **Provenance & control** — injected references contain the memory row ID and its creation/latest-reinforcement date, not a session ID or immutable evidence timestamp. The stored row separately retains its initial `sourceSessionId`. Optional `requireApproval` holds replacements pending and retires conflicting old facts only after approval; explicit extraction can approve existing pending rows. Approval is a model-callable tool, not a separate human-authentication boundary.

> The plugin ships **no API key**: extraction runs through the host dsh instance's own model route and credentials — you consume your own tokens. Override `provider`/`model` in the patch config to match your setup.

## Quick start

```bash
git clone https://github.com/ChenYueqi2024/dsh-memory && cd dsh-memory
npm ci && npm test   # prepare builds automatically; 58 automated tests

# install into a profile, then add to its cordis.patch.yml:
# - insert:
#     - id: dsh-memory
#       name: dsh-memory
#       config: { provider: deepseek-official, model: deepseek-flash }
```

Verify:

```bash
dsh --profile <name> "Remember: this project always uses pnpm, never npm."
dsh --profile <name> "What package manager does this project use? How do you know?"   # ← new session, it remembers
```

Full documentation (config, design decisions, architecture): see [README.md](README.md) (Chinese).

Git installs build through `prepare`. If pnpm reports `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`, add only its exact package-and-commit key to the profile's `allowBuilds`, preserving existing settings, then retry. Runtime peers come from dsh 0.2.0-rc.2 (Cordis itself is 4.0.4).

Failed extraction preserves the transcript cursor for a later eligible retry; throttling is per session. Retired rows never absorb returning facts. Schema v6 reads v1–v5; missing pinned fields remain ordinary. Rolling back requires an older data backup. Run `node scripts/verify-host.mjs <isolated-profile> <dsh-install-directory> <fresh-test-storage> [legacy-version]` for real Loader/schema/JSON-storage verification across four boots, including pin/unpin at age 365 days. Deterministic LLM output and time tests are separate from paid-model quality evaluation and full CLI/Web/TUI testing. See [v0.5.0 validation](docs/persistent-memory-validation.md).

Conflict outputs do not pair each new fact with an old row, so retirement waits for every replacement in the batch to remain present and approved. Deleting one candidate keeps the old facts active; explicitly re-extract or clean them up when appropriate.

## Controlled evaluation

The [evaluation protocol](evaluation/README.md) compares no persistence, a frozen curated AGENTS.md, and dsh-memory on 20 shared cases, with four separate approval/deletion diagnostics. Run `npm run test:eval` for offline evaluator checks and `node evaluation/run.mjs --mode plan` for the request budget.

The [2026-11-14 full report](evaluation/reports/2026-11-14-full-evaluation.md) records three repetitions of 20 fixed synthetic cases: **15/60, 51/60, and 60/60** correct answers respectively. All nine gains over the frozen file concern changed conventions; memory also used **5.73 times** the static group's tokens, including extraction. Separate governance diagnostics passed 12/12. This controlled-context study does not establish general real-world accuracy or superiority to continuously maintained AGENTS.md files; costs, evidence hashes, and limitations are included in the report.

## License

MIT
