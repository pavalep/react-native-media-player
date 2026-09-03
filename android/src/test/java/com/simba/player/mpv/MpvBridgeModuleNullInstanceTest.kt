package com.simba.player.mpv

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/**
 * Pure-JUnit unit tests for [MpvBridgeModule]'s companion
 * `onPictureInPictureModeChanged` method that do NOT require the Android
 * runtime (no Robolectric, no Android dependencies).
 *
 * These tests focus on the null-instance cold-start race documented in
 * V12 spec §Phase 33.4 — the contract that the companion must return
 * silently when `instance` hasn't been initialised yet. The branch is
 * entirely pure Kotlin (no Context, no React, no Android APIs), so we
 * can verify it without an Android runtime.
 *
 * The happy-path tests (`withInstance_emitsOnPipModeChanged`) need a
 * mocked ReactApplicationContext + DeviceEventManagerModule — those
 * live in the Robolectric-dependent [MpvBridgeModuleTest] class (which
 * is annotated `@Ignore` in sandboxed environments).
 *
 * Why a separate file: keeps the test suite split into
 * "always-runs" (this file, plain JUnit) and "needs-Robolectric"
 * ([MpvBridgeModuleTest]). CI runners without Android sandbox
 * restrictions can run the full suite; local dev environments can run
 * just this file for the most important spec deliverable.
 */
class MpvBridgeModuleNullInstanceTest {

    /**
     * Reflection handle for the `private var instance` field declared
     * inside [MpvBridgeModule]'s `companion object`. The Kotlin
     * compiler hoists such fields into the **outer** class as
     * `private static volatile` (verified by inspecting the AAR's
     * bytecode: `private static volatile ReactApplicationContext instance`
     * lives on `MpvBridgeModule`, not on its Companion object). We
     * therefore read/write the field on `MpvBridgeModule::class.java`
     * and pass `null` for the instance parameter (it's a static).
     */
    private val instanceField = run {
        MpvBridgeModule::class.java
            .getDeclaredField("instance")
            .apply { isAccessible = true }
    }

    @Before
    fun setUp() {
        // Ensure a clean slate. The field is static — pass null as the
        // instance parameter (the standard reflection idiom).
        instanceField.set(null, null)
    }

    @After
    fun tearDown() {
        // Be a good citizen — clear so other tests don't see stale state.
        instanceField.set(null, null)
    }

    // ── Spec §Phase 33.4: null instance is a no-op ───────────────────────

    @Test
    fun onPictureInPictureModeChanged_nullInstance_returnsWithoutCrash() {
        // Cold-start race: MainActivity.onPictureInPictureModeChanged
        // fires before MpvBridgeModule's `init { instance = ... }` has
        // run. The companion must NOT propagate the resulting null
        // deref to the Activity's override — it must log + return.
        assertNull(
            "instance must start as null in a fresh JVM",
            instanceField.get(null),
        )
        // The call would throw NPE if `instance` was used directly. The
        // contract says it must return cleanly.
        MpvBridgeModule.onPictureInPictureModeChanged(isInPictureInPictureMode = true)
        // Verify instance is still null (the call didn't accidentally
        // mutate it).
        assertNull(
            "instance must remain null after a null-instance call",
            instanceField.get(null),
        )
    }

    @Test
    fun onPictureInPictureModeChanged_nullInstance_withFalseArg_alsoReturns() {
        // Both true and false paths must handle null instance — the
        // method body doesn't branch on the boolean before the null
        // check, so this is a quick smoke test that the same null-
        // guard applies for both cases.
        MpvBridgeModule.onPictureInPictureModeChanged(isInPictureInPictureMode = false)
        assertNull(instanceField.get(null))
    }

    @Test
    fun onPictureInPictureModeChanged_multipleNullCalls_areIdempotent() {
        // Repeat-invocation safety: the cold-start race can fire
        // multiple PiP events before the module instance is created.
        // Verify each call is independently a no-op.
        repeat(10) { i ->
            MpvBridgeModule.onPictureInPictureModeChanged(
                isInPictureInPictureMode = i % 2 == 0,
            )
        }
        assertNull(instanceField.get(null))
    }

    // ── Constants / sanity ───────────────────────────────────────────────

    @Test
    fun name_isStable_acrossReleases() {
        // The module name is part of the JS <-> Native bridge contract.
        // JS calls `NativeModules.MpvPlayerModule`; if the Kotlin name
        // changes, the bridge silently breaks. Lock the value.
        assertEquals("MpvPlayerModule", MpvBridgeModule.NAME)
    }
}
