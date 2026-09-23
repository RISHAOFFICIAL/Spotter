/**
 * Promises screen — the Treats/Promises ledger (owner decision 2026-09-11,
 * rev 13, pair-private). Lives behind the Profile row — NO tab (feed tab ==
 * home tab in MVP).
 *
 * THE locked rule rendered here: every entry is visible ONLY to the
 * promise-maker and their ONE snapshotted witness — never the whole group, at
 * any group size. The screen fetches through readLedger() (pair-scoped by
 * RLS in real mode / by the same filter in the dev mock), so entries between
 * two OTHER members of the caller's group are simply absent in-frame. A read
 * that FAILS is named on screen with a retry (2026-09-23) — it must never be
 * mistaken for a genuinely empty ledger.
 *
 * Views:
 *   - maker view:  "I owe you: {text}."  + state chip + one-tap settle
 *                  (Kept / Let it go) while OPEN.
 *   - witness view: "{MakerFirstName} owes you: {text}."  + state chip, NO
 *                  settle buttons, ever (passive, see-only).
 * States: OPEN / KEPT / LET IT GO (exact casing). Newest week first,
 * forward-only, no pagination. No notifications for promises in v1.0.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppButton } from '@/components/AppButton';
import { getMissPromise, getMissWitnessId } from '@/lib/missPromise';
import { getStoredSession } from '@/lib/supabase';
import {
  readLedger,
  resolvePromise,
  type LedgerEntry,
  PROMISES_SCREEN_TITLE,
  PROMISES_SCREEN_SUBTITLE,
  LEDGER_FRAMING_LINE,
  LEDGER_PAIR_LINE,
  LEDGER_EMPTY1_TITLE,
  LEDGER_EMPTY1_BODY_WITH_NOTE,
  LEDGER_EMPTY1_BODY_NO_NOTE,
  LEDGER_EMPTY2_TITLE,
  LEDGER_EMPTY2_BODY,
  LEDGER_LOAD_ERROR_TITLE,
  LEDGER_LOAD_ERROR_BODY,
  LEDGER_RETRY_LABEL,
} from '@/lib/promises';
import { colors, radius, spacing } from '@/theme/tokens';
import { textStyles } from '@/theme/typography';

const CHIP_LABELS: Record<LedgerEntry['state'], string> = {
  open: 'OPEN',
  kept: 'KEPT',
  let_go: 'LET IT GO',
};

function StateChip({ state }: { state: LedgerEntry['state'] }) {
  const isOpen = state === 'open';
  return (
    <View style={[styles.chip, isOpen ? styles.chipOpen : styles.chipDone]} accessibilityLabel={`promise ${CHIP_LABELS[state]}`}>
      <Text style={[textStyles.label.style, { color: isOpen ? colors.text.onVolt.hex : colors.text.secondary.hex }]}>
        {CHIP_LABELS[state]}
      </Text>
    </View>
  );
}

function EntryCard({
  entry,
  isMaker,
  busy,
  onSettle,
}: {
  entry: LedgerEntry;
  isMaker: boolean;
  busy: boolean;
  onSettle: (entryId: string, state: 'kept' | 'let_go') => void;
}) {
  const relationName = isMaker ? entry.witnessName : entry.makerName;
  const line = isMaker ? `I owe you: ${entry.promiseText}.` : `${entry.makerName} owes you: ${entry.promiseText}.`;
  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <Text style={[textStyles.bodyStrong.style, { color: colors.text.primary.hex, flex: 1 }]} numberOfLines={2}>
          {line}
        </Text>
        <StateChip state={entry.state} />
      </View>
      <Text style={[textStyles.caption.style, { color: colors.text.muted.hex }]}>
        {LEDGER_PAIR_LINE}
      </Text>
      {isMaker && entry.state === 'open' && (
        <View style={styles.settleRow}>
          <AppButton
            label="Kept"
            onPress={() => onSettle(entry.id, 'kept')}
            loading={busy}
            style={{ flex: 1 }}
          />
          <AppButton
            label="Let it go"
            type="ghost"
            onPress={() => onSettle(entry.id, 'let_go')}
            disabled={busy}
            style={{ flex: 1 }}
          />
        </View>
      )}
      {isMaker && entry.state !== 'open' && (
        <Text style={[textStyles.caption.style, { color: colors.text.secondary.hex }]}>
          Settled with {relationName}.
        </Text>
      )}
    </View>
  );
}

export function PromisesScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  const [noteSet, setNoteSet] = useState(false);
  const [witnessName, setWitnessName] = useState<string | null>(null);
  const [myId, setMyId] = useState<string | null>(null);
  const [settling, setSettling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // v1.0 fix (2026-09-23): a failed READ is its own, visible state. It used to
  // be invisible — the read returned [] and the screen drew "No promises yet.",
  // so a broken live read was indistinguishable from a genuinely empty ledger.
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const session = await getStoredSession();
    setMyId(session?.user.id ?? null);
    const [read, note, witnessId] = await Promise.all([readLedger(), getMissPromise(), getMissWitnessId()]);
    if (read.ok) {
      setEntries(read.entries);
      setLoadError(null);
    } else {
      // Keep whatever was already on screen; the empty-state slot below (or the
      // footer, when rows exist) names the failure and offers a retry.
      setLoadError(read.error);
    }
    setNoteSet(!!note);
    // Witness first name for the empty-state-1 line: the note's witness. Resolve
    // it from the ledger row when one exists, else from the SAME member map the
    // read already built — an empty ledger (note set, nothing missed yet, the
    // state the owner is most likely to see) must not degrade to "A member".
    if (witnessId) {
      const row = read.ok ? read.entries.find((r) => r.witnessId === witnessId) : undefined;
      const fromMap = read.ok ? read.names.get(witnessId) : undefined;
      setWitnessName(row?.witnessName ?? fromMap?.trim() ?? null);
    } else {
      setWitnessName(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSettle = async (entryId: string, state: 'kept' | 'let_go') => {
    if (settling) return;
    setSettling(entryId);
    setError(null);
    const res = await resolvePromise(entryId, state);
    setSettling(null);
    if (!res.ok) {
      setError(res.error ?? 'Could not settle the promise. Try again.');
      return;
    }
    // Refetch the ledger + badges locally (spec §5).
    await load();
  };

  const rows = entries ?? [];
  const allSettled = rows.length > 0 && rows.every((r) => r.state !== 'open');
  // One failure line, shown wherever there is room for it: in the empty slot
  // when nothing rendered, otherwise in the footer under the rows.
  const failureLine = error ?? (rows.length > 0 ? loadError : null);

  const emptyTitle = allSettled ? LEDGER_EMPTY2_TITLE : LEDGER_EMPTY1_TITLE;
  const emptyBody = allSettled
    ? LEDGER_EMPTY2_BODY
    : noteSet
      ? LEDGER_EMPTY1_BODY_WITH_NOTE.replace('{witnessFirstName}', witnessName ?? 'A member')
      : LEDGER_EMPTY1_BODY_NO_NOTE;

  return (
    <View style={[styles.screen, { paddingTop: insets.top + spacing.md, paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
      <View style={styles.headerRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          hitSlop={10}
          style={styles.backBtn}
        >
          <Text style={[textStyles.title.style, { color: colors.text.secondary.hex, fontSize: 22, lineHeight: 24 }]}>‹</Text>
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={[textStyles.title.style, styles.headerTitle]}>{PROMISES_SCREEN_TITLE}</Text>
          <Text style={[textStyles.caption.style, { color: colors.text.secondary.hex }]}>
            {PROMISES_SCREEN_SUBTITLE}
          </Text>
        </View>
        <View style={styles.backBtn} />
      </View>

      <FlatList
        data={rows}
        keyExtractor={(e) => e.id}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => (
          <EntryCard
            entry={item}
            isMaker={!!myId && item.makerId === myId}
            busy={settling === item.id}
            onSettle={handleSettle}
          />
        )}
        ListEmptyComponent={
          loadError ? (
            <View style={styles.emptyBlock}>
              <Text style={[textStyles.headline.style, { color: colors.text.primary.hex }]}>
                {LEDGER_LOAD_ERROR_TITLE}
              </Text>
              <Text style={[textStyles.caption.style, { color: colors.text.secondary.hex, textAlign: 'center' }]}>
                {LEDGER_LOAD_ERROR_BODY}
              </Text>
              <Text style={[textStyles.caption.style, styles.errorDetail]}>{loadError}</Text>
              <AppButton label={LEDGER_RETRY_LABEL} onPress={() => void load()} style={styles.retryBtn} />
            </View>
          ) : (
            <View style={styles.emptyBlock}>
              <Text style={[textStyles.headline.style, { color: colors.text.primary.hex }]}>{emptyTitle}</Text>
              <Text style={[textStyles.caption.style, { color: colors.text.secondary.hex, textAlign: 'center' }]}>
                {emptyBody}
              </Text>
            </View>
          )
        }
        ListFooterComponent={
          <>
            {failureLine && (
              <Text style={[textStyles.caption.style, styles.errorLine]}>{failureLine}</Text>
            )}
            <Text style={[textStyles.caption.style, { color: colors.text.muted.hex, textAlign: 'center', marginTop: spacing.xxl }]}>
              {LEDGER_FRAMING_LINE}
            </Text>
          </>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background.base.hex, paddingHorizontal: spacing.screen.paddingX },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 44, paddingHorizontal: spacing.xs, marginBottom: spacing.md },
  backBtn: { width: 32, alignItems: 'center', justifyContent: 'center' },
  headerCopy: { flex: 1, alignItems: 'center', gap: 2 },
  headerTitle: { color: colors.text.primary.hex },
  listContent: { paddingBottom: spacing.xxxl },
  card: {
    backgroundColor: colors.background.surface.hex,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.08)',
    padding: spacing.lg,
    marginBottom: spacing.sm,
    gap: spacing.sm,
  },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  chip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  chipOpen: { backgroundColor: colors.brand.primary.hex },
  chipDone: { backgroundColor: colors.background.overlay.hex, borderWidth: 1, borderColor: 'rgba(0,0,0,0.12)' },
  settleRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  // A failed READ (distinct from a failed settle above): the words say what
  // happened, the raw reason sits under them, and the retry re-runs load().
  errorLine: { color: colors.text.danger.hex, textAlign: 'center', marginTop: spacing.lg },
  errorDetail: { color: colors.text.muted.hex, textAlign: 'center' },
  retryBtn: { alignSelf: 'stretch', marginTop: spacing.sm },
  emptyBlock: { alignItems: 'center', paddingTop: spacing.xxxl * 2, gap: spacing.sm, paddingHorizontal: spacing.xl },
});