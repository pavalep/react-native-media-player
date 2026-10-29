package com.simba.player.mpv

import com.facebook.react.bridge.ReactApplicationContext
import com.simba.player.PlaybackHost
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.mockito.kotlin.mock
import org.mockito.kotlin.never
import org.mockito.kotlin.verify

/**
 * Contract test: the mpv engine handle must survive a Fabric picture-view
 * remount.
 *
 * ## The contract
 *
 * The picture is a Fabric component in the React tree (`<SimbaVideo />` →
 * `SimbaVideoView` → `MpvRenderView`), created and destroyed by
 * [MpvRenderViewManager]. Under decision D2 the view may be **dropped and
 * recreated** at any time — a re-layout, a lane switch, a navigation
 * blanking.
 *
 * The mpv engine handle does **not** belong to that view. It belongs to the
 * process: [PlaybackHost] owns it, and [MpvBridgeModule] reads it through
 * its `nativePtr` property. So dropping the picture must leave the engine
 * alone — the same handle, not zero, not re-created, not torn down.
 *
 * ## What this test proves
 *
 *  - Dropping the picture through the real
 *    [MpvRenderViewManager.onDropViewInstance] leaves [PlaybackHost]'s handle
 *    exactly as it was: not zero (torn down), not a different value
 *    (re-created).
 *  - The drop path never re-publishes the handle.
 *    [PlaybackHost.publishHandle] notifies every availability listener on
 *    every call, so the notification count pins "the engine was not
 *    re-created behind the view's back".
 *  - A picture view created after the drop is bound to the *same* handle,
 *    through the real [MpvRenderViewManager.setNativePtr] prop path — the
 *    path React Native uses to hand the bridge's handle to a view.
 *  - The two facts stay independent: the picture registry empties while the
 *    engine handle stays live. A control that asks "is there a picture?"
 *    must get a different answer than the one that asks "is the engine
 *    alive?".
 *  - The bridge's own accessor ([MpvBridgeModule.getNativePtr] — what JS
 *    reads) reports the same handle after the remount.
 *
 * ## What this test does NOT prove
 *
 *  - It does not prove that a **real** libmpv engine survives. No mpv is
 *    involved: [MPVLib] is a JNI wrapper whose `init` block calls
 *    `System.loadLibrary("simbaplayer_mpv")`, which cannot succeed in a JVM
 *    unit test. The handle here is a stand-in value published through
 *    [PlaybackHost]. What is proven is the *ownership and lifetime* rule
 *    around that handle — the thing a view-drop path could break.
 *  - It does not prove that a real [MpvRenderView] can be built. That needs
 *    a `Context`, and `SurfaceView`'s constructor cannot run without the
 *    Android runtime, so the view is a Mockito mock — exactly as in
 *    [MpvRenderViewRegistryTest]. The manager's `createViewInstance` is
 *    therefore *not* called; the create side of the cycle is reproduced by
 *    the only two things that method really does — publish the view to
 *    [MpvRenderViewRegistry], and receive the `nativePtr` prop through
 *    [MpvRenderViewManager.setNativePtr].
 *  - It does not prove anything about Surface/SurfaceHolder attachment. The
 *    surface edge is the view's business, not the bridge's; the mock
 *    records that the drop released it rather than performing the release.
 *
 * ## Why pure JUnit
 *
 * The Robolectric suites in this module are `@Ignore`'d in the sandboxed
 * environment (they cannot download the `android-all` runtime jars), so a
 * test written there would not run and would prove nothing. This file runs
 * everywhere. It follows [MpvRenderViewRegistryTest], the existing
 * always-runs test for the sibling registry.
 */
class MpvHandleSurvivesViewRemountTest {

    /**
     * A stand-in for a real libmpv handle.
     *
     * Deliberately larger than 2^32 so that a truncating conversion — an
     * `Int` where a `Long` belongs — yields a *different* number instead
     * of accidentally matching, and deliberately non-zero so that "the
     * engine is alive" and "the engine is gone" are distinguishable.
     */
    private val handle = 0x0000_7F2A_1C3D_5E6FL

    /** The real Fabric view manager — this is the code under test. */
    private val manager = MpvRenderViewManager()

    /** Every view this test published, so `@After` can withdraw all of them. */
    private val registered = mutableListOf<MpvRenderView>()

    /** Availability notifications observed during the current test. */
    private val published = mutableListOf<Long>()

    /**
     * The listener registered with [PlaybackHost.whenAvailable].
     *
     * Held in a field so `@After` can cancel exactly the same instance.
     * [PlaybackHost] is process-wide: a listener left behind would make the
     * *next* test see notifications it did not cause.
     */
    private val availabilityListener: (Long) -> Unit = { published.add(it) }

    /**
     * Reflection handle for [MpvBridgeModule]'s static companion `instance`
     * field, so the mocked React context this test hands the bridge does not
     * outlive the test. Same idiom as [MpvBridgeModuleNullInstanceTest]:
     * Kotlin hoists a companion field into the **outer** class as a
     * `private static volatile`, so it is read on [MpvBridgeModule] and
     * written with a `null` instance argument.
     */
    private val bridgeInstanceField = run {
        MpvBridgeModule::class.java
            .getDeclaredField("instance")
            .apply { isAccessible = true }
    }

    @Before
    fun setUp() {
        // `PlaybackHost` is a process-wide singleton — start from "no engine".
        PlaybackHost.clearHandle()
        published.clear()
    }

    @After
    fun tearDown() {
        PlaybackHost.cancelWhenAvailable(availabilityListener)
        registered.forEach { MpvRenderViewRegistry.unregister(it) }
        registered.clear()
        PlaybackHost.clearHandle()
        bridgeInstanceField.set(null, null)
    }

    /**
     * A stand-in for the picture view Fabric creates.
     *
     * `MpvRenderView` extends `SurfaceView`, whose constructor needs a real
     * `Context` and the Android runtime, so the view is a Mockito mock. The
     * mock only has to be an object the manager can hold, drop and bind.
     */
    private fun newPicture(): MpvRenderView {
        val view = mock<MpvRenderView>()
        registered.add(view)
        // The only thing `MpvRenderViewManager.createViewInstance` does with
        // the view it builds is publish it to the registry.
        MpvRenderViewRegistry.register(view)
        return view
    }

    // ── The handle survives the drop ───────────────────────────────────────

    @Test
    fun `dropping the picture view leaves the engine handle untouched`() {
        PlaybackHost.publishHandle(handle)
        val view = newPicture()

        manager.onDropViewInstance(view)

        assertEquals(
            "dropping the Fabric picture must not tear the mpv engine down",
            handle,
            PlaybackHost.handle(),
        )
        assertNotEquals(
            "a torn-down engine reads back as 0L",
            0L,
            PlaybackHost.handle(),
        )
        // The drop releases the surface↔mpv edge...
        verify(view).detachSurfaceForViewDrop()
        // ...and nothing more. `cleanup()` additionally clears the view's own
        // handle and is reserved for the engine being destroyed.
        verify(view, never()).cleanup()
    }

    @Test
    fun `dropping the picture view does not re-publish the engine handle`() {
        PlaybackHost.whenAvailable(availabilityListener)
        PlaybackHost.publishHandle(handle)
        assertEquals(
            "creating the engine must notify availability exactly once",
            listOf(handle),
            published,
        )

        val view = newPicture()
        manager.onDropViewInstance(view)

        assertEquals(
            "the drop path must not re-create or re-publish the engine",
            listOf(handle),
            published,
        )
    }

    // ── The recreated view binds the same handle ───────────────────────────

    @Test
    fun `a picture view recreated after a drop is bound to the same handle`() {
        PlaybackHost.publishHandle(handle)
        val first = newPicture()
        manager.onDropViewInstance(first)

        // Fabric builds a NEW view instance for the same picture, and React
        // Native re-applies the `nativePtr` prop to it. The value it
        // re-applies is whatever the bridge currently holds — so if the drop
        // had taken the engine with it, the new picture would be bound to a
        // dead handle.
        val second = newPicture()
        manager.setNativePtr(second, PlaybackHost.handle().toDouble())

        verify(second).setNativePtr(handle)
        assertEquals(
            "the engine handle must be the same one before and after the remount",
            handle,
            PlaybackHost.handle(),
        )
    }

    // ── The picture and the engine are independent facts ───────────────────

    @Test
    fun `the picture registry empties while the engine handle stays live`() {
        PlaybackHost.publishHandle(handle)
        val view = newPicture()
        assertTrue(
            "the newly created picture must be the live one",
            MpvRenderViewRegistry.hasLiveView(),
        )

        manager.onDropViewInstance(view)

        assertFalse(
            "the dropped picture must leave the registry",
            MpvRenderViewRegistry.hasLiveView(),
        )
        assertEquals(
            "...while the engine it was showing stays alive",
            handle,
            PlaybackHost.handle(),
        )
    }

    // ── What the bridge reports ───────────────────────────────────────────

    @Test
    fun `the bridge reports the same handle after a picture view remount`() {
        val bridge = MpvBridgeModule(mock<ReactApplicationContext>())
        PlaybackHost.publishHandle(handle)
        assertEquals(
            "the bridge must publish the handle it was given",
            handle.toDouble(),
            bridge.getNativePtr(),
            0.0,
        )

        val first = newPicture()
        manager.onDropViewInstance(first)
        val second = newPicture()
        manager.setNativePtr(second, bridge.getNativePtr())

        assertEquals(
            "the bridge must still hand out the same live handle after the remount",
            handle.toDouble(),
            bridge.getNativePtr(),
            0.0,
        )
        verify(second).setNativePtr(handle)
    }
}
