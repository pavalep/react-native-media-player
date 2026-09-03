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
set(MPV_LIB_PATH ${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libmpv.so)
if(EXISTS ${MPV_LIB_PATH})
    add_library(mpv SHARED IMPORTED)
    set_target_properties(mpv PROPERTIES IMPORTED_LOCATION ${MPV_LIB_PATH})
    message(STATUS "Found libmpv.so at ${MPV_LIB_PATH}")
else()
    message(WARNING "libmpv.so not found at ${MPV_LIB_PATH} — link will fail")
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
