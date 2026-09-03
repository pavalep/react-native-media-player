/**
 * React Native autolinking configuration for `@simba/react-native-media-player`.
 *
 * The `dependency` block tells `@react-native-community/cli` how to find
 * and register the native side of this package when a consumer app runs
 * `react-native config` (during `react-native run-android`, Gradle
 * autolinking, or `npx react-native autolink`).
 *
 * - `sourceDir`: where Gradle should look for the library. Defaults to
 *   `./android`, which matches the layout we use.
 * - `packageImportPath`: the import line `react-native autolink` will
 *   append to `MainApplication.kt` for the consumer. Phase 31 moved
 *   the package class from `com.simba.player.mpv.MpvPlayerPackage` to
 *   `com.simba.player.PlayerPackage` (root package + TurboReactPackage
 *   upgrade for new architecture).
 * - `packageInstance`: the constructor call `react-native autolink` will
 *   append to the `packageList` builder.
 * - `ios: null`: this package is Android-only. Returning null tells the
 *   CLI to skip iOS entirely.
 */
module.exports = {
  dependency: {
    platforms: {
      android: {
        sourceDir: './android',
        packageImportPath: 'import com.simba.player.PlayerPackage;',
        packageInstance: 'new PlayerPackage()',
      },
      ios: null,
    },
  },
};
