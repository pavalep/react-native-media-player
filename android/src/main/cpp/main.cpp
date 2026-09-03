#include <jni.h>
#include <android/log.h>
#include <android/native_window.h>
#include <android/native_window_jni.h>
#include <pthread.h>
#include <string>
#include <map>
#include <cstring>
#include <dlfcn.h>
#include <shared_mutex>
#include <mutex>
#include <native_state.h>
#include <client.h>   // mpv

#define LOG_TAG "MpvJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

// ── Globals ────────────────────────────────────────────────────────────────

JavaVM *g_vm = nullptr;
mpv_handle *g_mpv = nullptr;
std::atomic<bool> g_running{false};
std::atomic<bool> g_initialized{false};
std::shared_mutex g_mpvLifecycleMutex;
static pthread_t g_eventThread = 0;
// FIX (crash hotfix): this mpv build's Android VO consumes `wid` as a JNI
// GLOBAL REFERENCE to an android.view.Surface and calls
// ANativeWindow_fromSurface() on its own VO thread. An earlier revision
// stored a raw ANativeWindow* here and passed that as wid; the VO thread
// then dereferenced the pointer as a jobject and aborted with
// "JNI ERROR: jobject is an invalid JNI transition frame reference".
// Keep the global ref alive until the VO is stopped (vo=null) + detached.
jobject g_surface = nullptr;

// Cached Java references
jclass g_cls_MPVLib = nullptr;
jmethodID g_mid_onEvent = nullptr;
jmethodID g_mid_onPropertyChanged = nullptr;
jmethodID g_mid_onError = nullptr;

// ── Forward declarations ──────────────────────────────────────────────────

void eventLoop();

static bool initializeMpv(mpv_handle *mpv) {
    if (!mpv) {
        LOGE("[PlaybackTrace][Native][initialize] null mpv handle");
        return false;
    }
    if (g_initialized.load()) {
        LOGI("[PlaybackTrace][Native][initialize] already initialized");
        return true;
    }

    LOGI("[PlaybackTrace][Native][initialize] calling mpv_initialize");
    int result = mpv_initialize(mpv);
    if (result < 0) {
        LOGE("mpv_initialize failed: %s", mpv_error_string(result));
        return false;
    }

    LOGI("[PlaybackTrace][Native][initialize] mpv_initialize succeeded");
    mpv_request_log_messages(mpv, "v");
    LOGI("[PlaybackTrace][Native][initialize] requested mpv verbose logs");
    g_initialized.store(true);
    g_running.store(true);
    if (pthread_create(&g_eventThread, nullptr, [](void *) -> void * {
            eventLoop();
            return nullptr;
        }, nullptr) != 0) {
        LOGE("Failed to create mpv event thread");
        g_running.store(false);
        g_initialized.store(false);
        mpv_terminate_destroy(mpv);
        return false;
    }

    LOGI("mpv initialized and event loop started");
    return true;
}

// ── JNI_OnLoad ────────────────────────────────────────────────────────────

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *) {
    g_vm = vm;
    JNIEnv *env;
    if (vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) != JNI_OK)
        return JNI_ERR;

    jclass temp = env->FindClass("com/simba/player/mpv/MPVLib");
    if (!temp) {
        LOGE("Failed to find MPVLib class");
        return JNI_ERR;
    }
    g_cls_MPVLib = static_cast<jclass>(env->NewGlobalRef(temp));
    env->DeleteLocalRef(temp);

    g_mid_onEvent = env->GetStaticMethodID(
        g_cls_MPVLib, "onNativeEvent",
        "(Ljava/lang/String;Ljava/lang/String;)V");
    if (!g_mid_onEvent) {
        LOGE("Failed to find onNativeEvent");
        return JNI_ERR;
    }

    g_mid_onPropertyChanged = env->GetStaticMethodID(
        g_cls_MPVLib, "onNativePropertyChanged",
        "(Ljava/lang/String;Ljava/lang/String;)V");
    if (!g_mid_onPropertyChanged) {
        LOGE("Failed to find onNativePropertyChanged");
        return JNI_ERR;
    }

    g_mid_onError = env->GetStaticMethodID(
        g_cls_MPVLib, "onNativeError",
        "(IZLjava/lang/String;Ljava/lang/String;)V");
    if (!g_mid_onError) {
        LOGE("Failed to find onNativeError");
        return JNI_ERR;
    }

    // Set JVM for FFmpeg and libmpv (which uses av_jni_get_java_vm)
    void* avcodec_handle = dlopen("libavcodec.so", RTLD_NOW);
    if (avcodec_handle) {
        typedef int (*av_jni_set_java_vm_t)(void *vm, void *log_ctx);
        av_jni_set_java_vm_t set_vm = (av_jni_set_java_vm_t)dlsym(avcodec_handle, "av_jni_set_java_vm");
        if (set_vm) {
            set_vm(vm, nullptr);
            LOGI("av_jni_set_java_vm called successfully");
        } else {
            LOGE("dlsym failed for av_jni_set_java_vm: %s", dlerror());
        }
    } else {
        LOGE("dlopen failed for libavcodec.so: %s", dlerror());
    }

    LOGI("JNI_OnLoad complete");
    return JNI_VERSION_1_6;
}

// ── Helper: call static Java method from any thread ───────────────────────

static void callStaticJavaVoid(JNIEnv *env, jmethodID mid, ...) {
    va_list args;
    va_start(args, mid);
    env->CallStaticVoidMethodV(g_cls_MPVLib, mid, args);
    va_end(args);
}

static JNIEnv *getEnv() {
    JNIEnv *env = nullptr;
    if (g_vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) == JNI_OK)
        return env;
    JavaVMAttachArgs args = {JNI_VERSION_1_6, nullptr, nullptr};
    if (g_vm->AttachCurrentThread(&env, &args) == JNI_OK)
        return env;
    return nullptr;
}

// ── Helper: flush queued mpv core work ──────────────────────────────────
// Property writes (vo=null / wid=...) from other threads are processed
// asynchronously on the mpv core thread. `mpv_command` blocks until the
// command has been executed, so a trailing no-op guarantees every earlier
// queued change has been APPLIED. We need that before DeleteGlobalRef:
// if we dropped the ref while the old VO teardown was still in flight,
// this mpv build's android GPU context could touch a stale jobject (the
// "invalid JNI transition frame reference" abort from the old crash log —
// and, in the non-crashing case, rendering into a defunct window).
static void flushMpvCore(mpv_handle *mpv) {
    if (!mpv) return;
    const char *cmd[] = {"ignore", nullptr};
    mpv_command(mpv, cmd);
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

extern "C" JNIEXPORT jlong JNICALL
Java_com_simba_player_mpv_MPVLib_nativeCreate(JNIEnv *env, jclass, jstring caFilePath) {
    std::unique_lock<std::shared_mutex> lifecycleLock(g_mpvLifecycleMutex);
    if (g_mpv) {
        LOGI("mpv instance already exists, returning existing");
        return reinterpret_cast<jlong>(g_mpv);
    }

    g_initialized.store(false);

    mpv_handle *mpv = mpv_create();
    if (!mpv) {
        LOGE("mpv_create failed");
        return 0;
    }

    // Set pre-init options (NOT wid — that requires the Surface and will be
    // set in nativeAttachSurface before mpv_initialize).
    // Audio overlays do not mount a video surface. Keep video output disabled
    // until a surface is explicitly attached by MpvRenderView.
    int optionResult = mpv_set_option_string(mpv, "vo", "null");
    LOGI("[PlaybackTrace][Native][create] option vo=null result=%d", optionResult);
    optionResult = mpv_set_option_string(mpv, "gpu-api", "opengl");
    LOGI("[PlaybackTrace][Native][create] option gpu-api=opengl result=%d", optionResult);
    optionResult = mpv_set_option_string(mpv, "hwdec", "mediacodec");
    LOGI("[PlaybackTrace][Native][create] option hwdec=mediacodec result=%d", optionResult);
    // Let mpv preserve the source transfer function and range instead of
    // applying a blanket SDR conversion. This keeps SDR/HDR content neutral
    // on devices that expose the required display metadata.
    mpv_set_option_string(mpv, "video-output-levels", "auto");
    mpv_set_option_string(mpv, "target-colorspace-hint", "yes");
    mpv_set_option_string(mpv, "correct-downscaling", "yes");
    optionResult = mpv_set_option_string(mpv, "audio-device-auto", "yes");
    LOGI("[PlaybackTrace][Native][create] option audio-device-auto=yes result=%d", optionResult);

    // Android libmpv builds do not consistently discover the platform trust
    // store. Supply the app-bundled Mozilla CA bundle while keeping TLS
    // verification enabled for HTTPS streams.
    if (caFilePath) {
        const char *caPath = env->GetStringUTFChars(caFilePath, nullptr);
        if (caPath && caPath[0] != '\0') {
            optionResult = mpv_set_option_string(mpv, "tls-ca-file", caPath);
            LOGI("[PlaybackTrace][Native][create] option tls-ca-file=%s result=%d", caPath, optionResult);
            env->ReleaseStringUTFChars(caFilePath, caPath);
        } else {
            LOGE("[PlaybackTrace][Native][create] empty CA bundle path; HTTPS validation may fail");
            if (caPath) env->ReleaseStringUTFChars(caFilePath, caPath);
        }
    } else {
        LOGE("[PlaybackTrace][Native][create] null CA bundle path; HTTPS validation may fail");
    }
    optionResult = mpv_set_option_string(mpv, "tls-verify", "yes");
    LOGI("[PlaybackTrace][Native][create] option tls-verify=yes result=%d", optionResult);
    optionResult = mpv_set_option_string(mpv, "keep-open", "yes");
    LOGI("[PlaybackTrace][Native][create] option keep-open=yes result=%d", optionResult);
    optionResult = mpv_set_option_string(mpv, "pause", "no");
    LOGI("[PlaybackTrace][Native][create] option pause=no result=%d", optionResult);

    // ── Streaming / buffering tuning ────────────────────────────────────
    // These are the same options used by desktop MPV configs to get
    // YouTube/Netflix-class seek-bar buffered-range visualization and
    // snappy re-seeks on slow network streams (archive.org HLS, etc.).
    //
    //   • cache=yes              : enable a RAM cache even for non-network
    //                              sources (so seek-back is instant).
    //   • cache-secs=120         : keep ~2 minutes of stream ahead of the
    //                              playhead in RAM. Big enough to absorb a
    //                              brief re-buffer without a spinner, small
    //                              enough to stay under mobile RAM limits.
    //   • demuxer-max-bytes      : hard upper bound on the cache size in
    //                              bytes (≈150 MB). Prevents OOM on large
    //                              VOD files over HTTP.
    //   • demuxer-max-back-bytes : how far backwards the cache retains
    //                              data (~75 MB). This is what makes
    //                              "seek back 30 s" instantaneous.
    //   • demuxer-readahead-secs : how many seconds of stream to prefetch
    //                              ahead of the playhead.
    //   • demuxer-termination-timeout : if a network read stalls, fail
    //                              the demuxer so the player can recover
    //                              instead of hanging forever.
    //   • prefetch-playlist=yes  : proactively fetch the next playlist
    //                              entry (HLS / DASH) to enable gapless.
    mpv_set_option_string(mpv, "cache", "yes");
    mpv_set_option_string(mpv, "cache-secs", "120");
    mpv_set_option_string(mpv, "demuxer-max-bytes", "150MiB");
    mpv_set_option_string(mpv, "demuxer-max-back-bytes", "75MiB");
    mpv_set_option_string(mpv, "demuxer-readahead-secs", "120");
    mpv_set_option_string(mpv, "demuxer-termination-timeout", "10");
    mpv_set_option_string(mpv, "prefetch-playlist", "yes");

    // Initialize immediately so audio-only playback can load streams without
    // waiting for a video surface. Video surfaces remain independently attachable.

    LOGI("[PlaybackTrace][Native][create] mpv_create succeeded handle=%p", mpv);
    g_mpv = mpv;
    if (!initializeMpv(mpv)) {
        g_mpv = nullptr;
        return 0;
    }
    LOGI("mpv instance created and initialized without a required surface");
    return reinterpret_cast<jlong>(mpv);

}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativeDestroy(JNIEnv *env, jclass) {
    std::unique_lock<std::shared_mutex> lifecycleLock(g_mpvLifecycleMutex);
    if (!g_mpv) return;

    g_running.store(false);
    g_initialized.store(false);
    mpv_handle *handle = g_mpv;
    mpv_wakeup(handle);
    if (g_eventThread) {
        pthread_join(g_eventThread, nullptr);
        g_eventThread = 0;
    }

    if (g_surface) {
        env->DeleteGlobalRef(g_surface);
        g_surface = nullptr;
    }
    clearPendingLoadRequests();
    mpv_destroy(handle);
    g_mpv = nullptr;
    LOGI("mpv instance destroyed");
}


extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativeSetPropertyString(
    JNIEnv *env, jclass, jlong nativePtr, jstring property, jstring value) {
    if (!property) return;
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    mpv_handle *mpv = lease.get();
    const char *prop = env->GetStringUTFChars(property, nullptr);
    const char *val = value ? env->GetStringUTFChars(value, nullptr) : nullptr;
    int result = mpv_set_property_string(mpv, prop, val);
    if (result < 0) {
        LOGE("mpv_set_property_string(%s) failed: %s", prop, mpv_error_string(result));
    }
    env->ReleaseStringUTFChars(property, prop);
    if (val) env->ReleaseStringUTFChars(value, val);
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativeAttachSurface(
    JNIEnv *env, jclass, jlong nativePtr, jobject surface) {
    std::unique_lock<std::shared_mutex> lifecycleLock(g_mpvLifecycleMutex);
    if (!nativePtr || nativePtr != reinterpret_cast<jlong>(g_mpv) || !g_initialized.load()) return;

    mpv_handle *mpv = g_mpv;

    if (surface) {
        // ── Attach surface ──────────────────────────────────────────────
        // wid = JNI global ref to the Surface (mpv derives its own
        // ANativeWindow on the VO thread). Never pass a raw ANativeWindow*
        // here — see the g_surface comment at the top of this file.
        jobject newSurface = env->NewGlobalRef(surface);
        if (!newSurface) {
            LOGE("Failed to create GlobalRef for surface");
            return;
        }

        if (!g_initialized.load()) {
            LOGE("Surface attach rejected because mpv is not initialized");
            env->DeleteGlobalRef(newSurface);
            return;
        }

        // mpv was told to set vo=null before this call, so the VO is not
        // actively using the previous wid value; the option is simply
        // stored and picked up when Java restores vo=gpu.
        int64_t wid = reinterpret_cast<intptr_t>(newSurface);
        int result = mpv_set_property(mpv, "wid", MPV_FORMAT_INT64, &wid);
        if (result < 0) {
            LOGW("mpv_set_property(wid) on attach failed: %s", mpv_error_string(result));
        }

        // Flush the queued vo=null + wid updates so the old ref below is
        // guaranteed no longer referenced by mpv before we drop it.
        flushMpvCore(mpv);
        if (g_surface) {
            env->DeleteGlobalRef(g_surface);
            g_surface = nullptr;
        }
        g_surface = newSurface;

        LOGI("Surface attached with global-ref wid");

        // Emit surfaceAttached event
        JNIEnv* jniEnv = getEnv();
        if (jniEnv && g_mid_onEvent) {
            jstring jName = jniEnv->NewStringUTF("surfaceAttached");
            jstring jPayload = jniEnv->NewStringUTF("{}");
            callStaticJavaVoid(jniEnv, g_mid_onEvent, jName, jPayload);
            jniEnv->DeleteLocalRef(jName);
            jniEnv->DeleteLocalRef(jPayload);
        }
    } else {
        // ── Detach surface ─────────────────────────────────────────────
        // NOTE: The caller (MpvRenderView) sets vo=null BEFORE calling this,
        // but the vo change is processed asynchronously on the mpv core
        // thread. Flush it so the VO teardown has finished consuming the wid
        // jobject before we drop the ref.
        flushMpvCore(mpv);
        if (g_surface) {
            env->DeleteGlobalRef(g_surface);
            g_surface = nullptr;
        }
        LOGI("Surface detached (global ref released)");
    }
}

// ── Surface size change notification ─────────────────────────────────────────
// TextureView.onSurfaceTextureSizeChanged fires whenever React Native
// re-lays-out the view (e.g. on rotation). MPV's `wid` backend uses the
// underlying ANativeWindow directly, which already updates its dimensions
// when the surface size changes — MPV sees the new size on the next render
// frame and reflows its video output accordingly.
//
// The previous implementation set a fake `display-size` property, but that
// property doesn't exist in mpv's option table, so the call was a silent
// no-op (and a misleading log message). Now we just log the resize and let
// the surface update pipeline handle the rest.
//
// P5: a reviewer suggested re-triggering mpv's `videoReconfig` here. We
// deliberately don't. `videoReconfig` would force a full video output
// reconfigure — black flash + audio gap + subtitle re-render on every
// rotation. The ANativeWindow resize pipeline handles the smooth layout
// change without touching mpv's video chain, which is what the user
// actually wants.
extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativeSurfaceChanged(
    JNIEnv *env, jclass, jlong nativePtr, jint width, jint height) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    LOGI("Surface size changed: %dx%d (handled by ANativeWindow)", width, height);
}

// ── Playback Control ────────────────────────────────────────────────────────

static void nativeLoadFileInternal(JNIEnv *env, jlong nativePtr, jstring path, jstring requestId) {
    if (!path) {
        LOGE("nativeLoadFile rejected: path is null");
        return;
    }
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) {
        LOGE("nativeLoadFile rejected: mpv is not the active initialized handle");
        return;
    }

    mpv_handle *mpv = lease.get();
    const char *utfPath = env->GetStringUTFChars(path, nullptr);
    const char *utfRequestId = requestId ? env->GetStringUTFChars(requestId, nullptr) : nullptr;
    if (utfRequestId && utfRequestId[0] != '\0') {
        enqueueLoadRequest({utfRequestId, utfPath});
    } else {
        clearActiveLoadRequest();
    }
    const char *cmd[] = {"loadfile", utfPath, nullptr};
    const int result = mpv_command(mpv, cmd);
    if (result < 0 && utfRequestId && utfRequestId[0] != '\0') {
        dropLoadRequest(utfRequestId);
    }
    LOGI("[PlaybackTrace][Native][loadFile] result=%d pathLength=%zu token=%s",
         result, strlen(utfPath), utfRequestId && utfRequestId[0] != '\0' ? "present" : "none");
    if (utfRequestId) env->ReleaseStringUTFChars(requestId, utfRequestId);
    env->ReleaseStringUTFChars(path, utfPath);
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativeLoadFile(
    JNIEnv *env, jclass, jlong nativePtr, jstring path) {
    nativeLoadFileInternal(env, nativePtr, path, nullptr);
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativeLoadFileWithRequestId(
    JNIEnv *env, jclass, jlong nativePtr, jstring path, jstring requestId) {
    nativeLoadFileInternal(env, nativePtr, path, requestId);
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativePlay(JNIEnv *env, jclass, jlong nativePtr) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) {
        LOGE("[PlaybackTrace][Native][play] rejected inactive pointer");
        return;
    }
    mpv_handle *mpv = lease.get();
    int result = mpv_set_property_string(mpv, "pause", "no");
    LOGI("[PlaybackTrace][Native][play] pause=no result=%d", result);
    if (result < 0) LOGE("[PlaybackTrace][Native][play] error=%s", mpv_error_string(result));
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativePause(JNIEnv *env, jclass, jlong nativePtr) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) {
        LOGE("[PlaybackTrace][Native][pause] rejected inactive pointer");
        return;
    }
    mpv_handle *mpv = lease.get();
    int result = mpv_set_property_string(mpv, "pause", "yes");
    LOGI("[PlaybackTrace][Native][pause] pause=yes result=%d", result);
    if (result < 0) LOGE("[PlaybackTrace][Native][pause] error=%s", mpv_error_string(result));
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativeStop(JNIEnv *env, jclass, jlong nativePtr) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    mpv_handle *mpv = lease.get();
    const char *args[] = {"stop", nullptr};
    mpv_command(mpv, args);
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativeTogglePlayPause(
    JNIEnv *env, jclass, jlong nativePtr) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    mpv_handle *mpv = lease.get();
    int pause;
    mpv_get_property(mpv, "pause", MPV_FORMAT_FLAG, &pause);
    mpv_set_property_string(mpv, "pause", pause ? "no" : "yes");
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativeSeek(
    JNIEnv *env, jclass, jlong nativePtr, jdouble position) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    mpv_handle *mpv = lease.get();
    char cmd[64];
    snprintf(cmd, sizeof(cmd), "%.3f", position);
    const char *args[] = {"seek", cmd, "absolute", nullptr};
    mpv_command(mpv, args);
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativeSeekRelative(
    JNIEnv *env, jclass, jlong nativePtr, jdouble seconds) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    mpv_handle *mpv = lease.get();
    char cmd[64];
    snprintf(cmd, sizeof(cmd), "%.3f", seconds);
    const char *args[] = {"seek", cmd, "relative", nullptr};
    mpv_command(mpv, args);
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativeStepFrame(
    JNIEnv *env, jclass, jlong nativePtr, jint direction) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    mpv_handle *mpv = lease.get();
    if (direction > 0) {
        const char *args[] = {"frame-step", nullptr};
        mpv_command(mpv, args);
    } else {
        const char *args[] = {"frame-back-step", nullptr};
        mpv_command(mpv, args);
    }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_simba_player_mpv_MPVLib_nativeScreenshot(
    JNIEnv *env, jclass, jlong nativePtr, jstring outputPath) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return env->NewStringUTF("");
    mpv_handle *mpv = lease.get();
    const char *path = env->GetStringUTFChars(outputPath, nullptr);
    const char *args[] = {"screenshot-to-file", path, nullptr};
    mpv_command(mpv, args);
    env->ReleaseStringUTFChars(outputPath, path);
    return outputPath;
}

// ── Volume ──────────────────────────────────────────────────────────────────

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativeSetVolume(
    JNIEnv *env, jclass, jlong nativePtr, jdouble volume) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) {
        LOGE("[PlaybackTrace][Native][volume] rejected inactive pointer");
        return;
    }
    mpv_handle *mpv = lease.get();
    int result = mpv_set_property(mpv, "volume", MPV_FORMAT_DOUBLE, &volume);
    LOGI("[PlaybackTrace][Native][volume] volume=%f result=%d", volume, result);
    if (result < 0) LOGE("[PlaybackTrace][Native][volume] error=%s", mpv_error_string(result));
}

extern "C" JNIEXPORT jdouble JNICALL
Java_com_simba_player_mpv_MPVLib_nativeGetVolume(
    JNIEnv *env, jclass, jlong nativePtr) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return 0;
    mpv_handle *mpv = lease.get();
    double vol = 100;
    mpv_get_property(mpv, "volume", MPV_FORMAT_DOUBLE, &vol);
    return vol;
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativeSetMuted(
    JNIEnv *env, jclass, jlong nativePtr, jboolean muted) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    mpv_handle *mpv = lease.get();
    int flag = muted ? 1 : 0;
    mpv_set_property(mpv, "mute", MPV_FORMAT_FLAG, &flag);
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_simba_player_mpv_MPVLib_nativeGetMuted(
    JNIEnv *env, jclass, jlong nativePtr) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return JNI_FALSE;
    mpv_handle *mpv = lease.get();
    int muted = 0;
    mpv_get_property(mpv, "mute", MPV_FORMAT_FLAG, &muted);
    return muted ? JNI_TRUE : JNI_FALSE;
}

// ── Speed ───────────────────────────────────────────────────────────────────

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativeSetSpeed(
    JNIEnv *env, jclass, jlong nativePtr, jdouble speed) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    mpv_handle *mpv = lease.get();
    mpv_set_property(mpv, "speed", MPV_FORMAT_DOUBLE, &speed);
}

extern "C" JNIEXPORT jdouble JNICALL
Java_com_simba_player_mpv_MPVLib_nativeGetSpeed(
    JNIEnv *env, jclass, jlong nativePtr) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return 1.0;
    mpv_handle *mpv = lease.get();
    double speed = 1.0;
    mpv_get_property(mpv, "speed", MPV_FORMAT_DOUBLE, &speed);
    return speed;
}

// ── Loop ────────────────────────────────────────────────────────────────────

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativeSetLoopMode(
    JNIEnv *env, jclass, jlong nativePtr, jint mode) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    mpv_handle *mpv = lease.get();

    // Clear both native loop flags before enabling the requested mode. Without
    // this, switching from repeat-one to repeat-all leaves loop-file=inf set;
    // mpv then replays the current media item instead of advancing normally.
    const int clearFile = mpv_set_property_string(mpv, "loop-file", "no");
    const int clearPlaylist = mpv_set_property_string(mpv, "loop-playlist", "no");
    int enableResult = 0;
    if (mode == 1) {
        enableResult = mpv_set_property_string(mpv, "loop-file", "inf");
    } else if (mode == 2) {
        enableResult = mpv_set_property_string(mpv, "loop-playlist", "inf");
    }
    LOGI("[PlaybackTrace][Native][loop] mode=%d clearFile=%d clearPlaylist=%d enable=%d",
         mode, clearFile, clearPlaylist, enableResult);
}

extern "C" JNIEXPORT jint JNICALL
Java_com_simba_player_mpv_MPVLib_nativeGetLoopMode(
    JNIEnv *env, jclass, jlong nativePtr) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return 0;
    mpv_handle *mpv = lease.get();
    char *val = nullptr;
    if (mpv_get_property(mpv, "loop-file", MPV_FORMAT_STRING, &val) >= 0 && val) {
        const bool loopFile = strcmp(val, "inf") == 0 || strcmp(val, "yes") == 0;
        mpv_free(val);
        if (loopFile) return 1;
    }
    val = nullptr;
    if (mpv_get_property(mpv, "loop-playlist", MPV_FORMAT_STRING, &val) >= 0 && val) {
        const bool loopPlaylist = strcmp(val, "inf") == 0 || strcmp(val, "yes") == 0;
        mpv_free(val);
        if (loopPlaylist) return 2;
    }
    return 0;
}

// ── Playlist ────────────────────────────────────────────────────────────────

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativeLoadPlaylist(
    JNIEnv *env, jclass, jlong nativePtr, jobjectArray paths, jint startIndex) {
    if (!paths) return;
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    mpv_handle *mpv = lease.get();
    const char *clearArgs[] = {"playlist-clear", nullptr};
    mpv_command(mpv, clearArgs);
    jsize count = env->GetArrayLength(paths);
    for (jsize i = 0; i < count; i++) {
        jstring jpath = (jstring)env->GetObjectArrayElement(paths, i);
        const char *utfPath = env->GetStringUTFChars(jpath, nullptr);
        const char *cmd[] = {"loadfile", utfPath, i == 0 ? "replace" : "append", nullptr};
        int result = mpv_command(mpv, cmd);
        if (result < 0) {
            LOGE("playlist loadfile command failed at index %d: %s", static_cast<int>(i), mpv_error_string(result));
        }
        env->ReleaseStringUTFChars(jpath, utfPath);
    }
    if (startIndex > 0) {
        mpv_set_property(mpv, "playlist-pos", MPV_FORMAT_INT64, &startIndex);
    }
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativePlaylistNext(
    JNIEnv *env, jclass, jlong nativePtr) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    mpv_handle *mpv = lease.get();
    const char *args[] = {"playlist-next", nullptr};
    mpv_command(mpv, args);
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativePlaylistPrev(
    JNIEnv *env, jclass, jlong nativePtr) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    mpv_handle *mpv = lease.get();
    const char *args[] = {"playlist-prev", nullptr};
    mpv_command(mpv, args);
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativePlaylistRemove(
    JNIEnv *env, jclass, jlong nativePtr, jint index) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    mpv_handle *mpv = lease.get();
    char cmd[32];
    snprintf(cmd, sizeof(cmd), "%d", index);
    const char *args[] = {"playlist-remove", cmd, nullptr};
    mpv_command(mpv, args);
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativePlaylistShuffle(
    JNIEnv *env, jclass, jlong nativePtr) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    mpv_handle *mpv = lease.get();
    const char *args[] = {"playlist-shuffle", nullptr};
    mpv_command(mpv, args);
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativePlaylistClear(
    JNIEnv *env, jclass, jlong nativePtr) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    mpv_handle *mpv = lease.get();
    const char *clearArgs[] = {"playlist-clear", nullptr};
    mpv_command(mpv, clearArgs);
}

// ── Tracks ──────────────────────────────────────────────────────────────────

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativeSelectTrack(
    JNIEnv *env, jclass, jlong nativePtr, jint trackId) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    mpv_handle *mpv = lease.get();
    mpv_set_property(mpv, "vid", MPV_FORMAT_INT64, &trackId);
}

// ── Filters ─────────────────────────────────────────────────────────────────

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativeSetVideoFilter(
    JNIEnv *env, jclass, jlong nativePtr, jstring filter, jboolean enable) {
    if (!filter) return;
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    mpv_handle *mpv = lease.get();
    const char *utf = env->GetStringUTFChars(filter, nullptr);
    if (enable) {
        const char *cmd[] = {"vf", "add", utf, nullptr};
        mpv_command(mpv, cmd);
    } else {
        const char *cmd[] = {"vf", "del", utf, nullptr};
        mpv_command(mpv, cmd);
    }
    env->ReleaseStringUTFChars(filter, utf);
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativeSetAudioFilter(
    JNIEnv *env, jclass, jlong nativePtr, jstring filter, jboolean enable) {
    if (!filter) return;
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    mpv_handle *mpv = lease.get();
    const char *utf = env->GetStringUTFChars(filter, nullptr);
    if (enable) {
        const char *cmd[] = {"af", "add", utf, nullptr};
        mpv_command(mpv, cmd);
    } else {
        const char *cmd[] = {"af", "del", utf, nullptr};
        mpv_command(mpv, cmd);
    }
    env->ReleaseStringUTFChars(filter, utf);
}

// ── State Queries ────────────────────────────────────────────────────────────

extern "C" JNIEXPORT jdouble JNICALL
Java_com_simba_player_mpv_MPVLib_nativeGetPosition(
    JNIEnv *env, jclass, jlong nativePtr) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return 0;
    mpv_handle *mpv = lease.get();
    double pos = 0;
    int result = mpv_get_property(mpv, "time-pos", MPV_FORMAT_DOUBLE, &pos);
    LOGI("[PlaybackTrace][Native][getPosition] result=%d position=%f", result, pos);
    return pos;
}

extern "C" JNIEXPORT jdouble JNICALL
Java_com_simba_player_mpv_MPVLib_nativeGetDuration(
    JNIEnv *env, jclass, jlong nativePtr) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return 0;
    mpv_handle *mpv = lease.get();
    double dur = 0;
    int result = mpv_get_property(mpv, "duration", MPV_FORMAT_DOUBLE, &dur);
    LOGI("[PlaybackTrace][Native][getDuration] result=%d duration=%f", result, dur);
    return dur;
}
