/**
 * LogSheet — the dual-capture logging flow (v1.0, onboarding-copy-addendum
 * 2026-09-11 §2: "two live shots, one caption"). Camera permission is
 * requested ONLY here — on the first camera tap — never during onboarding
 * (README). No gallery import, ever (product integrity: photo proof must be
 * live; both shots carry the LIVE meaning).
 *
 * Flow: SHOT 1 front selfie (live preview filter row: None/Warm/Bright/Soft —
 * the grade is BAKED at capture on-device, no preset id uploaded) → ~1.2s flip
 * cue ("Nice. Now your surroundings." / bystander tip) → SHOT 2 back
 * environment (ALWAYS unfiltered) → REVIEW (two 4:3 thumbs, caption, type,
 * one Retake that redoes both shots) → Log it → done ("Added to your week" /
 * "Shared with {name}").
 *
 * Data flow: capture → bake (only when a filter is selected) → review →
 * logWorkout() (REAL upload to private Storage under `${user_id}/` for BOTH
 * shots, or DEV local files) → onLogged(log) → Home optimistically prepends
 * the card and refreshes the weekly context. Nothing here builds a URL; the
 * display URIs come back from the store.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions, type CameraCapturedPicture } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { StyleProp, ViewStyle } from 'react-native';

// RN 0.86 strict-api typing drops `style` (and some other ViewProps) from
// expo-camera's CameraView JSX props even though CameraViewProps extends
// ViewProps. This local passthrough keeps the typed props (style + facing)
// usable with zero runtime behavior change — the alias casts the component
// (not the styles) and is scoped to this file.
type CameraViewProps_ = {
  ref?: React.Ref<CameraView>;
  style: StyleProp<ViewStyle>;
  facing: 'front' | 'back';
  onMountError?: () => void;
};
const CameraViewT = CameraView as unknown as React.ComponentType<CameraViewProps_>;

import { AppButton } from '@/components/AppButton';
import { colors, motion, radius, spacing } from '@/theme/tokens';
import { textStyles } from '@/theme/typography';
import { logWorkout, type NewWorkout } from '@/lib/workoutStore';
import { bakeSelfieFiltered } from '@/lib/selfieBake';
import {
  SELFIE_FILTER_HELPER,
  SELFIE_FILTER_IDS,
  SELFIE_FILTER_PRESETS,
  filterA11yLabel,
  type SelfieFilter,
} from '@/lib/filters';
import { WORKOUT_TYPES, type WorkoutType, type WorkoutLog } from '@/lib/workouts';

type Stage = 'shot1' | 'flip' | 'shot2' | 'review' | 'saving' | 'done';
/** Capture feedback: `Snapping…` (capture) → `Filtering…` (bake, shot 1 only). */
type Processing = null | 'snapping' | 'filtering';
/** Review thumb full-screen preview (a11y `View photo` per thumb). */
type PreviewShot = null | 'selfie' | 'env';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** First co-member's display name (undefined while solo) — drives the
   * done-state "Shared with {name}" confirmation line. */
  partnerName?: string;
  /** Called with the logged workout — Home prepends it optimistically. */
  onLogged: (log: WorkoutLog) => void;
}

/** Flip-cue overlay duration — the ~1.2s "Nice. Now your surroundings." beat. */
const FLIP_CUE_MS = 1200;
/** Product caption cap (mirrors the schema check constraint). */
export const CAPTION_MAX = 140;

export function LogSheet({ visible, onClose, onLogged, partnerName }: Props) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();

  const [stage, setStage] = useState<Stage>('shot1');
  const [selfie, setSelfie] = useState<CameraCapturedPicture | null>(null);
  const [env, setEnv] = useState<CameraCapturedPicture | null>(null);
  const [filter, setFilter] = useState<SelfieFilter>('none');
  const [caption, setCaption] = useState('');
  const [workoutType, setWorkoutType] = useState<WorkoutType | null>(null);
  const [processing, setProcessing] = useState<Processing>(null);
  const [preview, setPreview] = useState<PreviewShot>(null);
  const [error, setError] = useState<string | null>(null);
  const cameraRef = useRef<CameraView>(null);
  const [facing, setFacing] = useState<'front' | 'back'>('front');
  const busy = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = stage === 'saving';
  const filterPreset = SELFIE_FILTER_PRESETS[filter];

  // Reset on open (permission stays OS-level; only the sheet state resets).
  useEffect(() => {
    if (!visible) return;
    setStage('shot1');
    setSelfie(null);
    setEnv(null);
    setFilter('none');
    setCaption('');
    setWorkoutType(null);
    setFacing('front');
    setProcessing(null);
    setPreview(null);
    setError(null);
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
      if (flipTimer.current) clearTimeout(flipTimer.current);
    };
  }, [visible]);

  const close = useCallback(() => {
    if (busy.current) return;
    onClose();
  }, [onClose]);

  const takePhoto = useCallback(async () => {
    if (busy.current) return;
    if (stage !== 'shot1' && stage !== 'shot2') return;
    busy.current = true;
    setError(null);
    try {
      // Permission requested FIRST on this tap (not during onboarding).
      if (!permission?.granted) {
        const res = await requestPermission();
        if (!res.granted) {
          setError('Camera access is off. Allow it in Settings to log with photo proof.');
          busy.current = false;
          return;
        }
      }
      setProcessing('snapping');
      const photo = await cameraRef.current?.takePictureAsync({ quality: 0.6 });
      if (!photo) {
        setProcessing(null);
        setError('Couldn\u2019t capture. Try again.');
        return;
      }

      if (stage === 'shot1') {
        // Selfie: bake the selected tonal grade at capture (on-device; the
        // graded JPEG is exactly what gets logged — no preset id, no
        // post-processing claim).
        let finalUri = photo.uri;
        if (filter !== 'none') {
          setProcessing('filtering');
          const baked = await bakeSelfieFiltered(photo.uri, filter);
          if (!baked.ok) {
            setProcessing(null);
            setError(baked.error);
            return;
          }
          finalUri = baked.uri;
        }
        setSelfie({ ...photo, uri: finalUri });
        setProcessing(null);
        // Flip cue — auto-flips to the back lens, no tap needed.
        setStage('flip');
        flipTimer.current = setTimeout(() => {
          setFacing('back');
          setStage('shot2');
        }, FLIP_CUE_MS);
      } else {
        // Environment shot — always UNFILTERED (strongest proof, zero edits).
        setEnv(photo);
        setProcessing(null);
        setStage('review');
      }
    } catch {
      setProcessing(null);
      setError('Couldn\u2019t open the camera. Try again.');
    } finally {
      busy.current = false;
    }
  }, [permission?.granted, requestPermission, stage, filter]);

  const retake = useCallback(() => {
    if (busy.current) return;
    if (flipTimer.current) clearTimeout(flipTimer.current);
    setSelfie(null);
    setEnv(null);
    setStage('shot1');
    setFacing('front');
    setError(null);
    // Caption + workout type PRESERVED (spec); the chosen filter is kept too
    // so a retaken selfie keeps its look.
  }, []);

  const logIt = useCallback(async () => {
    // Double-tap guard: busy.current + the `saving` stage both gate this path.
    if (busy.current || !selfie || !env) return;
    busy.current = true;
    setStage('saving');
    setError(null);
    const input: NewWorkout = {
      photoUri: selfie.uri,
      photoEnvUri: env.uri,
      caption: caption.trim() ? caption.trim().slice(0, CAPTION_MAX) : null,
      workoutType: workoutType ?? null,
    };
    const res = await logWorkout(input);
    busy.current = false;

    if (!res.ok || !res.log) {
      setError(res.error ?? 'Couldn\u2019t log. Try again.');
      setStage('review');
      return;
    }
    onLogged(res.log);
    // Brief confirmation before closing ("Added to your week" / "Shared with X").
    setStage('done');
    closeTimer.current = setTimeout(() => {
      setStage('shot1');
      onClose();
    }, motion.confirmMs);
  }, [selfie, env, caption, workoutType, onLogged, onClose]);

  const isFirstRun = !permission?.granted;
  const isCaptureStage = stage === 'shot1' || stage === 'shot2' || stage === 'flip';
  const shotNumLabel = stage === 'shot2' ? 'SHOT 2 OF 2' : 'SHOT 1 OF 2';
  const shotAnnouncement = stage === 'shot2' ? 'Shot 2 of 2 — back camera' : 'Shot 1 of 2 — front camera';

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={close}>
      <View style={styles.screen}>
        {isCaptureStage && (
          <>
            <View style={styles.cameraWrap}>
              {permission?.granted ? (
                <CameraViewT
                  ref={cameraRef}
                  style={styles.camera as StyleProp<ViewStyle>}
                  facing={facing}
                  onMountError={() => setError('Couldn\u2019t open the camera. Try again.')}
                />
              ) : (
                <View style={styles.cameraFallback}>
                  {/* Camera surface — stays dark in the light theme; text stays light. */}
                  <Ionicons name="camera-outline" size={44} color="rgba(255,255,255,0.70)" />
                  <Text style={[textStyles.caption.style, { color: 'rgba(255,255,255,0.92)', textAlign: 'center' }]}>
                    {isFirstRun
                      ? 'We\u2019ll ask for camera access when you tap the shutter.'
                      : 'Camera access is off.'}
                  </Text>
                  {!isFirstRun && (
                    <Text style={[textStyles.label.style, { color: 'rgba(255,255,255,0.70)', textAlign: 'center' }]}>
                      Allow it in Settings to log with photo proof.
                    </Text>
                  )}
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
                    : 'Your group sees your face with every log — proof it\u2019s you.'}
                </Text>
              </View>

              {/* Live filter grade (approximation of the baked result) — selfie only. */}
              {stage === 'shot1' && filter !== 'none' && filterPreset.previewTint && (
                <View pointerEvents="none" style={[styles.filterTint, { backgroundColor: filterPreset.previewTint }]} />
              )}

              {/* Capture feedback: Snapping… / Filtering… */}
              {processing && (
                <View style={styles.processingOverlay} pointerEvents="none">
                  {/* Over the live camera — stays light in the light theme. */}
                  <Text style={[textStyles.label.style, { color: '#FFFFFF' }]}>
                    {processing === 'filtering' ? 'Filtering…' : 'Snapping…'}
                  </Text>
                </View>
              )}
            </View>

            {/* Filter chip row — selfie stage only, under the preview, above the bar. */}
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

            <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
              <Text style={[textStyles.caption.style, { color: colors.text.secondary.hex, textAlign: 'center' }]}>
                Only your group will see this.
              </Text>
              <View style={styles.previewRow}>
                {/* Placeholder keeps the shutter centered — flip button is HIDDEN
                    on both stages (front forced on 1, back forced on 2). */}
                <View style={styles.flipBtn} />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Take photo"
                  onPress={takePhoto}
                  style={({ pressed }) => [styles.shutter, pressed && { opacity: 0.8 }]}
                >
                  <View style={styles.shutterInner} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Cancel"
                  onPress={close}
                  hitSlop={10}
                  style={styles.cancelBtn}
                >
                  <Text style={[textStyles.captionStrong.style, { color: colors.text.primary.hex }]}>Cancel</Text>
                </Pressable>
              </View>
              {error && (
                <Text style={[textStyles.caption.style, { color: colors.text.danger.hex, textAlign: 'center' }]}>
                  {error}
                </Text>
              )}
            </View>
          </>
        )}

        {stage === 'review' && selfie && env && (
          <>
            <View style={styles.reviewShotsWrap}>
              <View style={styles.chromeTopReview} pointerEvents="none">
                <Text style={[textStyles.label.style, styles.chromeLabel]}>REVIEW</Text>
              </View>
              <View style={styles.reviewCopy} pointerEvents="none">
                <Text style={[textStyles.bodyStrong.style, styles.cameraHeadline]}>Looks like a workout.</Text>
              </View>
              <View style={styles.reviewShots}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="View photo"
                  onPress={() => setPreview('selfie')}
                  style={styles.reviewShotWrap}
                >
                  <Image source={{ uri: selfie.uri }} style={styles.reviewShot} contentFit="cover" />
                  <Text style={styles.reviewShotLabel}>YOU</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="View photo"
                  onPress={() => setPreview('env')}
                  style={styles.reviewShotWrap}
                >
                  <Image source={{ uri: env.uri }} style={styles.reviewShot} contentFit="cover" />
                  <Text style={styles.reviewShotLabel}>YOUR SPOT</Text>
                </Pressable>
              </View>
            </View>

            <ScrollView
              style={styles.reviewBar}
              contentContainerStyle={[styles.reviewBarInner, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}
              keyboardShouldPersistTaps="handled"
            >
              <Text style={[textStyles.label.style, { color: colors.text.muted.hex }]}>CAPTION (OPTIONAL)</Text>
              <TextInput
                accessibilityLabel="Caption"
                value={caption}
                onChangeText={setCaption}
                placeholder="How\u2019d it go?"
                placeholderTextColor={colors.text.muted.hex}
                maxLength={CAPTION_MAX}
                style={styles.captionInput}
                autoCapitalize="sentences"
                returnKeyType="done"
              />
              <Text style={[textStyles.label.style, { color: colors.text.muted.hex, marginTop: spacing.sm }]}>
                TYPE (OPTIONAL)
              </Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                {WORKOUT_TYPES.map((t) => {
                  const selected = workoutType === t;
                  return (
                    <Pressable
                      key={t}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      onPress={() => setWorkoutType((prev) => (prev === t ? null : t))}
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
                        {t}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
              <AppButton
                label="Log it"
                onPress={logIt}
                disabled={saving}
                loading={saving}
                accessibilityLabel="Log workout"
              />
              {error && (
                <Text style={[textStyles.caption.style, { color: colors.text.danger.hex, textAlign: 'center' }]}>
                  {error}
                </Text>
              )}
              <Pressable accessibilityRole="button" accessibilityLabel="Retake photos" onPress={retake} hitSlop={8}>
                <Text style={[textStyles.captionStrong.style, { color: colors.text.secondary.hex, textAlign: 'center' }]}>
                  Retake
                </Text>
              </Pressable>
            </ScrollView>
          </>
        )}

        {stage === 'saving' && (
          <View style={styles.savingWrap}>
            <ActivityIndicator size="large" color={colors.brand.primary.hex} />
          </View>
        )}

        {stage === 'done' && (
          <View style={styles.doneWrap}>
            <Ionicons name="checkmark-circle" size={64} color={colors.status.success.hex} />
            <Text style={[textStyles.bodyStrong.style, { color: colors.text.primary.hex, textAlign: 'center' }]}>
              Added to your week
            </Text>
            {partnerName ? (
              <Text style={[textStyles.caption.style, { color: colors.text.secondary.hex, textAlign: 'center' }]}>
                Shared with {partnerName}
              </Text>
            ) : null}
          </View>
        )}

        {/* Flip cue (~1.2s, no tap needed; pointerEvents none keeps the bar live). */}
        {stage === 'flip' && (
          <View style={styles.flipOverlay} pointerEvents="none">
            <View style={styles.flipCopy}>
              <Text style={[textStyles.bodyStrong.style, styles.flipHeadline]}>Nice. Now your surroundings.</Text>
              <Text style={[textStyles.caption.style, styles.flipHelper]}>Keep people out of frame.</Text>
            </View>
          </View>
        )}

        {/* Review-thumb full-screen preview (a11y `View photo`). */}
        <Modal visible={preview !== null} transparent animationType="fade" onRequestClose={() => setPreview(null)}>
          <View style={styles.previewModal}>
            {preview === 'selfie' && selfie && (
              <Image source={{ uri: selfie.uri }} style={styles.previewModalImg} contentFit="contain" />
            )}
            {preview === 'env' && env && (
              <Image source={{ uri: env.uri }} style={styles.previewModalImg} contentFit="contain" />
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close photo"
              onPress={() => setPreview(null)}
              style={styles.previewModalClose}
            >
              <Ionicons name="close" size={22} color="#FFFFFF" />
            </Pressable>
          </View>
        </Modal>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background.base.hex },
  cameraWrap: { flex: 1, backgroundColor: '#000' },
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
  chromeLabel: {
    // Over the live camera / black review strip — stays light in the light theme.
    color: 'rgba(255,255,255,0.92)',
    textAlign: 'center',
  },
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
  cameraHeadline: { color: '#FFFFFF', textAlign: 'center' },
  cameraHelper: { color: 'rgba(255,255,255,0.92)', textAlign: 'center' },
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
    borderTopColor: 'rgba(0,0,0,0.08)',
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
    borderTopColor: 'rgba(0,0,0,0.08)',
    paddingTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  flipBtn: {
    width: 64,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
  cancelBtn: { alignItems: 'center', justifyContent: 'center', width: 64 },
  reviewShotsWrap: { flex: 1, backgroundColor: '#000', justifyContent: 'center' },
  chromeTopReview: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
  },
  reviewCopy: {
    position: 'absolute',
    top: 52,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  reviewShots: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
  },
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
  reviewBar: { maxHeight: '52%', backgroundColor: colors.background.surface.hex },
  reviewBarInner: {
    paddingTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    gap: 8,
  },
  captionInput: {
    backgroundColor: colors.background.raised.hex,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.12)',
    color: colors.text.primary.hex,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: 16,
    lineHeight: 22,
  },
  chipRow: { gap: spacing.sm, paddingVertical: spacing.xs },
  chip: {
    height: 36,
    borderRadius: 18,
    paddingHorizontal: spacing.md + spacing.sm,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.12)',
    backgroundColor: colors.background.raised.hex,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipSelected: {
    backgroundColor: colors.brand.primary.hex,
    borderColor: colors.brand.primary.hex,
  },
  savingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background.base.hex,
  },
  doneWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xxxl,
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
  flipHeadline: { color: '#FFFFFF', textAlign: 'center' },
  flipHelper: { color: 'rgba(255,255,255,0.92)', textAlign: 'center' },
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

export type { WorkoutType, NewWorkout };