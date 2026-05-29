/**
 * Kairo Atlas payload types (v1.5.0, ADR-0019).
 *
 * Atlas is a read-only projection over existing Kairo artifacts. This module
 * defines only the deterministic graph payload the projection produces and the
 * inspect routes serve. No analysis lives here — see `atlasProjection.ts`.
 *
 * Determinism contract: for identical `.kairo/` contents, an `AtlasGraph` is
 * byte-identical. Nodes are ordered `(−salience, id)`, edges `(from, to)`, all
 * paths are repo-relative, and no wall-clock time or randomness appears.
 */

import type { GraphKind } from '../../core/graph/types.js';

export const ATLAS_SCHEMA_VERSION = 1 as const;

/** Coarse classification of a node, derived deterministically from its path. */
export type AtlasNodeGroup = 'source' | 'docs' | 'test' | 'example' | 'generated' | 'other';

export type AtlasRiskLevel = 'low' | 'medium' | 'high';

export interface AtlasNodeFlags {
  /** A file under this node was changed in any recorded session or checkpoint. */
  changed: boolean;
  /** A checkpoint's changed-files map under this node. */
  checkpoint: boolean;
  /** A session's changed-files map under this node. */
  session: boolean;
}

export interface AtlasNode {
  /** Stable, repo-relative identifier (e.g. `src/core`). Never absolute. */
  id: string;
  /** Short display label (basename of the id). */
  label: string;
  group: AtlasNodeGroup;
  /**
   * Importance in [0,1], rounded to 3 decimals. Derived from graph degree
   * centrality (fan-in + fan-out, edge-weighted) — a deterministic topology
   * signal, NOT the vector-memory salience engine. Documented honestly so the
   * number is not mistaken for semantic importance.
   */
  salience: number;
  /** Incoming edge count (weighted) at directory granularity. */
  fanIn: number;
  /** Outgoing edge count (weighted). */
  fanOut: number;
  /** Normalised degree centrality in [0,1], rounded to 3 decimals. */
  centrality: number;
  /** Risk level if a checkpoint touching this node recorded one; else omitted. */
  risk?: AtlasRiskLevel;
  flags: AtlasNodeFlags;
}

export interface AtlasEdge {
  from: string;
  to: string;
  /** Number of underlying file-level edges this collapsed edge represents. */
  weight: number;
}

export interface AtlasTruncation {
  shown: number;
  total: number;
  by: 'salience';
  /** Human-readable, e.g. "Showing top 50 of 1,240 nodes by salience." */
  message: string;
}

export interface AtlasGraph {
  schemaVersion: typeof ATLAS_SCHEMA_VERSION;
  /** Basename of the project root only — never an absolute path. */
  repoName: string;
  /** True when a cached repo-intelligence scan is available to project from. */
  hasGraph: boolean;
  /** ISO timestamp of the last scan (from repo intelligence), or empty. */
  generatedAt: string;
  /**
   * "Fresh" in the schema sense: the cached scan was produced by a Kairo build
   * whose intelligence schema matches this build. Atlas does NOT re-scan the
   * filesystem, so this is not a claim that files are unchanged since the scan;
   * `generatedAt` is surfaced so the human judges recency.
   */
  fresh: boolean;
  graphKind: GraphKind;
  availableModes: GraphKind[];
  totals: { nodes: number; edges: number };
  truncated: boolean;
  truncation?: AtlasTruncation;
  nodes: AtlasNode[];
  edges: AtlasEdge[];
  /** Honest one-line note about derivation/limits, or a fallback message. */
  note: string;
}

export interface AtlasGraphOptions {
  /** Which derived graph to project. Default `module`. */
  kind?: GraphKind;
  /** Salience-ranked node cap. Default 50. `0` means "all" (still edge-capped). */
  top?: number;
}
