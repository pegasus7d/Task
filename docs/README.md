# Design docs

Pre-implementation design work that fed into the code. These were written first, then the code was built against them. Reading order:

| # | File | What it covers |
|---|---|---|
| 1 | [`approach.md`](./approach.md) | Chosen approach: prompt strategies, retry-with-feedback shape, scoring families, hallucination-detection tiers, idempotency model. |
| 2 | [`lld.md`](./lld.md) | Low-level design — module boundaries, interface contracts (`IStrategy`, `ILLMAdapter`, `IValidator`, `IScorer`), retry-loop FSM, error taxonomy. |
| 3 | [`contracts.md`](./contracts.md) | The full wire-level contracts: HTTP request/response shapes, message-payload shape, validation-feedback envelope, retry budgets, rate-limit semantics, the FinalStatus enum. The largest doc — single source of truth for the API/SDK surface. |
| 4 | [`entities.md`](./entities.md) | Database entities — the 13-table schema with column-by-column rationale, indexes, constraints, hash columns (`prompt_hash` / `tools_hash` / `schema_hash` / `dataset_hash` / `config_hash`), and the FK graph. |
| 5 | [`runner-design.md`](./runner-design.md) | Runner-specific design: per-case retry FSM, idempotency replay, concurrency strategy, resume contract, SSE streaming (deferred), 429 budget split. |

These are honest snapshots of pre-build planning, not retro-fitted documentation. Some details drifted during implementation (e.g. the unique-index trade-off for `idempotency_key` was relaxed mid-build — see `NOTES.md` and commit `a4bc712`); the code is the ground truth, but these docs explain *why*.

For the brief itself, see the root [`README.md`](../README.md). For setup/run instructions, [`SETUP.md`](../SETUP.md). For headline results and submission notes, [`NOTES.md`](../NOTES.md).
