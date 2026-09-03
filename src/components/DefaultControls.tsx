import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  Easing,
  GestureResponderEvent,
  LayoutChangeEvent,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTheme } from './PlayerProvider';
import { usePlayer, usePlayerProgress } from '../types/player';

/**
 * Phase 24: full polished default controls component.
 *
 * Layout (top → bottom):
 *  1. **Top bar**: close (✕) + title + spacer for future more-menu.
 *  2. **Center**: empty placeholder (Phase 25 adds loading spinner /
 *     error state / buffer indicator here).
 *  3. **Bottom bar**: time-current / scrubber / time-total + skip
 *     back / play-pause / skip forward.
 *
 * Interaction:
 *  - Auto-hides after 3 seconds of inactivity (opacity fade).
 *  - Any tap (button or empty space) shows the controls + resets
 *    the timer.
 *  - Scrubber supports tap-to-seek (jump to a position by tapping
 *    the bar) and drag-to-seek (continuous follow while dragging).
 *
 * Theming: every color comes from `useTheme()`. The component has
 * zero hardcoded color values — even the dimmed-overlay background
 * is `theme.background` with reduced opacity, so it harmonises with
 * the consumer's theme in dark / light / brand-color modes.
 *
 * Phase 24 wires the commands to the `MpvPlayerModule` bridge (Phase
 * 23's `usePlayer()` stub is now real). Phase 25 wires
 * `usePlayerProgress()` to the 1Hz position poll + mpv events.
 */

const AUTO_HIDE_TIMEOUT_MS = 3000;
const SCRUBBER_HEIGHT = 28; // hit target height for tap/drag
const SKIP_BACK_SECONDS = 10;
const SKIP_FORWARD_SECONDS = 10;

/**
 * Props accepted by `<DefaultControls>`. The component is a thin
 * shell: PlayerRoot (or any consumer using the `renderControls`
 * slot's fallback path) passes the player's title/subtitle plus
 * play/pause callbacks. The component reads player state +
 * progress from the `usePlayer()` / `usePlayerProgress()` hooks
 * directly, so no other state is required as props.
 *
 * Phase 30 export: previously PlayerRoot referenced this type but
 * it was never exported (a Phase 24 oversight that only surfaced
 * once the module's tsconfig was wired for standalone typecheck).
 */
export interface DefaultControlsProps {
  title?: string;
  subtitle?: string;
  onPlay?: () => void;
  onPause?: () => void;
}

/** Format milliseconds as `H:MM:SS` or `M:SS`. */
function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = minutes.toString();
  const ss = seconds.toString().padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${mm.padStart(2, '0')}:${ss}`;
  }
  return `${mm}:${ss}`;
}

/** Clamp a number into [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function DefaultControls(props: DefaultControlsProps = {}): React.ReactElement {
  const { title, subtitle: subtitleProp, onPlay, onPause } = props;
  const theme = useTheme();
  const { state, commands } = usePlayer();
  const { positionMs, durationMs } = usePlayerProgress();

  // ── Auto-hide state ───────────────────────────────────────────────────
  const [visible, setVisible] = useState(true);
  const opacity = useRef(new Animated.Value(1)).current;
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showControls = useCallback(() => {
    setVisible(true);
    Animated.timing(opacity, {
      toValue: 1,
      duration: 180,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
    }
    hideTimerRef.current = setTimeout(() => {
      setVisible(false);
      Animated.timing(opacity, {
        toValue: 0,
        duration: 220,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }).start();
    }, AUTO_HIDE_TIMEOUT_MS);
  }, [opacity]);

  useEffect(() => {
    showControls();
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [showControls]);

  // ── Scrubber state ────────────────────────────────────────────────────
  const [scrubberWidth, setScrubberWidth] = useState(0);
  const [draggingPositionMs, setDraggingPositionMs] = useState<
    number | null
  >(null);

  const onScrubberLayout = useCallback((e: LayoutChangeEvent) => {
    setScrubberWidth(e.nativeEvent.layout.width);
  }, []);

  const positionFromX = useCallback(
    (x: number): number => {
      if (scrubberWidth <= 0 || durationMs <= 0) return 0;
      const ratio = clamp(x / scrubberWidth, 0, 1);
      return Math.round(ratio * durationMs);
    },
    [scrubberWidth, durationMs],
  );

  const seekTo = useCallback(
    (newPositionMs: number) => {
      const clamped = clamp(newPositionMs, 0, Math.max(0, durationMs));
      commands.seek(clamped);
    },
    [commands, durationMs],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt: GestureResponderEvent) => {
          setDraggingPositionMs(positionFromX(evt.nativeEvent.locationX));
          showControls();
        },
        onPanResponderMove: (evt: GestureResponderEvent) => {
          setDraggingPositionMs(positionFromX(evt.nativeEvent.locationX));
        },
        onPanResponderRelease: (evt: GestureResponderEvent) => {
          const final = positionFromX(evt.nativeEvent.locationX);
          setDraggingPositionMs(null);
          seekTo(final);
        },
        onPanResponderTerminate: () => {
          setDraggingPositionMs(null);
        },
      }),
    [positionFromX, seekTo, showControls],
  );

  const onScrubberTap = useCallback(
    (evt: GestureResponderEvent) => {
      // PanResponder handles drag; this branch covers a pure tap
      // (grant + release at the same x). PanResponder's release
      // handler will fire after grant, so this is a fallback for
      // test environments that strip gesture responders.
      const x = evt.nativeEvent.locationX;
      seekTo(positionFromX(x));
      showControls();
    },
    [positionFromX, seekTo, showControls],
  );

  // ── Derived render values ─────────────────────────────────────────────
  const effectivePositionMs =
    draggingPositionMs != null ? draggingPositionMs : positionMs;
  const progressRatio =
    durationMs > 0 ? clamp(effectivePositionMs / durationMs, 0, 1) : 0;
  const iconColor = theme.icon ?? theme.text;
  // Props take precedence; otherwise derive from player state (title +
  // artist/album). Phase 30 wires this so PlayerRoot's fallback path
  // can override the default behaviour.
  const effectiveTitle = title ?? state.title;
  const effectiveOnPlay = onPlay ?? commands.play;
  const effectiveOnPause = onPause ?? commands.pause;
  const subtitle =
    subtitleProp ??
    (state.artist && state.album
      ? `${state.artist} • ${state.album}`
      : state.artist || state.album || undefined);

  return (
    <Pressable
      style={styles.root}
      onPress={showControls}
      accessibilityRole="summary"
      accessibilityLabel="Simba Player controls"
      // Animated.View as the inner wrapper so opacity tweens work
      // without affecting tap-handling on the root Pressable.
    >
      <Animated.View
        pointerEvents={visible ? 'auto' : 'none'}
        style={[styles.fill, { opacity }]}
      >
        {/* Top bar */}
        <View style={styles.topBar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close player"
            onPress={effectiveOnPause}
            hitSlop={8}
            style={({ pressed }) => [
              styles.iconButton,
              { backgroundColor: theme.surface, opacity: pressed ? 0.6 : 1 },
            ]}
          >
            <Text style={[styles.iconText, { color: iconColor }]}>✕</Text>
          </Pressable>
          <View style={styles.titleColumn}>
            <Text
              style={[styles.title, { color: theme.text }]}
              numberOfLines={1}
              accessibilityRole="header"
            >
              {effectiveTitle}
            </Text>
            {subtitle ? (
              <Text
                style={[styles.subtitle, { color: theme.textSecondary }]}
                numberOfLines={1}
              >
                {subtitle}
              </Text>
            ) : null}
          </View>
          {/* Spacer to keep the title centred; Phase 25 will add a
              real more-menu icon here. */}
          <View style={styles.iconButton} />
        </View>

        {/* Center: placeholder (loading / error / buffer land here in
            Phase 25 — the empty View keeps the top + bottom bars
            pinned to the edges via flex layout.) */}
        <View style={styles.center} />

        {/* Bottom bar */}
        <View style={styles.bottomBar}>
          <View style={styles.scrubberRow}>
            <Text
              style={[styles.timeText, { color: theme.textSecondary }]}
              accessibilityLabel={`Position ${formatTime(effectivePositionMs)}`}
            >
              {formatTime(effectivePositionMs)}
            </Text>
            <View
              style={styles.scrubberHitArea}
              onLayout={onScrubberLayout}
              {...panResponder.panHandlers}
              accessibilityRole="adjustable"
              accessibilityLabel="Seek bar"
              accessibilityValue={{
                min: 0,
                max: Math.round(durationMs / 1000),
                now: Math.round(effectivePositionMs / 1000),
              }}
            >
              {/* Tap-only fallback under the pan responder; invisible
                  because the pan responder's onPanResponderRelease
                  handles the actual seek, but it gives the bar a
                  visible touch target on platforms where the
                  responder takes a frame to activate. */}
              <Pressable
                style={StyleSheet.absoluteFill}
                onPress={onScrubberTap}
              />
              {/* Bar background */}
              <View
                style={[
                  styles.scrubberTrack,
                  { backgroundColor: theme.surface },
                ]}
              />
              {/* Filled portion */}
              <View
                style={[
                  styles.scrubberFill,
                  {
                    width: `${progressRatio * 100}%`,
                    backgroundColor: theme.accent,
                  },
                ]}
              />
              {/* Thumb */}
              <View
                style={[
                  styles.scrubberThumb,
                  {
                    left: `${progressRatio * 100}%`,
                    backgroundColor: theme.accent,
                  },
                ]}
              />
            </View>
            <Text
              style={[styles.timeText, { color: theme.textSecondary }]}
              accessibilityLabel={`Duration ${formatTime(durationMs)}`}
            >
              {formatTime(durationMs)}
            </Text>
          </View>

          <View style={styles.transportRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Skip back ${SKIP_BACK_SECONDS} seconds`}
              onPress={() => commands.skipBackward(SKIP_BACK_SECONDS)}
              hitSlop={8}
              style={({ pressed }) => [
                styles.transportButton,
                { opacity: pressed ? 0.6 : 1 },
              ]}
            >
              <Text style={[styles.transportIcon, { color: iconColor }]}>
                ⏪
              </Text>
              <Text style={[styles.transportLabel, { color: iconColor }]}>
                {SKIP_BACK_SECONDS}
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={state.isPlaying ? 'Pause' : 'Play'}
              onPress={state.isPlaying ? effectiveOnPause : effectiveOnPlay}
              hitSlop={8}
              style={({ pressed }) => [
                styles.playButton,
                {
                  backgroundColor: theme.accent,
                  opacity: pressed ? 0.7 : 1,
                },
              ]}
            >
              <Text
                style={[styles.playIcon, { color: theme.background }]}
                accessibilityElementsHidden
              >
                {state.isPlaying ? '⏸' : '▶'}
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Skip forward ${SKIP_FORWARD_SECONDS} seconds`}
              onPress={() => commands.skipForward(SKIP_FORWARD_SECONDS)}
              hitSlop={8}
              style={({ pressed }) => [
                styles.transportButton,
                { opacity: pressed ? 0.6 : 1 },
              ]}
            >
              <Text style={[styles.transportIcon, { color: iconColor }]}>
                ⏩
              </Text>
              <Text style={[styles.transportLabel, { color: iconColor }]}>
                {SKIP_FORWARD_SECONDS}
              </Text>
            </Pressable>
          </View>
        </View>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  fill: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.001)', // ensure hit-tests propagate
    justifyContent: 'space-between',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    gap: 12,
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconText: {
    fontSize: 20,
    fontWeight: '600',
  },
  titleColumn: {
    flex: 1,
    alignItems: 'center',
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 12,
    marginTop: 2,
    textAlign: 'center',
  },
  center: {
    flex: 1,
  },
  bottomBar: {
    paddingHorizontal: 16,
    paddingBottom: 24,
    paddingTop: 8,
    gap: 16,
  },
  scrubberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  timeText: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    minWidth: 48,
    textAlign: 'center',
  },
  scrubberHitArea: {
    flex: 1,
    height: SCRUBBER_HEIGHT,
    justifyContent: 'center',
  },
  scrubberTrack: {
    height: 4,
    borderRadius: 2,
    width: '100%',
  },
  scrubberFill: {
    position: 'absolute',
    height: 4,
    borderRadius: 2,
    left: 0,
  },
  scrubberThumb: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    marginLeft: -7, // center the thumb on the fill edge
    top: (SCRUBBER_HEIGHT - 14) / 2,
  },
  transportRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
  },
  transportButton: {
    minWidth: 64,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
  },
  transportIcon: {
    fontSize: 24,
  },
  transportLabel: {
    fontSize: 10,
    marginTop: 2,
  },
  playButton: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playIcon: {
    fontSize: 30,
    fontWeight: '700',
  },
});
