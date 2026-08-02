// Persistent incoming-share session store. The share target can be killed at
// any point — mid-save, after backend success but before the native payload is
// cleared, or after the clear but before local state is deleted. This module
// records enough of the session to reconcile every one of those windows on the
// next launch, so a successful entry is never re-saved (duplicate) and a failed
// entry is never silently dropped.
//
// The contract the UI layer relies on, in plain terms:
//
//   1. fingerprint(rawPayloads) — a collision-free encoding of the current raw
//      shared payload batch (order + duplicates included). Two distinct batches
//      must never share a fingerprint, so a deliberate later re-share of
//      identical content is its own fresh session rather than matching a stale
//      completed one.
//   2. reconcileSession(rawPayloads) — returns exactly one of:
//        { kind: 'new', session }          start a brand-new session for this batch
//        { kind: 'resume', session }        same batch as an active session: retry pending/failed
//        { kind: 'clear', session }         same batch as a COMPLETED session: clear native
//                                           payloads, then the record is deleted here
//        { kind: 'empty' }                  no raw payloads: drop any stale local session
//   3. markEntry / markComplete — mutate the persisted session in place.

/** A synchronous string-keyed bag, the slice of MMKV the session store needs.
 * Injecting it keeps this module unit-testable with a plain Map and lets a
 * future storage backend swap in without touching the reconciliation rules. */
export interface SessionStoreAdapter {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
  contains(key: string): boolean;
}

/** One raw shared payload, as `useIncomingShare` exposes it. Only the fields
 * that contribute to identity are tracked, so the store has no compile-time
 * dependency on the (experimental, evolving) expo-sharing types. */
export type RawSharePayload = {
  value: string;
  shareType: string;
  mimeType?: string;
};

/** The kind of item a resolved entry will save as. `unsupported` covers audio,
 * video, file, and any future content type the share target deliberately does
 * not import — it is reported, never silently coerced into a note. */
export type ShareEntryKind = 'link' | 'note' | 'image' | 'unsupported';

export type ShareEntryStatus = 'pending' | 'saved' | 'failed' | 'unsupported';

/** A single resolved share entry plus its stable operation id and outcome. The
 * operation id is `share:<session>:<index>` — index is the entry's position in
 * the RAW payloads array, so it survives resolution reordering and is stable
 * across remounts/process-restart. */
export type ShareEntry = {
  index: number;
  operationId: string;
  kind: ShareEntryKind;
  status: ShareEntryStatus;
  /** The backend item id once an entry has saved successfully. */
  itemId?: string;
  /** A user-safe reason for a `failed`/`unsupported` outcome. */
  message?: string;
};

/** The persisted session shape. Bump `version` on any breaking change so a
 * stale incompatible record is dropped (via `loadSession`) rather than
 * misinterpreted. */
export type ShareSession = {
  version: number;
  fingerprint: string;
  sessionId: string;
  phase: 'active' | 'complete';
  entries: ShareEntry[];
};

export const SESSION_SCHEMA_VERSION = 1;

const SESSION_KEY = 'incoming-share-session';

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

/** A stable, unambiguous encoding of a raw payload batch. JSON of an array of
 * {value, shareType, mimeType} objects — never delimiter concatenation, which
 * can collide across distinct batches (e.g. `"a|b"` vs `"a","b"`). Order and
 * duplicates are preserved so two identical entries in one batch stay distinct
 * and a re-ordering reads as a different batch (a new session). */
export function fingerprint(rawPayloads: RawSharePayload[]): string {
  // Sort object keys for determinism: an undefined mimeType serialized as
  // {mimeType: undefined} vs {mimeType omitted} must not flip the fingerprint.
  const normalized = rawPayloads.map((p) => ({
    value: p.value,
    shareType: p.shareType,
    mimeType: p.mimeType ?? null,
  }));
  return JSON.stringify(normalized);
}

// ---------------------------------------------------------------------------
// Session load / save / delete
// ---------------------------------------------------------------------------

/** Reads the persisted session, or null if absent or incompatible with the
 * current schema version. An incompatible (future/older) shape is dropped: the
 * caller treats the next reconciliation as a fresh session rather than guessing
 * at an unknown layout. */
export function loadSession(store: SessionStoreAdapter): ShareSession | null {
  const raw = store.getString(SESSION_KEY);
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ShareSession>;
    if (
      typeof parsed.version !== 'number' ||
      parsed.version !== SESSION_SCHEMA_VERSION ||
      typeof parsed.fingerprint !== 'string' ||
      typeof parsed.sessionId !== 'string' ||
      parsed.sessionId.length === 0 ||
      (parsed.phase !== 'active' && parsed.phase !== 'complete') ||
      !Array.isArray(parsed.entries)
    ) {
      // Unknown/incompatible shape — drop it so a fresh session starts clean.
      store.remove(SESSION_KEY);
      return null;
    }
    return parsed as ShareSession;
  } catch {
    store.remove(SESSION_KEY);
    return null;
  }
}

/** Writes (or replaces) the persisted session. */
function saveSession(store: SessionStoreAdapter, session: ShareSession): void {
  store.set(SESSION_KEY, JSON.stringify(session));
}

/** Removes the persisted session entirely. Called once a completed session has
 * been reconciled against (used to clear native payloads) so a later identical
 * re-share starts fresh instead of matching a stale completed record. */
export function deleteSession(store: SessionStoreAdapter): void {
  store.remove(SESSION_KEY);
}

// ---------------------------------------------------------------------------
// Entry helpers
// ---------------------------------------------------------------------------

/** Builds the stable operation id for an entry at `index` in the raw batch.
 * Index is the RAW position (not the resolved position) so it is stable across
 * resolution reordering and process restart. */
export function operationIdFor(sessionId: string, index: number): string {
  return `share:${sessionId}:${index}`;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export type ReconcileResult =
  | { kind: 'empty' }
  | { kind: 'new'; session: ShareSession }
  | { kind: 'resume'; session: ShareSession }
  | { kind: 'clear'; session: ShareSession };

/** The single entry point the UI calls on every render/mount with the current
 * raw shared payloads. It decides — atomically with respect to the store —
 * whether this batch is brand-new, an active session to resume, a completed
 * session whose native payloads must be cleared, or empty.
 *
 * Completed-state is single-use: a fingerprint match alone is NOT durable
 * identity. Once a completed session has been reconciled (used to clear), the
 * record is deleted here so a deliberate later re-share of identical content
 * starts a fresh session rather than being silently dropped. */
export function reconcileSession(
  store: SessionStoreAdapter,
  rawPayloads: RawSharePayload[],
  generateSessionId: () => string,
): ReconcileResult {
  // No native payloads. Drop any stale local session — there is nothing to
  // resume or clear.
  if (rawPayloads.length === 0) {
    deleteSession(store);
    return { kind: 'empty' };
  }

  const currentFp = fingerprint(rawPayloads);
  const existing = loadSession(store);

  if (existing === null) {
    return { kind: 'new', session: newSession(store, currentFp, rawPayloads, generateSessionId) };
  }

  if (existing.fingerprint !== currentFp) {
    // Different batch: a new share superseded the previous one. Start fresh,
    // replacing the stale record. (The previous session's native payloads are
    // gone — a new share cannot arrive while old ones linger natively.)
    return { kind: 'new', session: newSession(store, currentFp, rawPayloads, generateSessionId) };
  }

  // Same batch as the persisted session.
  if (existing.phase === 'complete') {
    // Single-use: clearing the native payloads is the last reconciliation step
    // for a completed session. Delete the record so a later identical re-share
    // (a NEW share of the same content) does not match this stale completed
    // record and get silently dropped. The caller performs the native clear.
    deleteSession(store);
    return { kind: 'clear', session: existing };
  }

  // Active session, same batch: resume only pending/failed entries. Saved
  // entries are kept as-is and NOT re-processed by the caller.
  return { kind: 'resume', session: existing };
}

/** Allocates a brand-new active session for `rawPayloads` and persists it. All
 * entries start `pending`; the processor assigns their kind/status as it
 * resolves and saves them. */
function newSession(
  store: SessionStoreAdapter,
  fp: string,
  rawPayloads: RawSharePayload[],
  generateSessionId: () => string,
): ShareSession {
  const sessionId = generateSessionId();
  const session: ShareSession = {
    version: SESSION_SCHEMA_VERSION,
    fingerprint: fp,
    sessionId,
    phase: 'active',
    entries: rawPayloads.map((_, index) => ({
      index,
      operationId: operationIdFor(sessionId, index),
      kind: 'link', // placeholder; the processor classifies each entry
      status: 'pending',
    })),
  };
  saveSession(store, session);
  return session;
}

// ---------------------------------------------------------------------------
// In-place mutation of a persisted session
// ---------------------------------------------------------------------------

/** Updates one entry by index and persists the result. No-op (and no write) if
 * the session no longer exists — e.g. it was cleared between renders. */
export function updateEntry(
  store: SessionStoreAdapter,
  index: number,
  patch: Partial<ShareEntry>,
): void {
  const session = loadSession(store);
  if (session === null) return;
  const entry = session.entries.find((e) => e.index === index);
  if (entry === undefined) return;
  Object.assign(entry, patch);
  saveSession(store, session);
}

/** Marks the session complete and persists it. MUST be called BEFORE the native
 * clear so the after-clear-but-before-local-delete window reconciles correctly
 * (a matching completed session clears native payloads and deletes itself). */
export function markComplete(store: SessionStoreAdapter): void {
  const session = loadSession(store);
  if (session === null) return;
  if (session.phase === 'complete') return; // idempotent
  session.phase = 'complete';
  saveSession(store, session);
}

/** True if every entry in the session is in a terminal (saved/failed/
 * unsupported) state, i.e. there is nothing left to attempt. */
export function allEntriesSettled(session: ShareSession): boolean {
  return session.entries.every(
    (e) => e.status === 'saved' || e.status === 'failed' || e.status === 'unsupported',
  );
}

/** The entries the processor should (re)attempt: those still pending or failed.
 * Saved and unsupported entries are excluded — successes are never re-saved. */
export function entriesToProcess(session: ShareSession): ShareEntry[] {
  return session.entries.filter((e) => e.status === 'pending' || e.status === 'failed');
}
