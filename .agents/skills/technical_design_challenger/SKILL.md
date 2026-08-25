---
name: "Technical Design Challenger"
description: "An adversarial design-review gate for architecture, API contract, storage, E2EE/MLS, performance, migration, rollout, or high-blast-radius changes. Surfaces independent tradeoffs, failure modes, compatibility risks, and production gates instead of simply following the preferred option."
---

# Technical Design Challenger

## When to Trigger

Activate this skill **before writing any implementation code** whenever a proposed change touches one or more of the following areas:

| Domain | Examples |
|---|---|
| **Architecture** | New module boundaries, dependency graph changes, singleton/factory refactors |
| **API Contract** | New or modified REST/WS endpoints, request/response schema changes, SDK public API surface changes |
| **Storage** | IndexedDB schema migrations, cache invalidation strategies, local-state persistence |
| **E2EE / MLS** | Key rotation, group ratchet changes, protocol version bumps |
| **Performance** | Virtualization strategies, bundle-size impacts, render-path changes affecting >1k items |
| **Migration / Rollout** | Breaking changes, feature flags, phased rollouts, backward-compatibility windows |
| **High-Blast-Radius** | Any change that, if faulty, would degrade >50% of active sessions or corrupt persisted data |

If a change does **not** fall into any of the above categories, skip this skill and proceed normally.

---

## Process

When triggered, you **MUST** complete the following phases in order. Do **NOT** begin writing implementation code until Phase 3 is resolved.

### Phase 1 — Enumerate Alternatives

1. Restate the problem in one sentence.
2. List **at least 3 distinct design alternatives** (including the initially preferred one). For each alternative, provide:
   - A short name (e.g., *"Lazy-hydration with stale-while-revalidate"*).
   - A 2–4 sentence description of the mechanism.
   - A concrete code sketch or pseudo-code snippet (≤15 lines) showing the critical path.

> [!IMPORTANT]
> Do not dismiss any alternative prematurely. The goal is breadth of exploration, not confirmation of the first idea.

### Phase 2 — Adversarial Analysis

For **each** alternative from Phase 1, evaluate the following dimensions and record your findings in a comparison table:

| Dimension | What to Evaluate |
|---|---|
| **Correctness** | Edge cases, race conditions, data invariants that could be violated |
| **Failure Modes** | What breaks if this approach fails? Blast radius? Is the failure silent or loud? |
| **Backward Compatibility** | Does this break existing SDK consumers, persisted data, or WS event contracts? |
| **Performance** | CPU/memory/network cost at p50 and p99. Bundle-size delta. |
| **Complexity** | Lines of code, number of files touched, cognitive load for future maintainers |
| **Rollout Risk** | Can this be feature-flagged? Does it require a data migration? Is rollback safe? |
| **Security** | New attack surface? Sensitive data exposure? Auth boundary changes? |
| **Testability** | Can it be unit-tested in isolation? Does it need integration/E2E coverage? |

Produce a **tradeoff matrix** (markdown table) with alternatives as columns and dimensions as rows, using 🟢 / 🟡 / 🔴 ratings with a one-line justification per cell.

### Phase 3 — Recommendation & User Gate

1. **Recommend** the alternative you believe is best, citing the tradeoff matrix.
2. **List explicit conditions** under which your recommendation would be wrong (e.g., *"If we need offline-first support within 2 sprints, Alternative B becomes superior because…"*).
3. **Propose a verification plan**: specific tests, metrics, or rollout gates that would catch a regression introduced by this change.
4. **Present all of the above to the user** inside the `implementation_plan.md` artifact under a clearly marked `## Design Challenge Review` section.
5. **STOP and wait for user approval.** Do not proceed to implementation until the user explicitly approves the chosen alternative.

---

## Output Format

When presenting the design challenge, use the following structure inside your plan or artifact:

```markdown
## Design Challenge Review

### Problem Statement
<!-- One sentence -->

### Alternatives Considered

#### Alternative A — [Name]
<!-- Description + code sketch -->

#### Alternative B — [Name]
<!-- Description + code sketch -->

#### Alternative C — [Name]
<!-- Description + code sketch -->

### Tradeoff Matrix

| Dimension | Alt A | Alt B | Alt C |
|---|---|---|---|
| Correctness | 🟢 … | 🟡 … | 🔴 … |
| Failure Modes | … | … | … |
| Backward Compat | … | … | … |
| Performance | … | … | … |
| Complexity | … | … | … |
| Rollout Risk | … | … | … |
| Security | … | … | … |
| Testability | … | … | … |

### Recommendation
<!-- Which alternative and why -->

### When This Recommendation Is Wrong
<!-- Conditions that would invalidate the choice -->

### Verification Plan
<!-- Tests, metrics, rollout gates -->
```

---

## Rules

- **Independence over advocacy.** Your job in this skill is to be a skeptic, not a cheerleader. Do not bias toward the user's initial preference.
- **Concrete over abstract.** Every claim must reference specific code paths, event names, or data schemas from this repo — not generic best practices.
- **Brevity over exhaustiveness.** Each cell in the tradeoff matrix should be ≤2 sentences. Save depth for the recommendation section.
- **No silent risks.** If you identify a risk that is difficult to mitigate, call it out with a `> [!CAUTION]` alert — do not bury it in prose.
