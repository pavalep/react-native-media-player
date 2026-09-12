cmake_minimum_required(VERSION 3.22.1)

project(simbaplayer_mpv)

# ═══════════════════════════════════════════════════════════════════════
# libsimbaplayer_mpv.so — Native wrapper around libmpv for Android JNI
#
# Phase 28: this CMakeLists.txt moved out of the consumer app's
# MOBILE_APP_REACT_NATIVE/android/app/src/main/cpp/CMakeLists.txt.
# The consumer app's CMakeLists.txt now builds only libappmodules.so
# (RN TurboModule OnLoad + autolinking + codegen). The mpv JNI wrapper
# is built here as part of the module's AAR.
#
# Source files: main.cpp + property.cpp + event.cpp + native_state.cpp
# (all moved from the consumer app in Phase 28)
#
# Output: libsimbaplayer_mpv.so packaged in the module's AAR and
# loaded by MPVLib.java via System.loadLibrary("simbaplayer_mpv").
# ═══════════════════════════════════════════════════════════════════════

add_library(
    simbaplayer_mpv
    SHARED
    main.cpp
    property.cpp
    event.cpp
    native_state.cpp
)

# Locate pre-built libmpv.so shipped in jniLibs/{ABI}/libmpv.so
#
# V16.0.3 (1.5.3): replaced the silent `WARNING + link will fail` branch with a
# hard `FATAL_ERROR`. The previous behavior led to a downstream linker failure
# ("unable to find library -lmpv") that pointed at the wrong file — the build
# would technically succeed and only fail at the link step, masking the real
# root cause (libmpv.so is missing from the consumer's jniLibs/). Now CMake
# stops at configure time with an actionable error.
#
# If you see this error:
#   1. Confirm `android/src/main/jniLibs/${ANDROID_ABI}/libmpv.so` exists in
#      the source repo (it is .gitignored by size — see .gitignore).
#   2. Reinstall the package: `npm install @simba-dev/react-native-media-player`
#      so the jniLibs files are copied into node_modules.
#   3. If you are consuming this library from source (not npm), the jniLibs
#      are shipped in the package tarball via the `files` allow-list in
#      package.json.
set(MPV_LIB_PATH ${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libmpv.so)
if(EXISTS ${MPV_LIB_PATH})
    add_library(mpv SHARED IMPORTED)
    set_target_properties(mpv PROPERTIES IMPORTED_LOCATION ${MPV_LIB_PATH})
    message(STATUS "Found libmpv.so at ${MPV_LIB_PATH}")
else()
    message(FATAL_ERROR
        "libmpv.so not found at ${MPV_LIB_PATH}\n"
        "The prebuilt libmpv binary is shipped in this package's jniLibs/ directory.\n"
        "Most likely cause: your install of @simba-dev/react-native-media-player is\n"
        "missing the native prebuilts. Try:\n"
        "  rm -rf node_modules/@simba-dev/react-native-media-player\n"
        "  npm install @simba-dev/react-native-media-player\n"
        "If consuming from a fork, ensure the package's `files` allow-list in\n"
        "package.json includes android/ (which transitively covers jniLibs/).")
endif()

target_include_directories(
    simbaplayer_mpv
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}
        ${CMAKE_CURRENT_SOURCE_DIR}/include/mpv
)

target_link_libraries(
    simbaplayer_mpv
    android
    log
    mpv
)
