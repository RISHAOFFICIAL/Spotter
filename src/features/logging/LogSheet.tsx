/**
 * LogSheet — the two-tap logging flow (home-screen.md §5).
 *
 * Round 1: live-camera capture (expo-camera). Camera permission is requested
 * ONLY here — on the first camera tap — never during onboarding (README).
 * No gallery import, ever (product integrity: photo proof must be live).
 *
 * Round 2: optional workout-type chips (Run/Lift/Cycle/Yoga/Other per tokens
 * chips) + "Log it". Logging target: under 10 seconds from camera tap.
 *
 * Data flow: capture → logWorkout() (REAL upload to private Storage under
 * `${user_id}/`, or DEV local file) → onLogged(log) → Home optimistically
 * prepends the card and refreshes the weekly context. Nothing here builds a
 * URL; the display URI comes back from the store.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
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
import { colors, radius, spacing } from '@/theme/tokens';
import { textStyles } from '@/theme/typography';
import { logWorkout, type NewWorkout } from '@/lib/workoutStore';
import { WORKOUT_TYPES, type WorkoutType, type WorkoutLog } from '@/lib/workouts';

type Stage = 'camera' | 'confirm' | 'saving' | 'done';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Accepted partner's first name (null while solo) — drives the privacy line. */
  partnerName?: string;
  /** Called with the logged workout — Home prepends it optimistically. */
  onLogged: (log: WorkoutLog) => void;
}

export function LogSheet({ visible, onClose, onLogged, partnerName }: Props) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();

  const [stage, setStage] = useState<Stage>('camera');
  const [captured, setCaptured] = useState<CameraCapturedPicture | null>(null);
  const [workoutType, setWorkoutType] = useState<WorkoutType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cameraRef = useRef<CameraView>(null);
  const busy = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = stage === 'saving';

  // Reset on open (permission stays OS-level; only the sheet state resets).
  useEffect(() => {
    if (!visible) return;
    setStage('camera');
    setCaptured(null);
    setWorkoutType(null);
    setError(null);
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, [visible]);

  const close = useCallback(() => {
    if (busy.current) return;
    onClose();
  }, [onClose]);

  const takePhoto = useCallback(async () => {
    if (busy.current) return;
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
      const photo = await cameraRef.current?.takePictureAsync({ quality: 0.6 });
      if (!photo) {
        setError('Couldn\u2019t capture. Try again.');
        return;
      }
      setCaptured(photo);
      setStage('confirm');
    } catch {
      setError('Couldn\u2019t open the camera. Try again.');
    } finally {
      busy.current = false;
    }
  }, [permission?.granted, requestPermission]);

  const logIt = useCallback(async () => {
    // Double-tap guard: busy.current + the `saving` stage both gate this path.
    if (busy.current || !captured) return;
    busy.current = true;
    setStage('saving');
    setError(null);
    const input: NewWorkout = { photoUri: captured.uri, workoutType: workoutType ?? null };
    const res = await logWorkout(input);
    busy.current = false;

    if (!res.ok || !res.log) {
      setError(res.error ?? 'Couldn\u2019t log. Try again.');
      setStage('confirm');
      return;
    }
    onLogged(res.log);
    // Brief confirmation before closing ("Added to your week" / "Shared with X").
    setStage('done');
    closeTimer.current = setTimeout(() => {
      setStage('camera');
      onClose();
    }, 1400);
  }, [captured, workoutType, onLogged, onClose]);

  const isFirstRun = !permission?.granted;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={close}>
      <View style={styles.screen}>
        {stage === 'camera' && (
          <>
            <View style={styles.cameraWrap}>
              {permission?.granted ? (
                <CameraViewT
                  ref={cameraRef}
                  style={styles.camera as StyleProp<ViewStyle>}
                  facing="back"
                  onMountError={() => setError('Couldn\u2019t open the camera. Try again.')}
                />
              ) : (
                <View style={styles.cameraFallback}>
                  <Ionicons name="camera-outline" size={44} color={colors.text.muted.hex} />
                  <Text style={[textStyles.caption.style, { color: colors.text.secondary.hex, textAlign: 'center' }]}>
                    {isFirstRun
                      ? 'We\u2019ll ask for camera access when you tap the shutter.'
                      : 'Camera access is off.'}
                  </Text>
                  {!isFirstRun && (
                    <Text style={[textStyles.label.style, { color: colors.text.muted.hex, textAlign: 'center' }]}>
                      Allow it in Settings to log with photo proof.
                    </Text>
                  )}
                </View>
              )}
            </View>

            <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
              <View style={styles.privacyLine}>
                <Text style={[textStyles.caption.style, { color: colors.text.secondary.hex, textAlign: 'center' }]}>
                  {partnerName ? `Only ${partnerName} will see this.` : 'Only your partner will see this.'}
                </Text>
                <Text style={[textStyles.label.style, { color: colors.text.muted.hex, textAlign: 'center', marginTop: spacing.xs }]}>
                  Your photos are sealed to your account — only you and your partner can ever see them.
                </Text>
              </View>
              <View style={styles.previewRow}>
                <View style={{ width: 64 }} />
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

        {stage === 'confirm' && captured && (
          <>
            <View style={styles.previewWrap}>
              <Image source={{ uri: captured.uri }} style={styles.preview} contentFit="cover" />
            </View>

            <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
              <Text style={[textStyles.label.style, { color: colors.text.muted.hex, textAlign: 'center' }]}>
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
              <Pressable accessibilityRole="button" accessibilityLabel="Retake photo" onPress={() => setStage('camera')} hitSlop={8}>
                <Text style={[textStyles.captionStrong.style, { color: colors.text.secondary.hex, textAlign: 'center' }]}>
                  Retake
                </Text>
              </Pressable>
            </View>
          </>
        )}
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
  bottomBar: {
    backgroundColor: colors.background.surface.hex,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.08)',
    paddingTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  privacyLine: { alignItems: 'center', gap: 0 },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
  previewWrap: { flex: 1, backgroundColor: '#000' },
  preview: { flex: 1 },
  doneWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xxxl,
  },
  chipRow: { gap: spacing.sm, paddingVertical: spacing.xs },
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
});

export type { WorkoutType, NewWorkout };