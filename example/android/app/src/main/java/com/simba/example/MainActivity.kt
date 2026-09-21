package com.simba.example

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

/**
 * Minimal MainActivity for the SIMBA MediaPlayer example app.
 *
 * Purpose: exists only so Gradle has a real AndroidManifest + activity
 * class to compile against. The example app is not run as part of the
 * lib's CI gate — the build is invoked purely so that
 * `:simba-dev_react-native-media-player:compileDebugKotlin` runs in a
 * realistic context (real AGP + real RN gradle plugin + real codegen).
 *
 * If you do `npm start && react-native run-android` in `example/`, the
 * activity delegates to React Native and shows the JS bundle.
 */
class MainActivity : ReactActivity() {

    /**
     * Returns the name of the main component registered from JavaScript.
     * This is used to schedule rendering of the component.
     */
    override fun getMainComponentName(): String = "SimbaMediaPlayerExample"

    /**
     * Returns the instance of the [ReactActivityDelegate]. Here we use a
     * util class [DefaultReactActivityDelegate] which allows you to
     * enable New Architecture with a single boolean flag [fabricEnabled].
     */
    override fun createReactActivityDelegate(): ReactActivityDelegate =
        DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
