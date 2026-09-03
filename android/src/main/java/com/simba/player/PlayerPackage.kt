package com.simba.player

import com.facebook.react.TurboReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.simba.player.mpv.MpvBridgeModule

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
 * The `ViewManager` side is left empty — the module's `MpvRenderViewManager`
 * (which is V11-era and used only by the old `MainActivity` JS tree) is
 * kept in the `mpv` subpackage for backward compat until W8 (Phase 41+
 * deletes the V11 inline-mount path). PlayerActivity (Phase 6) mounts
 * `MpvRenderView` natively via `PlayerActivity.onCreate` so the JS-side
 * `<MpvRenderView />` component is no longer needed for V12 playback.
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
