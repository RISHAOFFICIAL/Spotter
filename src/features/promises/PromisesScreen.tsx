/**
 * Promises screen — the Treats/Promises ledger (owner decision 2026-09-11,
 * rev 13, pair-private). Lives behind the Profile row — NO tab (feed tab ==
 * home tab in MVP).
 *
 * THE locked rule rendered here: every entry is visible ONLY to the
 * promise-maker and their ONE snapshotted witness — never the whole group, at
 * any group size. The screen fetches through fetchLedger() (pair-scoped by
 * RLS in real mode / by the same filter in the dev mock), so entries between
 * two OTHER members of the caller's group are simply absent in-frame.
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
  fetchLedger,
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

  const load = useCallback(async () => {
    const session = await getStoredSession();
    setMyId(session?.user.id ?? null);
    const [rows, note, witnessId] = await Promise.all([fetchLedger(), getMissPromise(), getMissWitnessId()]);
    setEntries(rows);
    setNoteSet(!!note);
    // Witness first name for the empty-state-1 line: the note's witness; when
    // the note is set that id is always resolvable from the ledger rows' names
    // (or the fallback).
    if (witnessId) {
      const row = rows.find((r) => r.witnessId === witnessId);
      setWitnessName(row?.witnessName ?? null);
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
  const hasBeenMissed = rows.length > 0;

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
          <View style={styles.emptyBlock}>
            <Text style={[textStyles.headline.style, { color: colors.text.primary.hex }]}>{emptyTitle}</Text>
            <Text style={[textStyles.caption.style, { color: colors.text.secondary.hex, textAlign: 'center' }]}>
              {emptyBody}
            </Text>
          </View>
        }
        ListFooterComponent={
          <>
            {error && (
              <Text style={[textStyles.caption.style, { color: colors.text.danger.hex, textAlign: 'center', marginTop: spacing.lg }]}>
                {error}
              </Text>
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
    borderColor: 'rgba(255,255,255,0.08)',
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
  chipDone: { backgroundColor: colors.background.overlay.hex, borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)' },
  settleRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  emptyBlock: { alignItems: 'center', paddingTop: spacing.xxxl * 2, gap: spacing.sm, paddingHorizontal: spacing.xl },
});