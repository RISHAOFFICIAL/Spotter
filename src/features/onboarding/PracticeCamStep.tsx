/**
 * PracticeCamStep — onboarding step 2 of 4 (onboarding-copy-addendum
 * 2026-09-11, §2/§3): a safe, honest dry run of the real dual-capture log.
 *
 * Laws for this step (no-row/no-ring contract): the practice shots are
 * IN-MEMORY ONLY — no `logWorkout`, no storage write, no ring mutation, no
 * feed post. Both captures are discarded on leave (best-effort File.delete of
 * the camera cache URIs; never uploaded). The copy states this out loud:
 * "Nothing gets saved or posted." / "Your ring didn't move — practice never
 * counts."
 *
 * Flow: 'ask' (contextual permission card — the ONLY OS camera ask on this
 * step; one permission covers both lenses) → 'shot1' (front lens forced, flip
 * hidden) → 'flip' (~1.2s "Nice. Now your surroundings." overlay, auto-flips
 * to back) → 'shot2' (back lens forced, ALWAYS unfiltered) → 'review' (two
 * thumbs, practice caption, one Retake that redoes both shots) → Next (shell
 * CTA, always enabled — capture is encouraged, not required). 'denied' keeps
 * the step skippable: camera hides, Settings escape hatch is stated, preview
 * frame + Next remain.
 *
 * Filters: the SELFIE_FILTER_* chip row + live tint from src/lib/filters.ts
 * are reused on the selfie stage as a LIVE PREVIEW ONLY — no bake, no upload
 * (lead's S4b-2 brief; the real bake path lives in LogSheet/selfieBake).
 *
 * Layout: the preview frame (mock feed card + real empty WeeklyRing) and the
 * stakes/nudge line render on the ask / denied / review surfaces. During
 * capture stages the camera fills the stage area (mirrors LogSheet's camera
 * wrap) so the practice teaches exactly what real logging asks.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { CameraView, useCameraPermissions, type CameraCapturedPicture } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { File } from 'expo-file-system';
import { LEDGER_FRAMING_LINE, STAKES_PREVIEW_PAIR_LINE } from '@/lib/promises';

// RN 0.86 strict-api typing drops `style` from expo-camera's CameraView JSX
// props; local passthrough keeps the typed props usable (same pattern as
// LogSheet — zero runtime change).
type CameraViewProps_ = {
  ref?: React.Ref<CameraView>;
  style: StyleProp<ViewStyle>;
  facing: 'front' | 'back';
  onMountError?: () => void;
};
const CameraViewT = CameraView as unknown as React.ComponentType<CameraViewProps_>;

import { AppButton, TextButton } from '@/components/AppButton';
import { WeeklyRing } from '@/features/home/WeeklyRing';
import { colors, icons, radius, spacing } from '@/theme/tokens';
import { textStyles } from '@/theme/typography';
import {
  SELFIE_FILTER_HELPER,
  SELFIE_FILTER_IDS,
  SELFIE_FILTER_PRESETS,
  filterA11yLabel,
  type SelfieFilter,
} from '@/lib/filters';

import { OnboardingScreen } from './OnboardingScreen';

type Stage = 'ask' | 'shot1' | 'flip' | 'shot2' | 'review' | 'denied';

/** Flip-cue overlay duration — same beat as the real LogSheet. */
const FLIP_CUE_MS = 1200;
/** Practice caption cap — mirrors the real flow's CAPTION_MAX. */
const PRACTICE_CAPTION_MAX = 140;
/** Preview-frame ring: keep the REAL WeeklyRing, rendered compact. */
const RING_SCALE = 0.52;

/** Discard a camera cache file (in-memory contract). Best-effort only. */
function discardCapture(uri: string | undefined) {
  if (!uri) return;
  try {
    const f = new File(uri);
    // delete() is synchronous in this expo-file-system version — it can still
    // throw on a missing/invalid path; the try/catch below absorbs that.
    f.delete();
  } catch {
    // Cache file — safe to ignore if the File API rejects the URI.
  }
}

function PreviewFrame() {
  return (
    <View style={styles.previewCard}>
      <Text style={[textStyles.caption.style, styles.refLine]}>
        Your ring lives at the top of Home — it counts only your workouts and reads WEEK COMPLETE once you hit your goal.
      </Text>
      <Text style={[textStyles.caption.style, styles.refLine]}>
        Every log lands in the feed right below it, newest first — this is where yours will show up.
      </Text>
      <Text style={[textStyles.caption.style, styles.refLine]}>
        The big volt camera button is how you log for real — a Live badge marks fresh posts.
      </Text>
      <View style={styles.previewRow}>
        <View accessible accessibilityLabel="Feed preview" style={styles.mockCard}>
          <View style={styles.mockPhoto}>
            <View style={styles.previewChip} pointerEvents="none">
              <Text style={[textStyles.label.style, styles.previewChipText]}>PREVIEW</Text>
            </View>
            <View style={[styles.liveBadge, styles.mockLiveBadge]} pointerEvents="none">
              <Ionicons name="radio" size={9} color={colors.brand.primary.hex} />
              <Text style={[textStyles.label.style, styles.liveBadgeText]}>Live</Text>
            </View>
          </View>
          <View style={styles.mockBody}>
            <Text style={[textStyles.captionStrong.style, { color: colors.text.primary.hex }]}>you</Text>
            <View style={styles.mockLine} />
            <Text style={[textStyles.label.style, { color: colors.text.muted.hex }]}>just now</Text>
          </View>
        </View>
        <View style={styles.ringWrap}>
          <View style={[styles.ringScale, { transform: [{ scale: RING_SCALE }] }]}>
            <WeeklyRing count={0} goal={3} weekEndedUnmet={false} />
          </View>
        </View>
      </View>
    </View>
  );
}

function StakesLine() {
  return (
    <Text style={[textStyles.caption.style, styles.stakesLine]}>
      {STAKES_PREVIEW_PAIR_LINE} {LEDGER_FRAMING_LINE}
    </Text>
  );
}

export function PracticeCamStep({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();

  const [stage, setStage] = useState<Stage>('ask');
  const [selfie, setSelfie] = useState<CameraCapturedPicture | null>(null);
  const [env, setEnv] = useState<CameraCapturedPicture | null>(null);
  const [filter, setFilter] = useState<SelfieFilter>('none');
  const [caption, setCaption] = useState('');
  const [facing, setFacing] = useState<'front' | 'back'>('front');
  const [snapping, setSnapping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewShot, setPreviewShot] = useState<'selfie' | 'env' | null>(null);

  const cameraRef = useRef<CameraView>(null);
  const busy = useRef(false);
  const flipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Live list of captured files so unmount/retake can discard them all.
  const capturesRef = useRef<CameraCapturedPicture[]>([]);

  // Already-granted OS permission (returning user): skip the contextual card,
  // and recover if the user grants in Settings while parked on 'denied'.
  useEffect(() => {
    if (permission?.granted && (stage === 'ask' || stage === 'denied')) {
      setStage('shot1');
    }
  }, [permission?.granted, stage]);

  // No-row/no-ring contract: discard captures on leave, clear timers.
  useEffect(() => {
    return () => {
      if (flipTimer.current) clearTimeout(flipTimer.current);
      for (const p of capturesRef.current) discardCapture(p.uri);
      capturesRef.current = [];
    };
  }, []);

  const takePhoto = useCallback(async () => {
    if (busy.current) return;
    if (stage !== 'shot1' && stage !== 'shot2') return;
    busy.current = true;
    setError(null);
    try {
      if (!permission?.granted) {
        const res = await requestPermission();
        if (!res.granted) {
          setStage('denied');
          busy.current = false;
          return;
        }
      }
      setSnapping(true);
      const photo = await cameraRef.current?.takePictureAsync({ quality: 0.6 });
      if (!photo) {
        setSnapping(false);
        setError('Couldn\u2019t capture. Try again.');
        return;
      }
      // PRACTICE: in-memory only — the filter is a live-preview tint, never
      // baked; the raw capture URI is shown in review and discarded on leave.
      capturesRef.current.push(photo);
      setSnapping(false);
      if (stage === 'shot1') {
        setSelfie(photo);
        setStage('flip');
        flipTimer.current = setTimeout(() => {
          setFacing('back');
          setStage('shot2');
        }, FLIP_CUE_MS);
      } else {
        setEnv(photo);
        setStage('review');
      }
    } catch {
      setSnapping(false);
      setError('Couldn\u2019t open the camera. Try again.');
    } finally {
      busy.current = false;
    }
  }, [permission?.granted, requestPermission, stage]);

  const allowCamera = useCallback(async () => {
    const res = await requestPermission();
    setStage(res.granted ? 'shot1' : 'denied');
  }, [requestPermission]);

  const retake = useCallback(() => {
    if (busy.current) return;
    if (flipTimer.current) clearTimeout(flipTimer.current);
    for (const p of capturesRef.current) discardCapture(p.uri);
    capturesRef.current = [];
    setSelfie(null);
    setEnv(null);
    setStage('shot1');
    setFacing('front');
    setError(null);
    // Caption + filter PRESERVED (mirrors the real flow's single-Retake).
  }, []);

  const isCaptureStage = stage === 'shot1' || stage === 'flip' || stage === 'shot2';
  const shotNumLabel = stage === 'shot2' ? 'SHOT 2 OF 2' : 'SHOT 1 OF 2';
  const shotAnnouncement = stage === 'shot2' ? 'Shot 2 of 2 — back camera' : 'Shot 1 of 2 — front camera';
  const filterPreset = SELFIE_FILTER_PRESETS[filter];

  return (
    <OnboardingScreen
      step={2}
      onPrimary={onNext}
      primaryLabel="Next"
      onSkip={onSkip}
    >
      <View style={styles.content}>
        <Text style={[textStyles.display.style, styles.headline]}>Take a practice shot</Text>
        <Text style={[textStyles.body.style, styles.subhead]}>
          A practice log, not a real one — two live shots, one caption, nothing saved or posted. We’ll ask for the camera so you can see how it feels.
        </Text>

        {stage === 'ask' && (
          <ScrollView
            style={styles.scrollable}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.permissionCard}>
              <Text style={[textStyles.bodyStrong.style, styles.cardTitle]}>One quick camera check</Text>
              <Text style={[textStyles.caption.style, styles.cardBody]}>
                SPOTTER only uses your camera for workout photos — and this practice one. Nothing from a practice shot ever leaves your phone.
              </Text>
              <Text style={[textStyles.caption.style, styles.cardHint]}>
                Say not now and keep going — this step is optional.
              </Text>
              <AppButton label="Allow camera" onPress={allowCamera} />
              <TextButton label="Not now" onPress={() => setStage('denied')} color={colors.text.secondary.hex} />
            </View>
            <PreviewFrame />
            <StakesLine />
          </ScrollView>
        )}

        {stage === 'denied' && (
          <ScrollView style={styles.scrollable} contentContainerStyle={styles.scrollContent}>
            <Text style={[textStyles.bodyStrong.style, styles.deniedLine]}>
              That’s okay — camera stays off for now. Logging still works once you allow it in Settings.
            </Text>
            <PreviewFrame />
            <StakesLine />
          </ScrollView>
        )}

        {isCaptureStage && (
          <View style={styles.cameraBlock}>
            <View style={styles.cameraViewport}>
              {permission?.granted ? (
                <CameraViewT
                  ref={cameraRef}
                  style={styles.camera as StyleProp<ViewStyle>}
                  facing={facing}
                  onMountError={() => setError('Couldn\u2019t open the camera. Try again.')}
                />
              ) : (
                <View style={styles.cameraFallback}>
                  <Ionicons name="camera-outline" size={44} color={colors.text.muted.hex} />
                  <Text style={[textStyles.caption.style, { color: colors.text.secondary.hex, textAlign: 'center' }]}>
                    We’ll ask for camera access when you tap the shutter.
                  </Text>
                </View>
              )}

              {/* Chrome: shot counter (center) + LIVE badge (top-right). */}
              <View style={styles.chromeTop} pointerEvents="none">
                <Text style={[textStyles.label.style, styles.chromeLabel]}>{shotNumLabel}</Text>
                <View style={styles.liveBadge}>
                  <Ionicons name="radio" size={9} color={colors.brand.primary.hex} />
                  <Text style={[textStyles.label.style, styles.liveBadgeText]}>Live</Text>
                </View>
              </View>

              {/* Stage announcement (a11y): "Shot 1 of 2 — front camera". */}
              <Text style={styles.a11yAnnounce} accessibilityLiveRegion="polite" accessible>
                {shotAnnouncement}
              </Text>

              {/* Headline + helper over the viewport. */}
              <View style={styles.cameraCopy} pointerEvents="none">
                <Text style={[textStyles.bodyStrong.style, styles.cameraHeadline]}>
                  {stage === 'shot2' ? 'Where it happened.' : 'You first.'}
                </Text>
                <Text style={[textStyles.caption.style, styles.cameraHelper]}>
                  {stage === 'shot2'
                    ? 'Gym, trail, or weights — the place is half the proof.'
                    : 'Your group sees your face with every log — proof it’s you.'}
                </Text>
              </View>

              {/* Live filter grade (preview approximation only — never baked here).
                  Scoped to the camera viewport so the bars stay clean. */}
              {stage === 'shot1' && filter !== 'none' && filterPreset.previewTint && (
                <View pointerEvents="none" style={[styles.filterTint, { backgroundColor: filterPreset.previewTint }]} />
              )}

              {snapping && (
                <View style={styles.processingOverlay} pointerEvents="none">
                  <Text style={[textStyles.label.style, { color: colors.text.primary.hex }]}>Snapping…</Text>
                </View>
              )}
            </View>

            {/* Filter chip row — selfie stage only, above the shutter bar. */}
            {stage === 'shot1' && (
              <View style={styles.filterBar}>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.filterRow}
                  keyboardShouldPersistTaps="handled"
                >
                  {SELFIE_FILTER_IDS.map((f) => {
                    const selected = filter === f;
                    return (
                      <Pressable
                        key={f}
                        accessibilityRole="button"
                        accessibilityLabel={filterA11yLabel(f)}
                        accessibilityState={{ selected }}
                        onPress={() => setFilter(f)}
                        style={({ pressed }) => [
                          styles.chip,
                          selected && styles.chipSelected,
                          pressed && { opacity: 0.85 },
                        ]}
                      >
                        <Text
                          style={[
                            textStyles.captionStrong.style,
                            { color: selected ? colors.text.onVolt.hex : colors.text.primary.hex },
                          ]}
                        >
                          {SELFIE_FILTER_PRESETS[f].label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
                <Text style={[textStyles.caption.style, styles.filterHelper]}>
                  {SELFIE_FILTER_HELPER}
                </Text>
              </View>
            )}

            <View style={styles.bottomBar}>
              <Text style={[textStyles.caption.style, { color: colors.text.secondary.hex, textAlign: 'center' }]}>
                Only your group will see this.
              </Text>
              <View style={styles.shutterRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Take photo"
                  onPress={takePhoto}
                  style={({ pressed }) => [styles.shutter, pressed && { opacity: 0.8 }]}
                >
                  <View style={styles.shutterInner} />
                </Pressable>
              </View>
              {error && (
                <Text style={[textStyles.caption.style, { color: colors.text.danger.hex, textAlign: 'center' }]}>
                  {error}
                </Text>
              )}
            </View>

            {/* Flip cue (~1.2s, no tap needed; pointerEvents none keeps the bar live). */}
            {stage === 'flip' && (
              <View style={styles.flipOverlay} pointerEvents="none">
                <View style={styles.flipCopy}>
                  <Text style={[textStyles.bodyStrong.style, styles.flipHeadline]}>Nice. Now your surroundings.</Text>
                  <Text style={[textStyles.caption.style, styles.flipHelper]}>Keep people out of frame.</Text>
                </View>
              </View>
            )}
          </View>
        )}

        {stage === 'review' && (
          <ScrollView
            style={styles.scrollable}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={[textStyles.label.style, styles.chromeLabel]}>REVIEW</Text>
            <Text style={[textStyles.bodyStrong.style, styles.reviewHeadline]}>Looks like a workout.</Text>
            <View style={styles.reviewShots}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="View photo"
                onPress={() => setPreviewShot('selfie')}
                style={styles.reviewShotWrap}
              >
                {selfie && <Image source={{ uri: selfie.uri }} style={styles.reviewShot} contentFit="cover" />}
                <Text style={styles.reviewShotLabel}>YOU</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="View photo"
                onPress={() => setPreviewShot('env')}
                style={styles.reviewShotWrap}
              >
                {env && <Image source={{ uri: env.uri }} style={styles.reviewShot} contentFit="cover" />}
                <Text style={styles.reviewShotLabel}>YOUR SPOT</Text>
              </Pressable>
            </View>
            <View style={styles.honestyRow}>
              <Text style={{ fontSize: icons.lengths.badge, color: colors.status.success.hex }}>✓</Text>
              <Text style={[textStyles.caption.style, styles.honestyText]}>Nothing gets saved or posted.</Text>
            </View>
            <Text style={[textStyles.caption.style, styles.ringTruth]}>
              Your ring didn’t move — practice never counts. Only real logged workouts fill it.
            </Text>
            <Text style={[textStyles.label.style, { color: colors.text.muted.hex }]}>CAPTION (OPTIONAL)</Text>
            <TextInput
              accessibilityLabel="Practice caption"
              value={caption}
              onChangeText={setCaption}
              placeholder="How’d it go?"
              placeholderTextColor={colors.text.muted.hex}
              maxLength={PRACTICE_CAPTION_MAX}
              style={styles.captionInput}
              autoCapitalize="sentences"
              returnKeyType="done"
            />
            <Pressable accessibilityRole="button" accessibilityLabel="Retake photos" onPress={retake} hitSlop={8}>
              <Text style={[textStyles.captionStrong.style, { color: colors.text.secondary.hex, textAlign: 'center' }]}>
                Retake
              </Text>
            </Pressable>
            <PreviewFrame />
            <StakesLine />
          </ScrollView>
        )}
      </View>

      {/* Review-thumb full-screen preview (a11y `View photo`). */}
      <Modal visible={previewShot !== null} transparent animationType="fade" onRequestClose={() => setPreviewShot(null)}>
        <View style={styles.previewModal}>
          {previewShot === 'selfie' && selfie && (
            <Image source={{ uri: selfie.uri }} style={styles.previewModalImg} contentFit="contain" />
          )}
          {previewShot === 'env' && env && (
            <Image source={{ uri: env.uri }} style={styles.previewModalImg} contentFit="contain" />
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close photo"
            onPress={() => setPreviewShot(null)}
            style={styles.previewModalClose}
          >
            <Ionicons name="close" size={22} color={colors.text.primary.hex} />
          </Pressable>
        </View>
      </Modal>
    </OnboardingScreen>
  );
}

const styles = StyleSheet.create({
  content: { flex: 1, paddingTop: spacing.screen.paddingTop },
  headline: { color: colors.text.primary.hex, textAlign: 'center', paddingHorizontal: spacing.sm },
  subhead: { color: colors.text.secondary.hex, textAlign: 'center', paddingHorizontal: spacing.md, marginTop: spacing.sm },
  scrollable: { flex: 1, marginTop: spacing.lg },
  scrollContent: { paddingBottom: spacing.xxl, gap: spacing.md },

  // ---- Contextual permission card (§2.2) — surface bg, hairline, radius 16 ----
  permissionCard: {
    backgroundColor: colors.background.surface.hex,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: radius.lg,
    padding: spacing.xl,
    gap: spacing.md,
  },
  cardTitle: { color: colors.text.primary.hex, textAlign: 'center' },
  cardBody: { color: colors.text.secondary.hex, textAlign: 'center' },
  cardHint: { color: colors.text.muted.hex, textAlign: 'center' },

  // ---- Preview frame (§2.6) — "here's where your photos will appear" ----
  previewCard: {
    backgroundColor: colors.background.surface.hex,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  refLine: { color: colors.text.secondary.hex, textAlign: 'center' },
  previewRow: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.xs },
  mockCard: {
    flex: 1,
    borderRadius: radius.md,
    backgroundColor: colors.background.raised.hex,
    overflow: 'hidden',
  },
  mockPhoto: {
    height: 84,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  previewChip: {
    position: 'absolute',
    top: 6,
    left: 6,
    paddingHorizontal: 6,
    height: 18,
    borderRadius: 9,
    backgroundColor: 'rgba(19,22,16,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewChipText: { color: colors.text.muted.hex, fontSize: 9, lineHeight: 11 },
  mockLiveBadge: { top: 6, right: 6 },
  mockBody: { padding: spacing.sm, gap: 4 },
  mockLine: { height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.14)', width: '80%' },
  ringWrap: { width: 92, alignItems: 'center', justifyContent: 'center' },
  ringScale: { width: Math.round(132 * RING_SCALE), height: Math.round(132 * RING_SCALE) },

  // ---- Stakes / nudge preview (§2.7) ----
  stakesLine: { color: colors.text.secondary.hex, textAlign: 'center', paddingHorizontal: spacing.sm },

  // ---- Denied state (§2.8) ----
  deniedLine: { color: colors.text.primary.hex, textAlign: 'center', paddingHorizontal: spacing.lg, paddingTop: spacing.xl },

  // ---- Camera block (capture stages; mirrors LogSheet patterns) ----
  cameraBlock: {
    flex: 1,
    marginTop: spacing.lg,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  cameraViewport: { flex: 1 },
  camera: { flex: 1 },
  cameraFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xxxl,
  },
  chromeTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chromeLabel: { color: colors.text.muted.hex, textAlign: 'center' },
  liveBadge: {
    position: 'absolute',
    right: spacing.lg,
    top: spacing.lg - 3,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    height: 18,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: 'rgba(198,241,53,0.35)',
    backgroundColor: 'rgba(198,241,53,0.10)',
  },
  liveBadgeText: { color: colors.brand.primary.hex },
  a11yAnnounce: {
    position: 'absolute',
    top: spacing.lg,
    left: spacing.xl,
    color: 'transparent',
    fontSize: 1,
  },
  cameraCopy: {
    position: 'absolute',
    top: 64,
    left: 0,
    right: 0,
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: spacing.lg,
  },
  cameraHeadline: { color: colors.text.primary.hex, textAlign: 'center' },
  cameraHelper: { color: colors.text.secondary.hex, textAlign: 'center' },
  filterTint: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  processingOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 24,
    alignItems: 'center',
    backgroundColor: 'rgba(10,12,8,0.55)',
    paddingVertical: 10,
  },
  filterBar: {
    backgroundColor: colors.background.surface.hex,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.08)',
    paddingTop: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  filterRow: { gap: spacing.sm, paddingBottom: spacing.xs },
  filterHelper: {
    color: colors.text.muted.hex,
    textAlign: 'center',
    marginTop: spacing.xs,
    paddingBottom: spacing.xs,
  },
  bottomBar: {
    backgroundColor: colors.background.surface.hex,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.08)',
    paddingTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.md,
  },
  shutterRow: { alignItems: 'center' },
  shutter: {
    width: 68,
    height: 68,
    borderRadius: 34,
    borderWidth: 3,
    borderColor: colors.text.primary.hex,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  shutterInner: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: '#fff',
  },
  chip: {
    height: 36,
    borderRadius: 18,
    paddingHorizontal: spacing.md + spacing.sm,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    backgroundColor: colors.background.raised.hex,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipSelected: {
    backgroundColor: colors.brand.primary.hex,
    borderColor: colors.brand.primary.hex,
  },
  flipOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 20,
    backgroundColor: 'rgba(10,12,8,0.82)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  flipCopy: { alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.xxxl },
  flipHeadline: { color: colors.text.primary.hex, textAlign: 'center' },
  flipHelper: { color: colors.text.muted.hex, textAlign: 'center' },

  // ---- Review (§2.3 review / §2.5 caption) ----
  reviewHeadline: { color: colors.text.primary.hex, textAlign: 'center' },
  reviewShots: { flexDirection: 'row', gap: spacing.md },
  reviewShotWrap: {
    flex: 1,
    aspectRatio: 4 / 3,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.background.raised.hex,
  },
  reviewShot: { width: '100%', height: '100%' },
  reviewShotLabel: {
    position: 'absolute',
    left: 6,
    bottom: 5,
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: 'rgba(255,255,255,0.92)',
    textShadowColor: 'rgba(0,0,0,0.75)',
    textShadowRadius: 3,
    textShadowOffset: { width: 0, height: 1 },
  },
  honestyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  honestyText: { color: colors.text.muted.hex, textAlign: 'center' },
  ringTruth: { color: colors.text.secondary.hex, textAlign: 'center', paddingHorizontal: spacing.sm },
  captionInput: {
    backgroundColor: colors.background.raised.hex,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    color: colors.text.primary.hex,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: 16,
    lineHeight: 22,
  },

  // ---- Review-thumb full-screen preview (a11y `View photo`) ----
  previewModal: {
    flex: 1,
    backgroundColor: 'rgba(10,12,8,0.96)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewModalImg: { width: '100%', height: '100%' },
  previewModalClose: {
    position: 'absolute',
    top: 48,
    right: spacing.lg,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(19,22,16,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});