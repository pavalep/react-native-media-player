package com.simba.player.mpv

import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.mockito.kotlin.mock

/**
 * Pure-JUnit unit tests for [MpvRenderViewRegistry] — the registry that
 * answers "is there a live picture view?".
 *
 * These tests do NOT require the Android runtime (no Robolectric). The
 * registry only ever stores [MpvRenderView] instances weakly and compares
 * them by identity, so a Mockito mock stands in for a real view: the mock
 * is never asked to behave like a View, it only has to be an object the
 * registry can hold, compare and withdraw.
 *
 * ## Why this registry exists at all
 *
 * `PlayerSurface` was the old registry, written by `PlayerSurface.mount()`.
 * The V22 architecture never mounts a surface — the picture is a child of
 * the React tree — so `PlayerSurface.current()` answered `null` forever,
 * and `isSurfaceMounted()` answered `false` forever. A consumer that had
 * a `<SimbaVideo />` mounted was told there was nowhere to put a video.
 *
 * The registry is written by [MpvRenderViewManager], the thing that
 * actually creates the views, so it is true by construction.
 *
 * ## Why a separate file
 *
 * Keeps the suite split into "always-runs" (this file, plain JUnit) and
 * "needs-Robolectric" (the rest). CI runners without Android sandbox
 * restrictions can run the full suite; a sandboxed environment can run
 * just this file for the part that matters most.
 */
class MpvRenderViewRegistryTest {

    /** Every mock this test registered, so @After can withdraw all of them. */
    private val registered = mutableListOf<MpvRenderView>()

    @Before
    fun setUp() {
        // The registry is a process-wide singleton, so a test that leaves a
        // registration behind would make the NEXT test lie. Start clean.
        registered.forEach { MpvRenderViewRegistry.unregister(it) }
        registered.clear()
    }

    @After
    fun tearDown() {
        registered.forEach { MpvRenderViewRegistry.unregister(it) }
        registered.clear()
    }

    private fun newPicture(): MpvRenderView {
        val view = mock<MpvRenderView>()
        registered.add(view)
        return view
    }

    @Test
    fun `with no picture registered there is no live view`() {
        assertFalse(MpvRenderViewRegistry.hasLiveView())
        assertNull(MpvRenderViewRegistry.current())
    }

    @Test
    fun `a registered picture is the live view`() {
        val view = newPicture()
        MpvRenderViewRegistry.register(view)

        assertTrue(MpvRenderViewRegistry.hasLiveView())
        assertSame(view, MpvRenderViewRegistry.current())
    }

    @Test
    fun `withdrawing the picture takes the live view away`() {
        val view = newPicture()
        MpvRenderViewRegistry.register(view)
        assertTrue(MpvRenderViewRegistry.hasLiveView())

        MpvRenderViewRegistry.unregister(view)

        assertFalse(MpvRenderViewRegistry.hasLiveView())
        assertNull(MpvRenderViewRegistry.current())
    }

    @Test
    fun `withdrawing a view that is not registered leaves the live one alone`() {
        // Identity-safe: a stale teardown must not unregister its
        // replacement. This is the same rule `PlayerSurface.detach` has.
        val live = newPicture()
        val stranger = newPicture()
        MpvRenderViewRegistry.register(live)

        MpvRenderViewRegistry.unregister(stranger)

        assertTrue(MpvRenderViewRegistry.hasLiveView())
        assertSame(live, MpvRenderViewRegistry.current())
    }

    @Test
    fun `the newest registered picture does not displace the live one`() {
        // D9: one mounted player per lane, so two picture views should
        // not coexist. If they ever do, the registry still answers with a
        // real view rather than with nothing.
        val first = newPicture()
        val second = newPicture()
        MpvRenderViewRegistry.register(first)
        MpvRenderViewRegistry.register(second)

        assertTrue(MpvRenderViewRegistry.hasLiveView())
        val current = MpvRenderViewRegistry.current()
        assertTrue(current === first || current === second)
    }
}
