package com.simba.example

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

/**
 * Minimal MainApplication for the SIMBA MediaPlayer example app.
 *
 * Purpose: same as MainActivity — exists only so Gradle has a complete
 * AndroidManifest + application class to compile. The lib's CI gate
 * invokes the build purely to surface Kotlin compile errors in the
 * lib (e.g. the v1.5.9-v1.5.11 `codeToNumeric` misplacement).
 *
 * Matches the RN 0.86 bridgeless-mode entry point pattern (the new
 * default since RN 0.76).
 */
class MainApplication : Application(), ReactApplication {

    override val reactHost: ReactHost by lazy {
        getDefaultReactHost(
            context = applicationContext,
            packageList = PackageList(this).packages,
        )
    }

    override fun onCreate() {
        super.onCreate()
        loadReactNative(this)
    }
}
