# Kairo Vector / Semantic Memory

> Architecture-aware hybrid recall — **not** naive RAG. See
> [ADR-0005](adr/0005-vector-memory-design.md).

The vector layer is Kairo's semantic cognition layer: it lets an agent recall
architectural context instead of rescanning. It does **not** chatbot-embed every
file and retrieve by cosine.

## Five memory classes

Chunks are architecture-aware objects built from artifacts Kairo already derives
deterministically — never a blind file dump:

| Kind          | Source                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| `structural`  | repo-intelligence overview + one chunk per salience-ranked module-graph group (with neighbours, degree) |
| `operational` | frameworks/tooling, CI workflows                                                                        |
| `decision`    | ADRs (`docs/adr/*.md`) + recorded engineering decisions                                                 |
| `semantic`    | architecture docs (README/ARCHITECTURE/…)                                                               |
| `session`     | latest checkpoint (task, remaining, blockers, risk)                                                     |

## Embedding provider layer (v0.6.1, ADR-0006)

`src/core/vector/providers/` exposes an `EmbeddingProvider` interface + registry.
The **default** is `deterministic`: a pure, fixed-256-dim hashed lexical/structural
vector (token + sub-token + bigram, L2-normalised). It is **not deep-semantic**, and
Kairo says so. It stays the default because it is byte-identical across
runs/machines (memory must not churn — it seeds long-term recall), needs no network
or secrets, and the hybrid ranking carries architecture awareness.

A stronger provider is **opt-in via env only**:

```
KAIRO_EMBEDDER=openai|voyage|ollama|custom   # default: deterministic
KAIRO_EMBED_API_KEY=...        # or OPENAI_API_KEY / VOYAGE_API_KEY
KAIRO_EMBED_BASE_URL=...       # required for custom; presets supply the rest
KAIRO_EMBED_MODEL=...          KAIRO_EMBED_STYLE=openai|ollama   KAIRO_EMBED_DIM=...
```

One `HttpEmbeddingProvider` covers every OpenAI-compatible endpoint (OpenAI,
VoyageAI, LM Studio, vLLM) and Ollama's native shape. The embedder id (incl. model)
is part of the index key, so switching providers invalidates and rebuilds — never a
mixed-vector index. If a configured remote provider errors, Kairo **falls back to
deterministic**, logs it, and stamps the index with the provider actually used: an
embedding outage cannot break a session. Embedding is async; `retrieve()` stays a
pure deterministic function by consuming a precomputed query vector.

## Hybrid, explainable ranking

`score = Σ factor·weight`, every factor reported:

| Factor              | Default w | Intuition                                  |
| ------------------- | --------: | ------------------------------------------ |
| similarity          |       1.0 | lexical/structural cosine to the query     |
| salience            |       0.9 | ADR-0004 architectural importance          |
| graphCentrality     |       0.7 | module-graph degree                        |
| sessionRecency      |       0.4 | newer session/decision memory              |
| runtimeLayer        |       0.5 | reachable from a runtime entry point       |
| architectureLayer   |       0.5 | interface / domain / data / infra role     |
| dependencyProximity |       0.5 | query-term overlap with chunk + neighbours |
| checkpointOverlap   |       0.6 | overlaps current checkpoint task/blockers  |

Similarity is **one of eight** factors. Even with a perfect embedder the other seven
jointly dominate — a test asserts a perfectly-similar peripheral example still loses
to a central low-similarity module. This is the property a stronger provider cannot
break.

Because salience/graph/runtime carry real weight, **a central `auth` module
out-ranks a lexically similar but peripheral `examples/` file even with the weak
default embedder** (regression-tested). It degrades gracefully: a poor embedder
just lets structure dominate — which is correct here.

Deterministic: pure over inputs, fixed precision, total order `(score desc, id asc)`.

## Anti-rescan property (the success condition)

- The index is keyed by **repo fingerprint + embedder id**. A fingerprint match →
  **no re-embedding** (same cache discipline as repo intelligence).
- `kairo_session_start` builds/reuses the index automatically.
- Every continuation brief auto-carries a **"Semantic architecture recall"** section
  retrieved for the session task, so the next agent resumes with architecture
  context instead of a blank repo. This is _how_ Kairo reduces future rescanning —
  not "because embeddings exist".
- `kairo_memory_digest` returns a deterministic, salience-ordered **compressed
  architectural memory** to read instead of walking the tree.

## MCP surface

| Tool                  | Purpose                                               |
| --------------------- | ----------------------------------------------------- |
| `kairo_memory_search` | hybrid explainable recall (use instead of rescanning) |
| `kairo_memory_index`  | build/refresh; fingerprint-keyed, no re-embed on hit  |
| `kairo_memory_digest` | compressed salience-ordered architecture memory       |

## Honest limitations

- Default similarity is **lexical/structural, not deep semantic**. Where a hosted
  model would be stronger, hybrid structure compensates; where it still fails, the
  dogfood addendum says so.
- `builtAt` is fixed (`epoch`) on purpose — freshness is tracked by fingerprint, not
  timestamp, to keep the index byte-stable.
- Chunking is bounded (module-graph is already capped/ranked; docs are size-capped).
  Very large undocumented monorepos yield coarser structural memory.

## Future (designed-for, behind the same interfaces)

Multi-agent / shared-team cognition, architecture-evolution timelines, engineering
journals, semantic-diff intelligence, PR-review memory, distributed stores
(SQLite/LanceDB/Qdrant/pgvector) — additional chunk kinds, embedder providers, and
`VectorStore` adapters; no redesign.
