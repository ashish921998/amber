import {
  classifyEntries,
  processSession,
  type ResolvedPayload,
  type ShareSaveDeps,
} from '@/lib/share/process-share';
import {
  deleteSession,
  loadSession,
  markComplete,
  reconcileSession,
  updateEntry,
  type RawSharePayload,
  type SessionStoreAdapter,
  type ShareEntry,
  type ShareSession,
} from '@/lib/share/storage';
import { useSaveImages } from '@/lib/use-save-image';
import { api } from '@convex/_generated/api';
import { useUser } from '@clerk/expo';
import { useMutation } from 'convex/react';
import * as Crypto from 'expo-crypto';
import { useRouter } from 'expo-router';
import { useIncomingShare } from 'expo-sharing';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { createMMKV } from 'react-native-mmkv';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

/**
 * Landing screen for content shared into Amber from another app (Safari, Photos,
 * etc.). Resolves the incoming payload and saves each piece through the same
 * idempotent operation ledger the in-app flows use, with an explicit state
 * machine so partial failures stay visible and retryable across remounts and
 * process restarts.
 *
 * Completion ordering (the crash-window reconciliation depends on this exact
 * sequence, centralized in completeSession):
 *   1. persist `phase: complete`
 *   2. native clearSharedPayloads() — if it throws, the completed session stays
 *      so a remount retries the clear
 *   3. delete the local session record (only after a successful clear)
 *   4. navigate Home exactly once
 */

// Dedicated MMKV instance for the one share session record. The adapter
// interface lives in storage.ts so its reconciliation rules stay pure and
// unit-testable with a Map; only this native binding is owned here.
const shareStore: SessionStoreAdapter = createMMKV({ id: 'incoming-share' });

/** The session-driven UI states. The resolution-driven states (resolving,
 * resolution-error, empty) are pure functions of the `useIncomingShare` hook
 * props, so they are DERIVED during render rather than stored — storing them
 * would require synchronous setState in the effect (a cascading-render smell).
 * A terminal outcome with any failed/unsupported entry is reported as `partial`
 * so the user gets retry/continue/cancel — only an all-saved batch completes.
 *
 * `clearFailed` is the escape hatch for the throwing-native-clear window: the
 * completed session is retained (so a remount retries the clear) but the user
 * gets a manual "Try again" / "Cancel" rather than an eternal spinner. */
type Phase =
  | { kind: 'idle' }
  | { kind: 'saving'; session: ShareSession }
  | { kind: 'partial'; session: ShareSession }
  | { kind: 'clearFailed'; session: ShareSession }
  | { kind: 'complete' };

export default function ShareScreen() {
  const router = useRouter();
  const { theme } = useUnistyles();
  const { user } = useUser();
  const {
    sharedPayloads,
    resolvedSharedPayloads,
    isResolving,
    error,
    clearSharedPayloads,
    refreshSharePayloads,
  } = useIncomingShare();
  const createLinkItem = useMutation(api.items.createLinkItem);
  const createNoteItem = useMutation(api.items.createNoteItem);
  const saveImages = useSaveImages();

  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  // The session id currently being saved, set when a run starts and cleared when
  // it settles. A NEW share arriving mid-flight replaces the persisted record;
  // this id lets persistEntry/completeSession no-op against that newer session
  // and lets the effect detect+start the new run once the old one finishes.
  const runningSessionId = useRef<string | null>(null);
  // Guards navigation + clear so completion runs exactly once per session, keyed
  // by session id so a later session can still complete after an earlier one.
  const completingSessionId = useRef<string | null>(null);
  // The session currently shown on the partial screen. A settled-partial session
  // must NOT auto-restart on every re-render; only an explicit "Retry failed"
  // press re-runs it. A NEW session (different id) bypasses this and starts.
  const partialSessionId = useRef<string | null>(null);

  /** The injected save operations, built once. Both the initial run and a
   * "Retry failed" press share this so the deps object is never rebuilt. */
  const saveDeps = useMemo<ShareSaveDeps>(
    () => ({
      saveLink: ({ url, operationId }) => createLinkItem({ url, operationId }),
      saveNote: ({ text, operationId }) => createNoteItem({ text, operationId }),
      saveImage: ({ image, operationId }) =>
        saveImages([{ image, operationId }]).then((results) => results[0]),
    }),
    [createLinkItem, createNoteItem, saveImages],
  );

  /** The single idempotent completion path used by all-success, continue, AND
   * cancel. Cancel reuses it deliberately so the same persist-complete → native
   * clear → delete-session reconciliation applies unchanged.
   *
   * All three store mutations are scoped to `session.sessionId`: an in-flight
   * run finishing after a newer share replaced its record must NOT mark/delete
   * the newer session. A throwing native clear surfaces a `clearFailed` phase
   * (with Try again / Cancel) instead of an eternal spinner — the completed
   * session stays so a remount (or the manual retry) re-attempts the clear. */
  const completeSession = useCallback(
    (session: ShareSession) => {
      if (completingSessionId.current === session.sessionId) return;
      completingSessionId.current = session.sessionId;
      const sid = session.sessionId;
      // 1. Persist complete BEFORE the native clear. A crash between backend
      //    success and clear is then reconciled on remount (a matching
      //    completed session clears native payloads and deletes itself).
      markComplete(shareStore, sid);
      try {
        // 2. Native clear. A throwing clear keeps the completed session (no
        //    delete, no navigation) and surfaces clearFailed for a manual retry.
        clearSharedPayloads();
      } catch (err) {
        console.error('clearSharedPayloads threw during completion; surfacing retry', err);
        completingSessionId.current = null;
        setPhase({ kind: 'clearFailed', session });
        return;
      }
      // 3. Delete the local session ONLY after a successful clear — otherwise a
      //    later identical re-share would match a stale completed record and be
      //    silently dropped. Scoped so a stale in-flight run can't delete the
      //    newer session that replaced its record.
      deleteSession(shareStore, sid);
      // 4. Navigate Home exactly once.
      setPhase({ kind: 'complete' });
      router.replace('/');
    },
    [clearSharedPayloads, router],
  );

  /** Runs the processor for `session`, persisting each settled entry (scoped to
   * the session id) and advancing to the right terminal phase. Re-entrant guard
   * is keyed by session id: a second run for a DIFFERENT (newer) session is
   * allowed once the current one settles, but never two concurrent runs. */
  const runSave = useCallback(
    async (
      session: ShareSession,
      resolved: ResolvedPayload[],
      deps: ShareSaveDeps,
    ) => {
      // A run is already in flight for this session — don't start a second.
      if (runningSessionId.current === session.sessionId) return;
      runningSessionId.current = session.sessionId;
      // Starting (or retrying) a run clears the partial-settled marker for this
      // session so the effect won't block a future legitimate restart.
      partialSessionId.current = null;
      const sid = session.sessionId;

      try {
        // Classify entries (no side effects) if none have been processed yet,
        // persisting terminal statuses so a crash before any save still records
        // failed/unsupported entries on remount. Scoped to this session so a
        // newer session that replaced the record mid-flight is not corrupted.
        const fresh = session.entries.every((e) => e.status === 'pending');
        let working = session;
        if (fresh) {
          const classified = classifyEntries(session, resolved);
          working = { ...session, entries: classified };
          for (const entry of classified) {
            if (entry.status !== 'pending') {
              persistEntry(entry, sid);
            }
          }
        }

        setPhase({ kind: 'saving', session: working });

        const result = await processSession(working, resolved, deps, (entry) => {
          persistEntry(entry, sid);
          // Reflect incremental progress: update the saving phase's session so
          // "Saved N of M" advances as each entry settles, not just at the end.
          setPhase((prev) =>
            prev.kind === 'saving' && prev.session.sessionId === sid
              ? { kind: 'saving', session: withEntry(prev.session, entry) }
              : prev,
          );
        });

        const allSaved = result.entries.every((e) => e.status === 'saved');
        if (allSaved) {
          completeSession(result);
        } else {
          // Some entries failed or were unsupported: stay and offer retry/continue.
          // Mark this session partial-settled so the effect won't auto-restart
          // it; only the Retry button re-runs it.
          partialSessionId.current = sid;
          setPhase({ kind: 'partial', session: result });
        }
      } catch (err) {
        // processSession catches per-entry save failures as data, so an
        // unexpected throw here is from persistence/classification, not a save.
        // Reload whatever survived from the store and route to the partial phase
        // so the user gets retry/continue/cancel — never an eternal "Saving…"
        // spinner (the plan's "never spin forever" done criterion).
        console.error('Share save orchestration failed', err);
        const live = loadSession(shareStore);
        partialSessionId.current = sid;
        setPhase({ kind: 'partial', session: live ?? session });
      } finally {
        // Only clear the run guard if this run is still the active one — a newer
        // session may have started (the effect allows a new run once the old
        // settles), in which case leave the newer id in place.
        if (runningSessionId.current === sid) {
          runningSessionId.current = null;
        }
      }
    },
    [completeSession],
  );

  // Reconcile + drive the save. The resolution-driven phases (resolving /
  // resolutionError / empty) are derived in render below; this effect only runs
  // once resolution has settled AND there are payloads to save, so it contains
  // no synchronous setState for the derived states.
  useEffect(() => {
    // No authenticated user yet (Clerk still loading): nothing to reconcile.
    if (user === null || user === undefined) return;
    const userId = user.id;
    // Derived guards: while resolving, after a resolution error, or with no
    // payloads, render handles the phase — nothing for the effect to do.
    if (isResolving || error !== null || sharedPayloads.length === 0) {
      return;
    }

    const raw: RawSharePayload[] = sharedPayloads.map((p) => ({
      value: p.value,
      shareType: p.shareType,
      mimeType: p.mimeType,
    }));

    // Raw/resolved count diverged: alignment is ambiguous. Report it as a
    // resolution error (render covers it) WITHOUT recording any session id — so
    // a later successful refreshSharePayloads (counts now aligned) is free to
    // start the save. This MUST run before we touch the session guard, otherwise
    // the resumed-session check below would block the retry and trap the screen
    // on an idle spinner forever.
    if (resolvedSharedPayloads.length !== raw.length) {
      return;
    }

    const reconciled = reconcileSession(
      shareStore,
      userId,
      raw,
      () => Crypto.randomUUID(),
    );

    if (reconciled.kind === 'empty') {
      // No payloads resolved to anything saveable; render's empty branch covers it.
      return;
    }
    if (reconciled.kind === 'clear') {
      // A previously-completed session matches: clear native payloads and leave.
      // Deferred out of the synchronous effect body so completeSession's
      // setState does not trigger a cascading render.
      void Promise.resolve().then(() => completeSession(reconciled.session));
      return;
    }

    const session = reconciled.session;

    // A run is already in flight for THIS session: don't restart it (the user
    // may be mid-save, or the saving phase is already shown). A run for a
    // DIFFERENT session is allowed: runSave's guard only blocks the same id, and
    // the newer run replaces the persisted record (the older run's mutations are
    // session-scoped and no-op against the newer record).
    if (runningSessionId.current === session.sessionId) {
      return;
    }
    // A session already settled to the partial screen must not auto-restart on
    // every re-render — only the explicit "Retry failed" button re-runs it. A
    // new session (different id) is unaffected.
    if (partialSessionId.current === session.sessionId) {
      return;
    }

    // Fire and forget; runSave guards re-entrancy (per session id) and sets the
    // terminal phase. Deferred out of the synchronous effect body so runSave's
    // initial setPhase('saving') does not trip the cascading-render lint rule.
    void Promise.resolve().then(() =>
      runSave(session, toResolved(resolvedSharedPayloads), saveDeps),
    );
  }, [
    user,
    sharedPayloads,
    resolvedSharedPayloads,
    isResolving,
    error,
    saveDeps,
    runSave,
    completeSession,
  ]);

  // --- Derived resolution state (pure functions of hook props) --------------

  // A divergent raw/resolved count is an ambiguous-alignment error, reported as
  // the resolution-error phase rather than guessing which raw index maps where.
  const resolutionError =
    error !== null ||
    (!isResolving &&
      sharedPayloads.length > 0 &&
      resolvedSharedPayloads.length !== sharedPayloads.length);
  const nothingResolved =
    !isResolving &&
    error === null &&
    sharedPayloads.length === 0 &&
    phase.kind === 'idle';

  // --- Phase render ---------------------------------------------------------

  /** Clears native payloads (best-effort), drops any persisted session, and
   * returns Home. Used by the resolution-error and empty states. Deleting the
   * session is essential: a session may already exist (e.g. counts diverged
   * after the record was created), and leaving it would let a later identical
   * share resume the canceled work instead of starting fresh. */
  const abandon = useCallback(() => {
    deleteSession(shareStore);
    try {
      clearSharedPayloads();
    } catch {
      // best-effort; the share extension has nothing durable to lose here
    }
    router.replace('/');
  }, [clearSharedPayloads, router]);

  // --- Phase render ---------------------------------------------------------

  // Derived resolution states take precedence over the session-driven phases
  // stored in `phase`: they are pure functions of the hook props and avoid the
  // synchronous-in-effect setState that storing them would require.
  if (isResolving && phase.kind === 'idle') {
    return <Centered label="Reading shared content…" spinner theme={theme} />;
  }
  if (resolutionError) {
    return (
      <ErrorActions
        title="Couldn’t read the shared content"
        theme={theme}
        cancelLabel="Cancel"
        onCancel={abandon}
        retryLabel="Try again"
        onRetry={() => refreshSharePayloads()}
      />
    );
  }
  if (nothingResolved) {
    return (
      <ErrorActions
        title="Nothing to save"
        theme={theme}
        retryLabel="Done"
        onRetry={abandon}
        single
      />
    );
  }
  if (phase.kind === 'saving') {
    const { saved, total } = countProgress(phase.session);
    return <Centered label={`Saved ${saved} of ${total}…`} spinner theme={theme} />;
  }
  if (phase.kind === 'partial') {
    const { saved, failed, total } = countPartial(phase.session);
    // Show Retry only when there is at least one failed/pending entry left to
    // attempt. Unsupported entries have nothing to retry.
    const hasRetryable = phase.session.entries.some(
      (e) => e.status === 'failed' || e.status === 'pending',
    );
    // failed counts only failed/unsupported terminal entries; the orchestration-
    // error catch path can land here with still-pending entries (failed===0), so
    // word the subtitle from the count rather than assuming at least one failed.
    const failedWording =
      failed === 0
        ? 'Some items are still pending.'
        : failed === 1
          ? 'One item couldn’t be saved.'
          : `${failed} items couldn’t be saved.`;
    return (
      <View style={styles.container}>
        <Text style={styles.title(theme)}>
          Saved {saved} of {total}
        </Text>
        <Text style={styles.subtitle(theme)}>
          {failedWording} You can retry, or keep what saved.
        </Text>
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {phase.session.entries
            .filter((e) => e.status === 'failed' || e.status === 'unsupported')
            .map((e) => (
              <Text key={e.operationId} style={styles.failedItem(theme)}>
                {e.message ?? 'Could not save this item'}
              </Text>
            ))}
        </ScrollView>
        <View style={styles.actions}>
          <Button
            label="Cancel"
            theme={theme}
            onPress={() => completeSession(phase.session)}
          />
          <Button
            label="Continue with saved"
            theme={theme}
            onPress={() => completeSession(phase.session)}
          />
          {hasRetryable ? (
            <Button
              label="Retry failed"
              theme={theme}
              primary
              onPress={() => {
                const live = loadSession(shareStore);
                if (live === null) return;
                void runSave(live, toResolved(resolvedSharedPayloads), saveDeps);
              }}
            />
          ) : null}
        </View>
      </View>
    );
  }
  if (phase.kind === 'clearFailed') {
    // Native clear threw: the completed session is retained so a remount (or the
    // Try again press) re-attempts it. This is the escape hatch so a persistently
    // throwing clear never traps the user on an eternal "Saving…" spinner.
    return (
      <ErrorActions
        title="Saved, but couldn’t finish"
        theme={theme}
        cancelLabel="Cancel"
        onCancel={() => router.replace('/')}
        retryLabel="Try again"
        onRetry={() => completeSession(phase.session)}
      />
    );
  }
  // complete: brief spinner before navigation lands.
  return <Centered label="Saved to Amber" spinner theme={theme} />;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Writes a single settled entry to the store, scoped to `sessionId`. The scope
 * makes the persist a no-op if a newer share has replaced this session's record
 * mid-flight, preventing cross-session corruption. Safe to call for any status. */
function persistEntry(entry: ShareEntry, sessionId: string): void {
  const patch: Partial<ShareEntry> = {
    status: entry.status,
    kind: entry.kind,
  };
  if (entry.itemId !== undefined) patch.itemId = entry.itemId;
  if (entry.message !== undefined) patch.message = entry.message;
  updateEntry(shareStore, entry.index, patch, sessionId);
}

/** Returns a copy of `session` with the entry matching `settled.index` replaced
 * by the settled version, so the saving phase can reflect incremental progress. */
function withEntry(session: ShareSession, settled: ShareEntry): ShareSession {
  return {
    ...session,
    entries: session.entries.map((e) => (e.index === settled.index ? settled : e)),
  };
}

/** Maps the SDK's resolved payloads to the processor's minimal slice. */
function toResolved(
  resolved: ReturnType<typeof useIncomingShare>['resolvedSharedPayloads'],
): ResolvedPayload[] {
  return resolved.map((p) => ({
    contentType: p.contentType,
    value: p.value,
    contentUri: p.contentUri,
    contentMimeType: p.contentMimeType,
  }));
}

function countProgress(session: ShareSession): { saved: number; total: number } {
  const saved = session.entries.filter((e) => e.status === 'saved').length;
  return { saved, total: session.entries.length };
}

function countPartial(session: ShareSession): {
  saved: number;
  failed: number;
  total: number;
} {
  const saved = session.entries.filter((e) => e.status === 'saved').length;
  const failed = session.entries.filter(
    (e) => e.status === 'failed' || e.status === 'unsupported',
  ).length;
  return { saved, failed, total: session.entries.length };
}

// ---------------------------------------------------------------------------
// Presentational pieces (existing theme typography/buttons — no design system)
// ---------------------------------------------------------------------------

type Theme = ReturnType<typeof useUnistyles>['theme'];

function Centered({
  label,
  spinner,
  theme,
}: {
  label: string;
  spinner?: boolean;
  theme: Theme;
}) {
  return (
    <View style={styles.container}>
      {spinner ? <ActivityIndicator color={theme.colors.primary} /> : null}
      <Text style={styles.label(theme)}>{label}</Text>
    </View>
  );
}

function ErrorActions({
  title,
  theme,
  cancelLabel,
  onCancel,
  retryLabel,
  onRetry,
  single,
}: {
  title: string;
  theme: Theme;
  cancelLabel?: string;
  onCancel?: () => void;
  retryLabel: string;
  onRetry: () => void;
  single?: boolean;
}) {
  return (
    <View style={styles.container}>
      <Text style={styles.title(theme)}>{title}</Text>
      <View style={styles.actions}>
        {single || cancelLabel === undefined || onCancel === undefined ? null : (
          <Button label={cancelLabel} theme={theme} onPress={onCancel} />
        )}
        <Button label={retryLabel} theme={theme} primary onPress={onRetry} />
      </View>
    </View>
  );
}

function Button({
  label,
  theme,
  primary,
  onPress,
}: {
  label: string;
  theme: Theme;
  primary?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[styles.button(theme), primary && styles.buttonPrimary(theme)]}
      onPress={onPress}
    >
      <Text style={[styles.buttonText(theme), primary && styles.buttonTextPrimary(theme)]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.gap(1.5),
    backgroundColor: theme.colors.background,
    paddingHorizontal: theme.gap(3),
  },
  label: (theme: Theme) => ({
    fontFamily: theme.fonts.medium,
    fontSize: 15,
    color: theme.colors.muted,
  }),
  title: (theme: Theme) => ({
    fontFamily: theme.fonts.bold,
    fontSize: 17,
    color: theme.colors.foreground,
    textAlign: 'center',
  }),
  subtitle: (theme: Theme) => ({
    fontFamily: theme.fonts.regular,
    fontSize: 14,
    color: theme.colors.muted,
    textAlign: 'center',
  }),
  list: {
    width: '100%',
    maxHeight: 200,
  },
  listContent: {
    gap: theme.gap(1),
    paddingVertical: theme.gap(2),
  },
  failedItem: (theme: Theme) => ({
    fontFamily: theme.fonts.regular,
    fontSize: 13,
    color: theme.colors.danger,
    textAlign: 'center',
  }),
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: theme.gap(1.5),
    marginTop: theme.gap(2),
  },
  button: (theme: Theme) => ({
    paddingVertical: theme.gap(1.5),
    paddingHorizontal: theme.gap(2.5),
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  }),
  buttonPrimary: (theme: Theme) => ({
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  }),
  buttonText: (theme: Theme) => ({
    fontFamily: theme.fonts.bold,
    fontSize: 15,
    color: theme.colors.foreground,
  }),
  buttonTextPrimary: (theme: Theme) => ({
    color: '#fffdf8',
  }),
}));
