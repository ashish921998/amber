// Pure coordinator that drives one share session's entries through their saves.
// It has NO React, Convex, or storage imports — every side effect (link, note,
// image save, persistence) is injected, so the orchestration is unit-testable
// with fakes and so a partial failure can never erase sibling successes.
//
// The contract (plan 004):
//   - classify(): convert resolved payloads into entries WITHOUT side effects,
//     treating malformed input (no contentUri, blank text, bad website URL,
//     unsupported types) as explicit failed/unsupported entries.
//   - processSession(): process each entry independently, retaining every
//     success and reporting each failure as data. Retry only re-attempts
//     `failed` entries; saved entries are never re-saved.
//   - onEntrySettled callback emits progress after each entry settles.

import { isProbablyUrl } from '@/lib/url';
import type { Id } from '@convex/_generated/dataModel';
import type { ImageSaveResult, LocalImage } from '@/lib/use-save-image';
import type {
  ShareEntry,
  ShareEntryKind,
  ShareSession,
} from './storage';

/** The minimal slice of a resolved share payload the processor needs. Only the
 * fields that drive classification are tracked, so this stays decoupled from
 * the experimental expo-sharing types. */
export type ResolvedPayload = {
  contentType: 'text' | 'audio' | 'image' | 'video' | 'file' | 'website' | null;
  /** The primary value: a URL for `website`, the message body for `text`. */
  value: string;
  /** Resolved, dereferenced URI for uri-based content; null for text. */
  contentUri: string | null;
  contentMimeType: string | null;
};

/** Injected save operations. Each is the one side effect its entry kind needs.
 * They throw on failure; the processor catches and records the failure as data. */
export interface ShareSaveDeps {
  saveLink: (args: {
    url: string;
    operationId: string;
  }) => Promise<Id<'items'>>;
  saveNote: (args: {
    text: string;
    operationId: string;
  }) => Promise<Id<'items'>>;
  /** Drives plan 003's begin→upload→attach→finalize lifecycle for one image,
   * returning its settled result. A failure is already a result, never a throw. */
  saveImage: (request: {
    image: LocalImage;
    operationId: string;
  }) => Promise<ImageSaveResult>;
}

/** Content types the share target deliberately does not import. They are
 * reported as unsupported entries, never silently coerced into notes. */
const UNSUPPORTED_CONTENT_TYPES = new Set<NonNullable<ResolvedPayload['contentType']>>([
  'audio',
  'video',
  'file',
]);

/**
 * Classifies ONE resolved payload into a kind, WITHOUT starting any side effect.
 * Returns the kind plus a reason when the payload is malformed/unsaveable so
 * the caller can record an explicit `failed`/`unsupported` entry rather than
 * guessing or skipping it.
 *
 * Classification rules:
 *   - image WITHOUT contentUri → failed (the image is unreachable).
 *   - image with contentUri → image.
 *   - website whose value is blank/invalid → failed (malformed URL).
 *   - website otherwise → link.
 *   - unsupported types (audio/video/file) → unsupported.
 *   - blank text → failed (nothing to save).
 *   - text that looks like a URL → link; otherwise note.
 */
export function classifyPayload(
  payload: ResolvedPayload,
): { kind: ShareEntryKind; reason?: string } {
  if (payload.contentType === 'image') {
    if (!payload.contentUri) {
      return { kind: 'image', reason: 'Image could not be resolved' };
    }
    return { kind: 'image' };
  }
  if (payload.contentType === 'website') {
    const url = payload.value.trim();
    if (!url || !isProbablyUrl(url)) {
      return { kind: 'link', reason: 'Shared link was not a valid URL' };
    }
    return { kind: 'link' };
  }
  if (payload.contentType && UNSUPPORTED_CONTENT_TYPES.has(payload.contentType)) {
    return { kind: 'unsupported', reason: `Unsupported content type: ${payload.contentType}` };
  }
  // contentType === 'text' (or null, treated as text): pasted text or a note.
  const value = payload.value.trim();
  if (!value) {
    return { kind: 'note', reason: 'Shared text was empty' };
  }
  return { kind: isProbablyUrl(value) ? 'link' : 'note' };
}

/**
 * Stamps a fresh session's entries with the kind and (for malformed/unsaveable
 * payloads) terminal status derived from the resolved payloads — WITHOUT saving
 * anything. Resolved payload order is assumed to match the raw payload order
 * used to build the session's operation ids; the caller guards the divergent-
 * count case (see processSession's raw/resolved count check).
 *
 * Returns the updated entries; the caller persists them via the storage layer.
 */
export function classifyEntries(
  session: ShareSession,
  resolved: ResolvedPayload[],
): ShareEntry[] {
  return session.entries.map((entry) => {
    const payload = resolved[entry.index];
    if (payload === undefined) {
      // Should be unreachable when raw/resolved counts match; defensive.
      return {
        ...entry,
        status: 'failed' as const,
        message: 'No resolved payload for this entry',
      };
    }
    const { kind, reason } = classifyPayload(payload);
    if (reason !== undefined) {
      // The kind still records intent; status is the terminal outcome.
      const status: ShareEntry['status'] =
        kind === 'unsupported' ? 'unsupported' : 'failed';
      return { ...entry, kind, status, message: reason };
    }
    return { ...entry, kind };
  });
}

/**
 * Processes the session's saveable entries independently and returns the
 * resulting session. Each entry settles as saved/failed; successes are retained
 * across retries. `onEntrySettled` fires after each entry settles so the UI can
 * report progress and persist intermediate state.
 *
 * Idempotency: every save is keyed by the entry's stable `operationId`, so a
 * retry that re-processes an already-saved entry (because the caller did not
 * filter it out) reuses the same backend operation and returns the same item.
 * The processor still only INVOKES save for pending/failed entries; saved and
 * unsupported entries are skipped.
 */
export async function processSession(
  session: ShareSession,
  resolved: ResolvedPayload[],
  deps: ShareSaveDeps,
  onEntrySettled?: (entry: ShareEntry) => void,
): Promise<ShareSession> {
  const entries = session.entries.map((e) => ({ ...e }));

  await Promise.all(
    entries.map(async (entry): Promise<void> => {
      // Skip terminal entries: saved successes are never re-saved; unsupported
      // entries have nothing to attempt.
      if (entry.status === 'saved' || entry.status === 'unsupported') return;
      // Already-processed-and-failed entries are retried; pending entries are
      // attempted for the first time. Both go through the same path.

      const settled = await processOne(entry, resolved, deps);
      // Merge the settled outcome onto this entry.
      entry.status = settled.status;
      entry.itemId = settled.itemId;
      entry.message = settled.message;
      onEntrySettled?.(entry);
    }),
  );

  return { ...session, entries };
}

/** Processes a single entry and returns its settled outcome. A failure is data,
 * never a thrown promise, so it can never erase a sibling success. */
async function processOne(
  entry: ShareEntry,
  resolved: ResolvedPayload[],
  deps: ShareSaveDeps,
): Promise<Partial<ShareEntry> & { status: ShareEntry['status'] }> {
  const payload = resolved[entry.index];
  const operationId = entry.operationId;

  try {
    if (entry.kind === 'link') {
      const url = (payload?.contentType === 'website' ? payload.value : payload?.value ?? '').trim();
      const itemId = await deps.saveLink({ url, operationId });
      return { status: 'saved', itemId: String(itemId), message: undefined };
    }
    if (entry.kind === 'note') {
      const text = (payload?.value ?? '').trim();
      const itemId = await deps.saveNote({ text, operationId });
      return { status: 'saved', itemId: String(itemId), message: undefined };
    }
    if (entry.kind === 'image') {
      // A malformed image entry (no contentUri) was classified as failed by
      // classifyEntries; reaching here means it slipped through unclassified —
      // treat it as a failure rather than inventing a URI.
      if (!payload?.contentUri) {
        return { status: 'failed', message: 'Image could not be resolved' };
      }
      const image: LocalImage = {
        uri: payload.contentUri,
        mimeType: payload.contentMimeType ?? undefined,
      };
      const result = await deps.saveImage({ image, operationId });
      if (result.status === 'saved') {
        return { status: 'saved', itemId: String(result.itemId), message: undefined };
      }
      return { status: 'failed', message: result.message };
    }
    // kind === 'unsupported' — never reached (filtered above), but defensive.
    return { status: 'unsupported', message: entry.message ?? 'Unsupported content' };
  } catch (error) {
    return {
      status: 'failed',
      message: userSafeMessage(error),
    };
  }
}

/** Maps a thrown value to a short, user-safe message, mirroring use-save-image's
 * sanitizer: never surfaces URLs, ids, or stack traces. */
function userSafeMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    const cleaned = error.message
      .replace(/https?:\/\/\S+/gi, '<url>')
      .replace(/\b[a-z0-9]{25,}\b/g, '<id>')
      .slice(0, 200);
    return cleaned || 'Could not save this item';
  }
  return 'Could not save this item';
}
