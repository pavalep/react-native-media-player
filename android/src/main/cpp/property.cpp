#include <jni.h>
#include <android/log.h>
#include <string>
#include <cstring>
#include <client.h>
#include <native_state.h>

#define LOG_TAG "MpvProperty"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

extern "C" JNIEXPORT jstring JNICALL
Java_com_simba_player_mpv_MPVLib_nativeGetProperty(
    JNIEnv *env, jclass, jlong nativePtr, jstring name) {
    if (!name) return env->NewStringUTF("null");
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return env->NewStringUTF("null");
    mpv_handle *mpv = lease.get();
    const char *propName = env->GetStringUTFChars(name, nullptr);
    if (!propName) return env->NewStringUTF("null");

    mpv_node node{};
    const int err = mpv_get_property(mpv, propName, MPV_FORMAT_NODE, &node);
    env->ReleaseStringUTFChars(name, propName);

    if (err < 0) {
        return env->NewStringUTF("null");
    }

    const std::string json = jsonNode(&node);
    mpv_free_node_contents(&node);
    return env->NewStringUTF(json.c_str());
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativeSetProperty(
    JNIEnv *env, jclass, jlong nativePtr, jstring name, jstring valueJson) {
    if (!name) return;
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    mpv_handle *mpv = lease.get();
    const char *propName = env->GetStringUTFChars(name, nullptr);
    if (!propName) return;
    const char *json = valueJson ? env->GetStringUTFChars(valueJson, nullptr) : "null";

    if (json) {
        mpv_set_property_string(mpv, propName, json);
    }

    if (valueJson && json) env->ReleaseStringUTFChars(valueJson, json);
    env->ReleaseStringUTFChars(name, propName);
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativeObserveProperty(
    JNIEnv *env, jclass, jlong nativePtr, jstring name) {
    if (!name) return;
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    mpv_handle *mpv = lease.get();
    const char *propName = env->GetStringUTFChars(name, nullptr);
    if (!propName) return;
    uint64_t hash = 0;
    for (const char *p = propName; *p; p++)
        hash = hash * 31 + static_cast<unsigned char>(*p);
    enum mpv_format format = MPV_FORMAT_NODE;
    if (strcmp(propName, "paused-for-cache") == 0 ||
        strcmp(propName, "seekable") == 0 ||
        strcmp(propName, "seeking") == 0 ||
        strcmp(propName, "idle-active") == 0 ||
        strcmp(propName, "eof-reached") == 0 ||
        strcmp(propName, "pause") == 0) {
        format = MPV_FORMAT_FLAG;
    } else if (strcmp(propName, "cache-buffering-state") == 0 ||
               strcmp(propName, "time-pos") == 0 ||
               strcmp(propName, "duration") == 0 ||
               strcmp(propName, "volume") == 0 ||
               strcmp(propName, "speed") == 0) {
        format = MPV_FORMAT_DOUBLE;
    }
    const int err = mpv_observe_property(mpv, hash, propName, format);
    LOGI("[PlaybackTrace][Native][observe] property=%s id=%llu format=%d result=%d",
         propName, static_cast<unsigned long long>(hash), format, err);

    env->ReleaseStringUTFChars(name, propName);
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativeUnobserveProperty(
    JNIEnv *env, jclass, jlong nativePtr, jstring name) {
    if (!name) return;
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    mpv_handle *mpv = lease.get();
    const char *propName = env->GetStringUTFChars(name, nullptr);
    if (!propName) return;
    uint64_t hash = 0;
    for (const char *p = propName; *p; p++)
        hash = hash * 31 + static_cast<unsigned char>(*p);
    mpv_unobserve_property(mpv, hash);
    LOGI("Unobserving property: %s", propName);
    env->ReleaseStringUTFChars(name, propName);
}
