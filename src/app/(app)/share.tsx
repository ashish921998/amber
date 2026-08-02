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
 * so the user gets retry/continue/cancel — only an all-saved batch completes. */
type Phase =
  | { kind: 'idle' }
  | { kind: 'saving'; session: ShareSession }
  | { kind: 'partial'; session: ShareSession }
  | { kind: 'complete' };

export default function ShareScreen() {
  const router = useRouter();
  const { theme } = useUnistyles();
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
  // Prevents two concurrent save runs for the same session (a fast re-render
  // could otherwise kick off a second processSession before the first settles).
  const runningRef = useRef(false);
  // Guards navigation + clear so completion runs exactly once per session.
  const completingRef = useRef(false);
  // Tracks the session id we have already reacted to, so a reconciliation that
  // re-returns the same active session does not re-trigger a save run.
  const reactedSessionId = useRef<string | null>(null);

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
   * clear → delete-session reconciliation applies unchanged. */
  const completeSession = useCallback(
    (session: ShareSession) => {
      if (completingRef.current) return;
      completingRef.current = true;
      // 1. Persist complete BEFORE the native clear. A crash between backend
      //    success and clear is then reconciled on remount (a matching
      //    completed session clears native payloads and deletes itself).
      markComplete(shareStore);
      try {
        // 2. Native clear. A throwing clear keeps the completed session (no
        //    delete, no navigation) so remount reconciliation retries it.
        clearSharedPayloads();
      } catch (err) {
        console.error('clearSharedPayloads threw during completion; deferring', err);
        completingRef.current = false;
        return;
      }
      // 3. Delete the local session ONLY after a successful clear — otherwise a
      //    later identical re-share would match a stale completed record and be
      //    silently dropped.
      deleteSession(shareStore);
      // 4. Navigate Home exactly once.
      setPhase({ kind: 'complete' });
      router.replace('/');
    },
    [clearSharedPayloads, router],
  );

  /** Runs the processor for the current session, persisting each settled entry
   * and advancing to the right terminal phase. */
  const runSave = useCallback(
    async (
      session: ShareSession,
      resolved: ResolvedPayload[],
      deps: ShareSaveDeps,
    ) => {
      if (runningRef.current) return;
      runningRef.current = true;

      // Classify entries (no side effects) if none have been processed yet,
      // persisting terminal statuses so a crash before any save still records
      // failed/unsupported entries on remount.
      const fresh = session.entries.every((e) => e.status === 'pending');
      let working = session;
      if (fresh) {
        const classified = classifyEntries(session, resolved);
        working = { ...session, entries: classified };
        for (const entry of classified) {
          if (entry.status !== 'pending') {
            persistEntry(entry);
          }
        }
      }

      setPhase({ kind: 'saving', session: working });

      const result = await processSession(
        working,
        resolved,
        deps,
        persistEntry, // persist each settled entry so a crash/restart loses nothing
      );

      runningRef.current = false;

      const allSaved = result.entries.every((e) => e.status === 'saved');
      if (allSaved) {
        completeSession(result);
      } else {
        // Some entries failed or were unsupported: stay and offer retry/continue.
        setPhase({ kind: 'partial', session: result });
      }
    },
    [completeSession],
  );

  // Reconcile + drive the save. The resolution-driven phases (resolving /
  // resolutionError / empty) are derived in render below; this effect only runs
  // once resolution has settled AND there are payloads to save, so it contains
  // no synchronous setState for the derived states.
  useEffect(() => {
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
    const reconciled = reconcileSession(shareStore, raw, () => Crypto.randomUUID());

    if (reconciled.kind === 'empty') {
      // No payloads resolved to anything saveable; render's empty branch covers it.
      return;
    }
    if (reconciled.kind === 'clear') {
      // A previously-completed session matches: clear native payloads and leave.
      // deleteSession already ran inside reconcileSession. Deferred out of the
      // synchronous effect body so completeSession's setState does not trigger a
      // cascading render; the work is idempotent and order-independent.
      void Promise.resolve().then(() => completeSession(reconciled.session));
      return;
    }

    // new or resume — both carry an active session to save/resume.
    const session = reconciled.session;
    // Guard against re-running the same active session on every render.
    if (reactedSessionId.current === session.sessionId && reconciled.kind === 'resume') {
      // The user is already interacting with retry/continue for this session;
      // keep the existing phase rather than restarting the save.
      return;
    }
    reactedSessionId.current = session.sessionId;

    // Raw/resolved count diverged: alignment is ambiguous — render's
    // resolutionError branch (via the derived checks) covers it. Nothing to do.
    if (resolvedSharedPayloads.length === 0 || resolvedSharedPayloads.length !== raw.length) {
      return;
    }

    // Fire and forget; runSave guards re-entrancy and sets terminal phase.
    void runSave(session, toResolved(resolvedSharedPayloads), saveDeps);
  }, [
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

  /** Clears native payloads (best-effort) and returns Home. Used by the
   * resolution-error and empty states, where no session was persisted. */
  const abandon = useCallback(() => {
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
    return (
      <View style={styles.container}>
        <Text style={styles.title(theme)}>
          Saved {saved} of {total}
        </Text>
        <Text style={styles.subtitle(theme)}>
          {failed > 1
            ? `${failed} items couldn’t be saved.`
            : 'One item couldn’t be saved.'}{' '}
          You can retry, or keep what saved.
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
  // complete: brief spinner before navigation lands.
  return <Centered label="Saved to Amber" spinner theme={theme} />;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Writes a single settled entry to the store. Safe to call for any status. */
function persistEntry(entry: ShareEntry): void {
  const patch: Partial<ShareEntry> = {
    status: entry.status,
    kind: entry.kind,
  };
  if (entry.itemId !== undefined) patch.itemId = entry.itemId;
  if (entry.message !== undefined) patch.message = entry.message;
  updateEntry(shareStore, entry.index, patch);
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
