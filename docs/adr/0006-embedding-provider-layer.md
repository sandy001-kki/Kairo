# ADR-0006: Embedding provider layer — stronger semantics, never embedding-only

- Status: Accepted
- Date: 2026-05-19
- Related: ADR-0005 (vector memory), ADR-0004 (salience)

## Context

v0.6.0 shipped architecture-aware hybrid recall with a deterministic lexical
embedder. The dogfood proved retrieval is correct but **driven by salience/graph,
not similarity** — the embedder is intentionally weak. Before multi-agent /
distributed cognition, Kairo needs the _option_ of a real semantic substrate
without weakening the property that makes it trustworthy.

## Decision

### 1. A provider layer, deterministic stays the default

`src/core/vector/providers/` exposes an `EmbeddingProvider` interface and a registry.
Providers: `deterministic` (default), `openai` / `ollama` / `voyage` and any
OpenAI-compatible endpoint via one HTTP provider. The default remains the
deterministic lexical embedder: **offline, reproducible, CI/test-safe, no network,
no secrets.** A non-default provider is opt-in via env only.

### 2. Embedding is async; retrieval is pure

Real providers are network calls, so `EmbeddingProvider.embed/embedBatch` are
`async`. Retrieval is refactored to take a **precomputed query vector** instead of an
embedder, so `retrieve()` stays a pure, synchronous, deterministic function (critical
for test stability and for the "never embedding-only" invariant being auditable).
`MemoryEngine` owns the async boundary.

### 3. Fail-safe, never embedding-only

- If a configured remote provider errors/misconfigured/offline, Kairo **falls back
  to the deterministic provider**, logs it, and stamps the index with the provider
  actually used (a remote-labelled index is never silently filled with fallback
  vectors). An embedding backend outage must never break a session.
- Retrieval is `Σ` of eight explainable factors; **semantic similarity is one term**.
  Even with a perfect embedder, salience + graph + runtime + layer + checkpoint +
  recency + dependency-proximity dominate jointly. This is the differentiator and is
  enforced structurally (a test asserts a high-salience low-similarity chunk beats a
  high-similarity peripheral one regardless of provider).

### 4. New explicit `architectureLayer` factor

The brief's target formula lists `architectureLayerWeight` separately from runtime.
Added: chunks are mapped to a layer (interface/domain/data/infra) and weighted, so
architectural role is a first-class, explainable ranking term.

## Consequences

- A stronger embedder improves the _similarity_ term only; architectural correctness
  cannot regress because it is carried by other terms (verified in the dogfood: a
  simulated strong-semantic provider kept top-5 first-party at 5/5).
- The embedder id (incl. model) is part of the index key, so switching providers
  invalidates and rebuilds — no mixed-vector corruption.
- Honest limitation: a real hosted model could **over-associate** concepts and pull
  unrelated-but-lexically-adjacent code together. Mitigated by the cap on the
  similarity weight and the dominance of structural terms; documented, not oversold.
  Real-model numbers require a configured endpoint and are out of scope for CI.
- Foundational for v0.7.0+ (semantic routing, distributed cognition) without
  redesign: more providers = more registry entries.
