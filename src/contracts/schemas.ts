/**
 * Centralised schema version constants for every persisted Kairo artefact
 * (ADR-0012). One module, one source of truth.
 *
 * Patch versions must not bump these. Minor versions may bump _with_ a
 * migration shipped in the same release. Major versions make the constants
 * part of the public stability contract.
 */

export const EVENT_SCHEMA_VERSION = 1 as const;
export const TELEMETRY_SCHEMA = 1 as const;
export const AUDIT_SCHEMA = 1 as const;
export const SESSION_SNAPSHOT_SCHEMA = 1 as const;
export const CHECKPOINT_SCHEMA = 1 as const;
export const INTELLIGENCE_SCHEMA = 4 as const;
export const VECTOR_INDEX_SCHEMA = 3 as const;

/** A record with no on-disk schema field is interpreted as legacy (version 0). */
export const LEGACY_SCHEMA_VERSION = 0;

export interface ArtefactSchemaInfo {
  readonly current: number;
  readonly legacy: number;
}

export const SCHEMAS = {
  event: { current: EVENT_SCHEMA_VERSION, legacy: LEGACY_SCHEMA_VERSION },
  telemetry: { current: TELEMETRY_SCHEMA, legacy: LEGACY_SCHEMA_VERSION },
  audit: { current: AUDIT_SCHEMA, legacy: LEGACY_SCHEMA_VERSION },
  session: { current: SESSION_SNAPSHOT_SCHEMA, legacy: LEGACY_SCHEMA_VERSION },
  checkpoint: { current: CHECKPOINT_SCHEMA, legacy: LEGACY_SCHEMA_VERSION },
  intelligence: { current: INTELLIGENCE_SCHEMA, legacy: LEGACY_SCHEMA_VERSION },
  vectorIndex: { current: VECTOR_INDEX_SCHEMA, legacy: LEGACY_SCHEMA_VERSION },
} as const satisfies Record<string, ArtefactSchemaInfo>;

export type ArtefactKind = keyof typeof SCHEMAS;
