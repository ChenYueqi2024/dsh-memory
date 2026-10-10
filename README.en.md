# dsh-memory

[![test](https://github.com/ChenYueqi2024/dsh-memory/actions/workflows/test.yml/badge.svg)](https://github.com/ChenYueqi2024/dsh-memory/actions/workflows/test.yml)

**Cross-session project memory for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness)** — a native Cordis plugin (MIT).

Every dsh session starts amnesiac: project conventions, tech decisions, and your preferences must be restated each time, or hand-maintained in AGENTS.md files. dsh-memory gives the agent durable project memory instead:

- **Auto-sedimentation** — at each turn boundary (`agent/turn-stopping`), one auxiliary LLM call extracts durable facts/decisions/conventions/preferences from the conversation (JSON contract, no impact on the main agent loop).
- **Semantic dedupe + conflict adjudication** — rephrased duplicates reinforce the original row; when new information overturns an old memory, the LLM emits `supersede` and the stale row is retired (kept for audit, never injected again).
- **Workspace scoping** — memories are tagged per project path; multi-project setups never cross-contaminate.
- **Relevance-ranked injection** — on every new agent, memories are ranked by effective confidence (per-kind half-life decay: facts 14d, decisions 30d, preferences 45d) + keyword overlap, bounded by a character budget.
- **Provenance & control** — every injected memory carries its source session and date; `memory_list` / `memory_approve` / `memory_forget` / `memory_extract` tools keep the store user-governable. Optional `requireApproval` mode holds auto-extracted memories until approved.

> The plugin ships **no API key**: extraction runs through the host dsh instance's own model route and credentials — you consume your own tokens. Override `provider`/`model` in the patch config to match your setup.

## Quick start

```bash
git clone https://github.com/ChenYueqi2024/dsh-memory && cd dsh-memory
npm install && npm run build && npm test   # 27 unit tests

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

## License

MIT
