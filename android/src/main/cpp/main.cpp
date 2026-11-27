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

void eventLoop(mpv_handle *mpv);
static HardwareProfile g_hardwareProfile{};

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
#ifdef SIMBA_MPV_TRACE
    mpv_request_log_messages(mpv, "v");
#else
    // Avoid flooding mpv_wait_event with verbose log events in release builds.
    // Runtime debugging can promote this via nativeSetLogLevel("v").
    mpv_request_log_messages(mpv, "error");
#endif
    g_initialized.store(true);
    g_running.store(true);
    if (pthread_create(&g_eventThread, nullptr, [](void *arg) -> void * {
            eventLoop(static_cast<mpv_handle *>(arg));
            return nullptr;
        }, mpv) != 0) {
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
    if (!g_cls_MPVLib) {
        LOGE("Failed to create GlobalRef for MPVLib");
        return JNI_ERR;
    }

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

// Scoped JNIEnv accessor that detaches automatically if it had to attach a
// native thread, preventing JVM thread-table leaks.
class ScopedJniEnv {
public:
    ScopedJniEnv() {
        if (!g_vm) return;
        const jint status = g_vm->GetEnv(reinterpret_cast<void **>(&env_), JNI_VERSION_1_6);
        if (status == JNI_OK) {
            return;
        }
        if (status == JNI_EDETACHED) {
            JavaVMAttachArgs args = {JNI_VERSION_1_6, "mpv-jni-call", nullptr};
            if (g_vm->AttachCurrentThread(&env_, &args) == JNI_OK) {
                attached_ = true;
            } else {
                env_ = nullptr;
            }
        }
    }

    ~ScopedJniEnv() {
        if (attached_ && g_vm) {
            g_vm->DetachCurrentThread();
        }
    }

    JNIEnv *get() const { return env_; }

private:
    JNIEnv *env_ = nullptr;
    bool attached_ = false;
};

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
    // FIRE-AND-FORGET BY DESIGN - not an oversight.
    //
    // `ignore` is a no-op command, so its return value carries no
    // information about whether the flush worked: the whole point of
    // this call is that it BLOCKS until mpv has drained its core
    // queue. Reporting a failure here would be reporting an error we
    // invented, so the result is deliberately not acted on.
    //
    // It is still CAPTURED, because the file-wide invariant is that no
    // mpv_command() call in this file throws its return value away
    // (see runMpvCommand below, and the guard test that pins it).
    const int result = mpv_command(mpv, cmd);
    (void)result;
}

// ── Helper: report a refused mpv command to JS ────────────────────────────
//
// mpv reports a command failure through the RETURN VALUE of
// mpv_command(): 0 is success, a negative value is one of mpv's own
// error codes (`include/mpv/client.h`, `mpv_error`) -
// MPV_ERROR_COMMAND (-12) for a command the core refuses,
// MPV_ERROR_LOADING_FAILED (-13) for a source it cannot open.
//
// Every command in this file used to THROW THAT VALUE AWAY. A refused
// seek was therefore indistinguishable from a completed one: the scrub
// bar stayed where it was, no error was raised anywhere, and the app
// believed the seek had worked. That is the silent lie B-007 is about.
//
// The failure now travels the EXISTING error path - the same
// MPVLib.onNativeError(code, recoverable, message, requestId) callback
// that event.cpp uses for mpv's own failures - so it lands on the same
// `onError` event, with the same `{code, codeName, nativeCode,
// recoverable, message}` payload, and the same stable contract the
// Kotlin bridge already maps (-12 -> "E_COMMAND_FAILED" -> 3016). No new
// event, no new channel, no new error shape.
//
// `recoverable = true` is the TRUTH here: a refused command does not
// end playback - mpv keeps playing whatever it was playing. The app
// renders a terminal error card only for `recoverable === false`, so
// the failure is REPORTED rather than hidden, and it never paints over
// a picture that is still moving.
static void reportCommandFailure(const char *command, int result, const char *detail) {
    const char *reason = mpv_error_string(result);
    LOGE("[PlaybackTrace][Native][command] '%s' failed: %s (code=%d)%s%s",
         command, reason, result,
         (detail && detail[0]) ? " - " : "", (detail && detail[0]) ? detail : "");
    ScopedJniEnv scopedEnv;
    JNIEnv *env = scopedEnv.get();
    if (!env || !g_cls_MPVLib || !g_mid_onError) return;
    char message[192];
    snprintf(message, sizeof(message), "mpv command '%s' failed: %s%s%s",
             command, reason,
             (detail && detail[0]) ? " - " : "", (detail && detail[0]) ? detail : "");
    jstring jMessage = env->NewStringUTF(message);
    jstring jRequestId = env->NewStringUTF("");
    env->CallStaticVoidMethod(g_cls_MPVLib, g_mid_onError,
                              static_cast<jint>(result),
                              static_cast<jboolean>(true),
                              jMessage, jRequestId);
    if (env->ExceptionCheck()) {
        LOGE("onNativeError raised an exception; clearing it on the calling thread");
        env->ExceptionClear();
    }
    if (jMessage) env->DeleteLocalRef(jMessage);
    if (jRequestId) env->DeleteLocalRef(jRequestId);
}

// Runs an mpv command and REPORTS a refusal instead of swallowing it.
//
// Every mpv_command() call in this file goes through here (or captures
// its result inline), so "the command was refused" can never again be
// indistinguishable from "the command worked".
//
// Returns mpv's own return value so a caller that has to act on it can:
// nativeScreenshot hands JS a path, and a path to a file that was never
// written is a lie of the same family.
static int runMpvCommand(mpv_handle *mpv, const char **args,
                         const char *command, const char *detail) {
    const int result = mpv_command(mpv, args);
    if (result < 0) {
        reportCommandFailure(command, result, detail);
    }
    return result;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

static jlong nativeCreateInternal(
    JNIEnv *env,
    jstring caFilePath,
    int64_t totalRamMbHint,
    int cpuCoresHint,
    int screenWidthPx,
    int screenHeightPx,
    int glEsMajor,
    bool isLowRamHint) {
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

    // Audio overlays do not mount a video surface. Keep video output disabled
    // until a surface is explicitly attached by MpvRenderView.
    mpv_set_option_string(mpv, "vo", "null");
    mpv_set_option_string(mpv, "gpu-api", "opengl");
    mpv_set_option_string(mpv, "audio-device-auto", "yes");

    // Hardware-adaptive tuning (v3.5.0): classify device by real RAM, CPU cores,
    // display resolution, and GLES version so budget/low-GPU phones run smooth
    // without OOM/throttling while flagship phones get cinema-grade shaders.
    g_hardwareProfile = detectHardwareProfile(
        totalRamMbHint,
        cpuCoresHint,
        screenWidthPx,
        screenHeightPx,
        glEsMajor,
        isLowRamHint);
    applyHardwareTuning(mpv, g_hardwareProfile, /*isPreInit=*/true);

    // Android libmpv builds do not consistently discover the platform trust
    // store. Supply the app-bundled Mozilla CA bundle while keeping TLS
    // verification enabled for HTTPS streams.
    if (caFilePath) {
        const char *caPath = env->GetStringUTFChars(caFilePath, nullptr);
        if (caPath && caPath[0] != '\0') {
            int optionResult = mpv_set_option_string(mpv, "tls-ca-file", caPath);
            LOGI("[PlaybackTrace][Native][create] option tls-ca-file=%s result=%d", caPath, optionResult);
            env->ReleaseStringUTFChars(caFilePath, caPath);
        } else {
            LOGE("[PlaybackTrace][Native][create] empty CA bundle path; HTTPS validation may fail");
            if (caPath) env->ReleaseStringUTFChars(caFilePath, caPath);
        }
    } else {
        LOGE("[PlaybackTrace][Native][create] null CA bundle path; HTTPS validation may fail");
    }
    mpv_set_option_string(mpv, "tls-verify", "yes");
    mpv_set_option_string(mpv, "keep-open", "yes");
    mpv_set_option_string(mpv, "pause", "no");
    mpv_set_option_string(mpv, "demuxer-termination-timeout", "10");
    mpv_set_option_string(mpv, "prefetch-playlist", "yes");

    LOGI("[PlaybackTrace][Native][create] mpv_create succeeded handle=%p", mpv);
    g_mpv = mpv;
    if (!initializeMpv(mpv)) {
        g_mpv = nullptr;
        return 0;
    }
    LOGI("mpv instance created and initialized without a required surface");
    return reinterpret_cast<jlong>(mpv);
}

extern "C" JNIEXPORT jlong JNICALL
Java_com_simba_player_mpv_MPVLib_nativeCreate(JNIEnv *env, jclass, jstring caFilePath) {
    return nativeCreateInternal(env, caFilePath, 0, 0, 0, 0, 3, false);
}

extern "C" JNIEXPORT jlong JNICALL
Java_com_simba_player_mpv_MPVLib_nativeCreateWithHardwareInfo(
    JNIEnv *env,
    jclass,
    jstring caFilePath,
    jlong totalRamMb,
    jint cpuCores,
    jint screenWidthPx,
    jint screenHeightPx,
    jint glEsMajor,
    jboolean isLowRam) {
    return nativeCreateInternal(
        env,
        caFilePath,
        static_cast<int64_t>(totalRamMb),
        static_cast<int>(cpuCores),
        static_cast<int>(screenWidthPx),
        static_cast<int>(screenHeightPx),
        static_cast<int>(glEsMajor),
        isLowRam == JNI_TRUE);
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativeSetPerformanceProfile(
    JNIEnv *env, jclass, jlong nativePtr, jstring profileName) {
    if (!profileName) return;
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    mpv_handle *mpv = lease.get();
    const char *utf = env->GetStringUTFChars(profileName, nullptr);
    if (!utf) return;

    HardwareProfile next = g_hardwareProfile;
    if (strcmp(utf, "low") == 0 || strcmp(utf, "battery-saver") == 0) {
        next.tier = DeviceTier::Low;
    } else if (strcmp(utf, "mid") == 0 || strcmp(utf, "balanced") == 0) {
        next.tier = DeviceTier::Mid;
    } else if (strcmp(utf, "high") == 0 || strcmp(utf, "high-quality") == 0) {
        next.tier = DeviceTier::High;
    } else {
        // "auto" — re-detect from hardware facts
        next = detectHardwareProfile(
            g_hardwareProfile.totalRamMb,
            g_hardwareProfile.cpuCores,
            g_hardwareProfile.screenWidthPx,
            g_hardwareProfile.screenHeightPx,
            g_hardwareProfile.glEsMajor,
            g_hardwareProfile.isLowRam);
    }
    env->ReleaseStringUTFChars(profileName, utf);

    g_hardwareProfile = next;
    applyHardwareTuning(mpv, g_hardwareProfile, /*isPreInit=*/false);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_simba_player_mpv_MPVLib_nativeGetHardwareProfile(
    JNIEnv *env, jclass, jlong nativePtr) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) {
        const HardwareProfile fallback = detectHardwareProfile(0, 0, 0, 0, 3, false);
        return env->NewStringUTF(hardwareProfileToJson(fallback).c_str());
    }
    return env->NewStringUTF(hardwareProfileToJson(g_hardwareProfile).c_str());
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativeSetLogLevel(
    JNIEnv *env, jclass, jlong nativePtr, jstring level) {
    if (!level) return;
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    mpv_handle *mpv = lease.get();
    const char *utf = env->GetStringUTFChars(level, nullptr);
    if (!utf) return;
    mpv_request_log_messages(mpv, utf);
    env->ReleaseStringUTFChars(level, utf);
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
        if (env && g_mid_onEvent) {
            jstring jName = env->NewStringUTF("surfaceAttached");
            jstring jPayload = env->NewStringUTF("{}");
            callStaticJavaVoid(env, g_mid_onEvent, jName, jPayload);
            if (env->ExceptionCheck()) env->ExceptionClear();
            if (jName) env->DeleteLocalRef(jName);
            if (jPayload) env->DeleteLocalRef(jPayload);
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

// The PER-FILE options argument.
//
// mpv 0.41's `loadfile` command is
//
//     loadfile <url> [<flags> [<index> [<options>]]]
//
// and `<options>` is a key/value list that mpv turns into FILE-LOCAL
// options: mpv's `player/command.c` (`cmd_loadfile`) turns every pair
// into a playlist-entry param, and `player/loadfile.c`
// (`load_per_file_options`) applies every param with
// `M_SET_OPTION_FLAG_FILE_LOCAL`.
//
// That is the whole reason the options exist. A GLOBAL
// `mpv_set_option_string("user-agent", ...)` would leak the header onto
// every LATER file - the app's own music, a podcast, anything - and it
// would be read when the NEXT stream opens, not the one it was set for.
// The per-file form is the only one that means "this file".
//
// `flags` and `index` are passed explicitly because the options argument
// is positional: they are mpv's own defaults ("replace" is the first
// choice of the flags enum, and the index default is -1), so naming them
// changes nothing and leaves the argument order unambiguous.
static void nativeLoadFileInternal(JNIEnv *env, jlong nativePtr, jstring path,
                                     jstring requestId, jstring options) {
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
    const char *utfOptions = options ? env->GetStringUTFChars(options, nullptr) : nullptr;
    if (utfRequestId && utfRequestId[0] != '\0') {
        enqueueLoadRequest({utfRequestId, utfPath});
    } else {
        clearActiveLoadRequest();
    }
    int result;
    if (utfOptions && utfOptions[0] != '\0') {
        const char *cmd[] = {"loadfile", utfPath, "replace", "-1", utfOptions, nullptr};
        result = mpv_command(mpv, cmd);
    } else {
        const char *cmd[] = {"loadfile", utfPath, nullptr};
        result = mpv_command(mpv, cmd);
    }
    if (result < 0 && utfRequestId && utfRequestId[0] != '\0') {
        dropLoadRequest(utfRequestId);
    }
    LOGI("[PlaybackTrace][Native][loadFile] result=%d pathLength=%zu token=%s options=%s",
         result, strlen(utfPath), utfRequestId && utfRequestId[0] != '\0' ? "present" : "none",
         utfOptions && utfOptions[0] != '\0' ? "present" : "none");
    if (utfRequestId) env->ReleaseStringUTFChars(requestId, utfRequestId);
    if (utfOptions) env->ReleaseStringUTFChars(options, utfOptions);
    env->ReleaseStringUTFChars(path, utfPath);
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativeLoadFile(
    JNIEnv *env, jclass, jlong nativePtr, jstring path) {
    nativeLoadFileInternal(env, nativePtr, path, nullptr, nullptr);
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativeLoadFileWithRequestId(
    JNIEnv *env, jclass, jlong nativePtr, jstring path, jstring requestId) {
    nativeLoadFileInternal(env, nativePtr, path, requestId, nullptr);
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativeLoadFileWithOptions(
    JNIEnv *env, jclass, jlong nativePtr, jstring path, jstring options) {
    nativeLoadFileInternal(env, nativePtr, path, nullptr, options);
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
    runMpvCommand(mpv, args, "stop", nullptr);
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativeTogglePlayPause(
    JNIEnv *env, jclass, jlong nativePtr) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    mpv_handle *mpv = lease.get();
    int pause = 0;
    if (mpv_get_property(mpv, "pause", MPV_FORMAT_FLAG, &pause) < 0) {
        return;
    }
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
    // B-007: the return value used to be thrown away here, so a seek
    // mpv refused was indistinguishable from a seek that worked. The
    // scrub bar simply did not move and nothing was reported.
    runMpvCommand(mpv, args, "seek", cmd);
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
    // B-007: same defect as the absolute seek above - the refusal used
    // to be discarded, so a relative skip that did not happen looked
    // exactly like one that did.
    char detail[64];
    snprintf(detail, sizeof(detail), "relative %+.3f s", seconds);
    runMpvCommand(mpv, args, "seek", detail);
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativeStepFrame(
    JNIEnv *env, jclass, jlong nativePtr, jint direction) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    mpv_handle *mpv = lease.get();
    if (direction > 0) {
        const char *args[] = {"frame-step", nullptr};
        runMpvCommand(mpv, args, "frame-step", nullptr);
    } else {
        const char *args[] = {"frame-back-step", nullptr};
        runMpvCommand(mpv, args, "frame-back-step", nullptr);
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
    const int result = runMpvCommand(mpv, args, "screenshot-to-file", path);
    env->ReleaseStringUTFChars(outputPath, path);
    // A refused screenshot wrote NO file. Returning the path anyway
    // would hand JS a path to a file that does not exist - the same
    // silent lie this change removes everywhere else. The empty string
    // is what this method already returns when the handle is not
    // usable, and it is what the no-op JS bridge returns too.
    if (result < 0) return env->NewStringUTF("");
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
    // B-007: the clear used to discard mpv's verdict, so a playlist
    // that was NOT cleared looked exactly like one that was.
    runMpvCommand(mpv, clearArgs, "playlist-clear", nullptr);
    jsize count = env->GetArrayLength(paths);
    for (jsize i = 0; i < count; i++) {
        jstring jpath = static_cast<jstring>(env->GetObjectArrayElement(paths, i));
        if (!jpath) continue;
        const char *utfPath = env->GetStringUTFChars(jpath, nullptr);
        if (utfPath) {
            const char *cmd[] = {"loadfile", utfPath, i == 0 ? "replace" : "append", nullptr};
            int result = mpv_command(mpv, cmd);
            if (result < 0) {
                LOGE("playlist loadfile command failed at index %d: %s", static_cast<int>(i), mpv_error_string(result));
            }
            env->ReleaseStringUTFChars(jpath, utfPath);
        }
        env->DeleteLocalRef(jpath);
    }
    if (startIndex > 0) {
        int64_t pos = static_cast<int64_t>(startIndex);
        mpv_set_property(mpv, "playlist-pos", MPV_FORMAT_INT64, &pos);
    }
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativePlaylistNext(
    JNIEnv *env, jclass, jlong nativePtr) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    mpv_handle *mpv = lease.get();
    const char *args[] = {"playlist-next", nullptr};
    runMpvCommand(mpv, args, "playlist-next", nullptr);
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativePlaylistPrev(
    JNIEnv *env, jclass, jlong nativePtr) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    mpv_handle *mpv = lease.get();
    const char *args[] = {"playlist-prev", nullptr};
    runMpvCommand(mpv, args, "playlist-prev", nullptr);
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
    runMpvCommand(mpv, args, "playlist-remove", cmd);
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativePlaylistShuffle(
    JNIEnv *env, jclass, jlong nativePtr) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    mpv_handle *mpv = lease.get();
    const char *args[] = {"playlist-shuffle", nullptr};
    runMpvCommand(mpv, args, "playlist-shuffle", nullptr);
}

extern "C" JNIEXPORT void JNICALL
Java_com_simba_player_mpv_MPVLib_nativePlaylistClear(
    JNIEnv *env, jclass, jlong nativePtr) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return;
    mpv_handle *mpv = lease.get();
    const char *clearArgs[] = {"playlist-clear", nullptr};
    // B-007: the third command the register named. The verdict mpv
    // returned was discarded, so a playlist that was NOT cleared was
    // indistinguishable from one that was.
    runMpvCommand(mpv, clearArgs, "playlist-clear", nullptr);
}

// `nativeSelectTrack()` was REMOVED — it carried no track type, and it
// hardcoded mpv's "vid" property, so selecting a subtitle track retargeted
// the VIDEO track. `setTrack(type, trackId)` in MpvBridgeModule.kt routes to
// vid/aid/sid via `nativeSetPropertyString` instead.

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
        runMpvCommand(mpv, cmd, "vf add", utf);
    } else {
        const char *cmd[] = {"vf", "del", utf, nullptr};
        runMpvCommand(mpv, cmd, "vf del", utf);
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
        runMpvCommand(mpv, cmd, "af add", utf);
    } else {
        const char *cmd[] = {"af", "del", utf, nullptr};
        runMpvCommand(mpv, cmd, "af del", utf);
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
    mpv_get_property(mpv, "time-pos", MPV_FORMAT_DOUBLE, &pos);
    return pos;
}

extern "C" JNIEXPORT jdouble JNICALL
Java_com_simba_player_mpv_MPVLib_nativeGetDuration(
    JNIEnv *env, jclass, jlong nativePtr) {
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return 0;
    mpv_handle *mpv = lease.get();
    double dur = 0;
    mpv_get_property(mpv, "duration", MPV_FORMAT_DOUBLE, &dur);
    return dur;
}
