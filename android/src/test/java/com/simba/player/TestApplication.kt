package com.simba.player

import android.app.Application

/**
 * Stub Application class used by Robolectric tests in
 * [androidx.test:core] / [androidx.test.ext:junit] when we need to grab a
 * test-instrumented Context via [androidx.test.core.app.ApplicationProvider].
 *
 * Robolectric's default behaviour is to instantiate
 * `android.app.Application` directly, but a custom subclass gives us a
 * stable FQN we can reference from the `@Config(application=...)`
 * annotation on every test class. That avoids surprise re-instantiation
 * if Android's default Application class ever gains side effects.
 *
 * Phase 33 deliverable. Lives in `src/test/` (unit-test source set) so
 * it is NOT shipped in the AAR.
 */
class TestApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // Deliberately empty — we only need a stable Application
        // subclass for Robolectric to instantiate. Real init would go
        // here if a future phase needs to inject test doubles.
    }
}
