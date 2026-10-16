package com.simba.player

import com.facebook.react.TurboReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.facebook.react.uimanager.ViewManager
import com.simba.player.mpv.MpvBridgeModule
import com.simba.player.mpv.MpvRenderViewManager

/**
 * React Native Package that registers the V12 player's native modules +
 * view managers with the consumer app's React Host.
 *
 * Phase 31: replaces the V11-era `com.simba.player.mpv.MpvPlayerPackage`
 * (a plain `ReactPackage` that returned `createNativeModules` /
 * `createViewManagers` lists). V12 needs a `TurboReactPackage` so:
 *
 *   1. The new architecture's TurboModule resolution works (the JS
 *      `NativeModules.MpvPlayerModule` lookup is satisfied by
 *      `getModule(name, reactContext)` rather than the legacy list).
 *   2. `getReactModuleInfoProvider()` advertises the module as
 *      `isTurboModule = true`, which lets RN's autolinking detect it
 *      during `react-native config` (Phase 30's autolinking relies on
 *      this for `npx react-native config` to find the package).
 *
 * Phase 31 also relocates the package class out of the `mpv` subpackage
 * into the module's root package (`com.simba.player`). `MpvBridgeModule`
 * itself stays in `com.simba.player.mpv` because it has internal
 * dependencies on `MPVLib` (also in the `mpv` subpackage). The new
 * `PlayerPackage` looks it up via its FQN.
 *
 * Phase 6 note, superseded 2026-10-16: the ViewManager side is no longer
 * empty. `MpvRenderViewManager` registers `SimbaVideoView`, so the mpv
 * SurfaceView is an ordinary child of the React tree instead of being mounted
 * by Kotlin at `android.R.id.content` index 0 as a sibling of the React root.
 * That sibling arrangement is what let an opaque React root paint over every
 * decoded frame. See `SimbaVideoViewManager` and
 * `src/components/SimbaVideo.tsx`.
 */
class PlayerPackage : TurboReactPackage() {

    override fun getModule(
        name: String,
        reactContext: ReactApplicationContext,
    ): NativeModule? {
        return when (name) {
            MpvBridgeModule.NAME -> MpvBridgeModule(reactContext)
            else -> null
        }
    }

    /**
     * The video picture, as a real React Native view.
     *
     * Previously absent: the surface was mounted natively and `PlayerSurface`
     * on the JS side was a no-op transparent `<View>` that only reserved layout
     * space. A component with no native counterpart is what forced every screen
     * to blank itself around the player.
     */
    override fun createViewManagers(
        reactContext: ReactApplicationContext,
    ): List<ViewManager<*, *>> = listOf(MpvRenderViewManager())

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
        return ReactModuleInfoProvider {
            mapOf(
                MpvBridgeModule.NAME to ReactModuleInfo(
                    /* name = */ MpvBridgeModule.NAME,
                    /* className = */ MpvBridgeModule::class.java.name,
                    /* canOverrideExistingModule = */ false,
                    /* needsEagerInit = */ false,
                    /* isCxxModule = */ false,
                    /* isTurboModule = */ true,
                ),
            )
        }
    }
}
