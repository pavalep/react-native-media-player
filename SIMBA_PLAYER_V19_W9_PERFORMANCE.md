# V19 — W9 Playback Performance & Event Pipeline (lib side)

> Wave: **W9** · Released in: **`1.10.0`** · Date: **2026-10-06**
> App-side companion doc: `MOBILE_APP_REACT_NATIVE/md/SIMBA_PLAYER_V19_W9_PERFORMANCE.md`

This file records the changes made **inside this library**. The full analysis,
citations and device-verification backlog live in the app-side companion.

---

## What changed

### 1. `android/src/main/cpp/event.cpp` — hot-path logging gated

`__android_log_print(DEBUG, …)` ran for **every** property change and every
mpv log line. `time-pos` changes once per video frame, so that was 30–60
synchronous logd writes per second on the hottest thread in the app.

Now behind `SIMBA_MPV_TRACE` (**off by default**, compile-time on purpose):

```cpp
#ifdef SIMBA_MPV_TRACE
#define TRACE_PROPERTY(...) __android_log_print(ANDROID_LOG_DEBUG, "MpvProperty", __VA_ARGS__)
#define TRACE_MPVLOG(...)   __android_log_print(ANDROID_LOG_DEBUG, "mpv", __VA_ARGS__)
#else
#define TRACE_PROPERTY(...) do { } while (0)
#define TRACE_MPVLOG(...)   do { } while (0)
#endif
```

Build with `-DSIMBA_MPV_TRACE` to restore full property/event visibility while
debugging. The visible-log intent from the `mute`/`seekable`/`media-title`
investigations is preserved — it is just no longer paid for in release.

### 2. `android/src/main/cpp/event.cpp` — high-frequency properties coalesced

`shouldForwardProperty()` rate-limits, **before serialization and before the
JNI crossing**:

| Property | Window | Rate | Why |
|---|---|---|---|
| `time-pos` | 250 ms | 4 Hz | mpv emits it once per frame; no UI samples faster than this |
| `demuxer-cache-state` | 500 ms | 2 Hz | a node map with a `seekable-ranges` array — the biggest payload in the loop |

This is a **rate limit, not a filter**: the newest value always wins and is
always delivered. A dropped frame costs one `strcmp` instead of a full
string build + 2 JNI refs + a JNI call + a `WritableMap` + a bridge hop.

Not applied to properties whose value *is* the signal (`pause`,
`eof-reached`, `seekable`, `mute`, `speed`, `loop-mode`, `media-title`,
`chapter`, track list) — dropping one of those is a lost event, not a
duplicate frame.

> Tunable: `kPositionCoalesceUs` / `kCacheCoalesceUs` near the top of the
> coalescing block.

### 3. `MpvBridgeModule.kt` — per-event logging gated, duplicate emission dropped

- `Log.i` with the full JSON payload on **every** property change → gated
  behind `private const val TRACE_PROPERTY_EVENTS = false`. A `const val`
  (not a system property or `Log.isLoggable`) so R8 can inline the branch
  away entirely.
- `onPropertyChanged` is no longer emitted for properties that already have a
  dedicated typed event (`time-pos`, `duration`, `volume`, `speed`, `pause`,
  `idle-active`, `eof-reached`, `seekable`, `seeking`,
  `cache-buffering-state`, `paused-for-cache`, `demuxer-cache-state`).
  Previously `time-pos` crossed the bridge **twice** per frame and the JS
  reducer ran twice. The generic event is still emitted for everything else,
  so the JS `onPropertyChanged` contract is unchanged for its actual readers.

### 4. `PlayerProvider.tsx` — 1 Hz position poll removed

`setInterval` calling the **synchronous** `getPosition()` / `getDuration()`
getters is gone. Position and duration are observed properties that change
continuously, so the event stream always repopulates them; the poll was a
second writer to the same fields and blocked the JS thread twice a second
(RN guidance: sync methods are for sub-5 ms work, never a recurring timer).

The mount-time `seekable` and `mute` **level seeds are kept** — mpv emits
those as edges, so an event-only provider mounted mid-session would never
learn them.

### 5. `PlayerProvider.tsx` — the no-op guard now works

```ts
if (!playerStateEqual(nextState, stateRef.current)) { setState(nextState) }
```

The old `nextState !== stateRef.current` compared a freshly-spread object
against itself and was therefore always true. `playerStateEqual()` compares
fields, with the key list **derived from `DEFAULT_STATE` at runtime** so a
newly added `PlayerState` field cannot be silently forgotten.

---

## Compatibility

No public API changed. No event name changed. `onPropertyChanged` still fires
for every property that does not have a dedicated event — including
`media-title`, `metadata`, `mute`, `loop-file`, `loop-playlist`, `playlist`,
`playlist-playing-pos`, `playlist-shuffle` and `shuffle`.

**Behavioural change to be aware of:** `time-pos` and `demuxer-cache-state`
now arrive coalesced. If a consumer ever needs per-frame position, that is
the wrong layer to get it from — read the clock locally and interpolate, which
is what every reference player does.

---

## Verification

- `tsc --noEmit` clean.
- **11 suites / 183 tests green** (177 pre-existing + 6 new in
  `src/components/__tests__/PlayerProvider.performance.test.tsx`).
- Mutation-checked: reverting the `playerStateEqual` guard makes the
  render-count test fail.

> Note: the lib has **no eslint config** — `npx eslint` fetches v10 and fails.
> That is expected, not a regression.

---

## Carried forward

- **Device verification of 1.10.0 requires a native rebuild** (C++ and Kotlin
  both changed). A JS-only Metro reload cannot exercise the coalescing or the
  logging gate — the former is invisible to JS entirely.
- Rebuild will be ~10+ minutes; `gradlew.bat assembleDebug` buffers all output.