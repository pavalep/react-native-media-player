#include <jni.h>
#include <android/log.h>
#include <string>
#include <cstring>
#include <cstdio>
#include <client.h>
#include <native_state.h>

#define LOG_TAG "MpvEvent"
#define TRACEI(...) do { } while (0)
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

// ── External globals set by main.cpp ────────────────────────────────────────

extern JavaVM *g_vm;

extern jclass g_cls_MPVLib;
extern jmethodID g_mid_onEvent;
extern jmethodID g_mid_onPropertyChanged;
extern jmethodID g_mid_onError;

// ── Helper: attach current thread to JVM and call static void method ────────

static std::string jsonQuote(const char *value) {
    std::string out;
    out.push_back(34);
    if (value) {
        for (const unsigned char *p = reinterpret_cast<const unsigned char *>(value); *p; ++p) {
            switch (*p) {
                case 92:
                    out.push_back(92);
                    out.push_back(92);
                    break;
                case 34:
                    out.push_back(92);
                    out.push_back(34);
                    break;
                case 8:
                    out.push_back(92);
                    out.push_back('b');
                    break;
                case 12:
                    out.push_back(92);
                    out.push_back('f');
                    break;
                case 10:
                    out.push_back(92);
                    out.push_back('n');
                    break;
                case 13:
                    out.push_back(92);
                    out.push_back('r');
                    break;
                case 9:
                    out.push_back(92);
                    out.push_back('t');
                    break;
                default:
                    if (*p < 0x20) {
                        char escaped[7];
                        out.push_back(92);
                        snprintf(escaped, sizeof(escaped), "u%04x", *p);
                        out += escaped;
                    } else {
                        out += static_cast<char>(*p);
                    }
            }
        }
    }
    out.push_back(34);
    return out;
}

static std::string jsonNode(const mpv_node *node) {
    if (!node) return "null";

    switch (node->format) {
        case MPV_FORMAT_NONE:
            return "null";
        case MPV_FORMAT_STRING:
            return jsonQuote(node->u.string);
        case MPV_FORMAT_FLAG:
            return node->u.flag ? "true" : "false";
        case MPV_FORMAT_INT64: {
            char buf[32];
            snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(node->u.int64));
            return buf;
        }
        case MPV_FORMAT_DOUBLE: {
            char buf[64];
            snprintf(buf, sizeof(buf), "%.6f", node->u.double_);
            return buf;
        }
        case MPV_FORMAT_BYTE_ARRAY:
            // Buffering properties are node/string/number values. Do not
            // expose arbitrary binary data as malformed JSON.
            return "null";
        case MPV_FORMAT_NODE_ARRAY: {
            std::string out = "[";
            const mpv_node_list *list = node->u.list;
            if (list) {
                for (int i = 0; i < list->num; ++i) {
                    if (i > 0) out += ",";
                    out += jsonNode(&list->values[i]);
                }
            }
            out += "]";
            return out;
        }
        case MPV_FORMAT_NODE_MAP: {
            std::string out = "{";
            const mpv_node_list *list = node->u.list;
            if (list) {
                for (int i = 0; i < list->num; ++i) {
                    if (i > 0) out += ",";
                    out += jsonQuote(list->keys && list->keys[i] ? list->keys[i] : "");
                    out += ":";
                    out += jsonNode(&list->values[i]);
                }
            }
            out += "}";
            return out;
        }
        default:
            return "null";
    }
}

static thread_local JNIEnv *g_eventEnv = nullptr;
static thread_local bool g_eventThreadAttached = false;

static JNIEnv *getEventEnv() {
    if (g_eventEnv) return g_eventEnv;
    if (!g_vm) return nullptr;
    const int getEnvStat = g_vm->GetEnv(reinterpret_cast<void **>(&g_eventEnv), JNI_VERSION_1_6);
    if (getEnvStat == JNI_OK) return g_eventEnv;
    if (getEnvStat != JNI_EDETACHED) {
        LOGE("GetEnv failed for mpv event thread");
        g_eventEnv = nullptr;
        return nullptr;
    }
    JavaVMAttachArgs args = {JNI_VERSION_1_6, "mpv-event-thread", nullptr};
    if (g_vm->AttachCurrentThread(&g_eventEnv, &args) != JNI_OK) {
        LOGE("Failed to attach mpv event thread to JVM");
        g_eventEnv = nullptr;
        return nullptr;
    }
    g_eventThreadAttached = true;
    return g_eventEnv;
}

static void releaseEventEnv() {
    if (g_eventThreadAttached && g_vm) {
        g_vm->DetachCurrentThread();
    }
    g_eventEnv = nullptr;
    g_eventThreadAttached = false;
}

static void clearJavaException(JNIEnv *env) {
    if (env && env->ExceptionCheck()) {
        LOGE("Java callback raised an exception; clearing it on the native event thread");
        env->ExceptionClear();
    }
}

static void callJavaEvent(const char *event, const char *jsonPayload) {
    JNIEnv *env = getEventEnv();
    if (!env || !g_cls_MPVLib || !g_mid_onEvent) return;
    jstring jEvent = env->NewStringUTF(event ? event : "");
    jstring jPayload = env->NewStringUTF(jsonPayload ? jsonPayload : "{}");
    env->CallStaticVoidMethod(g_cls_MPVLib, g_mid_onEvent, jEvent, jPayload);
    clearJavaException(env);
    if (jEvent) env->DeleteLocalRef(jEvent);
    if (jPayload) env->DeleteLocalRef(jPayload);
}

static void callJavaPropertyChanged(const char *name, const char *jsonValue) {
    JNIEnv *env = getEventEnv();
    if (!env || !g_cls_MPVLib || !g_mid_onPropertyChanged) return;
    jstring jName = env->NewStringUTF(name ? name : "");
    jstring jValue = env->NewStringUTF(jsonValue ? jsonValue : "null");
    env->CallStaticVoidMethod(g_cls_MPVLib, g_mid_onPropertyChanged, jName, jValue);
    clearJavaException(env);
    if (jName) env->DeleteLocalRef(jName);
    if (jValue) env->DeleteLocalRef(jValue);
}

static void callJavaError(int code, const char *message, const char *requestId, bool recoverable) {
    JNIEnv *env = getEventEnv();
    if (!env || !g_cls_MPVLib || !g_mid_onError) return;
    jstring jMsg = env->NewStringUTF(message ? message : "mpv error");
    jstring jRequestId = env->NewStringUTF(requestId ? requestId : "");
    env->CallStaticVoidMethod(g_cls_MPVLib, g_mid_onError, code, (jboolean)recoverable, jMsg, jRequestId);
    clearJavaException(env);
    if (jMsg) env->DeleteLocalRef(jMsg);
    if (jRequestId) env->DeleteLocalRef(jRequestId);
}

static std::string currentMpvPath() {
    if (!g_mpv) return {};
    char *path = nullptr;
    std::string resolvedPath;
    if (mpv_get_property(g_mpv, "path", MPV_FORMAT_STRING, &path) >= 0 && path) {
        resolvedPath = path;
        mpv_free(path);
    }
    return resolvedPath;
}

// ── Event Loop ──────────────────────────────────────────────────────────────

void eventLoop() {
    TRACEI("Event loop started");

    while (g_running.load()) {
        mpv_event *event = mpv_wait_event(g_mpv, -1);
        if (!event) {
            LOGE("[PlaybackTrace][Native][eventLoop] mpv_wait_event returned null");
            continue;
        }
        TRACEI("[PlaybackTrace][Native][eventLoop] event_id=%d error=%d", event->event_id, event->error);

        switch (event->event_id) {
            case MPV_EVENT_NONE:
                break;

            case MPV_EVENT_SHUTDOWN:
                TRACEI("MPV_EVENT_SHUTDOWN");
                g_running.store(false);
                break;

            case MPV_EVENT_FILE_LOADED: {
                TRACEI("MPV_EVENT_FILE_LOADED");
                char *path = nullptr;
                std::string resolvedPath;
                if (g_mpv && mpv_get_property(g_mpv, "path", MPV_FORMAT_STRING, &path) >= 0 && path) {
                    resolvedPath = path;
                    mpv_free(path);
                }
                const std::string payload = consumeFileLoadedPayload(resolvedPath);
                LOGI("[PlaybackTrace][Native][fileLoaded] pathLength=%zu token=%s payloadLength=%zu",
                     resolvedPath.size(),
                     payload.find("requestId") != std::string::npos ? "matched" : "none",
                     payload.size());
                callJavaEvent("fileLoaded", payload.c_str());
                break;
            }

            case MPV_EVENT_START_FILE:
                TRACEI("MPV_EVENT_START_FILE");
                callJavaEvent("startFile", "{}");
                break;

            case MPV_EVENT_END_FILE: {
                auto *prop = (mpv_event_end_file *)event->data;
                LOGE("[PlaybackTrace][Native][eventLoop] MPV_EVENT_END_FILE reason=%d error=%d", prop ? prop->reason : -1, prop ? prop->error : -1);
                const int reason = prop ? prop->reason : -1;
                const int error = prop ? prop->error : -1;
                const std::string resolvedPath = currentMpvPath();
                const std::string requestId = activeLoadRequestId(resolvedPath);
                const std::string payload = "{\"reason\":" + std::to_string(reason)
                    + ",\"error\":" + std::to_string(error)
                    + ",\"requestId\":" + jsonQuote(requestId.c_str()) + "}";
                callJavaEvent("endFile", payload.c_str());
                // Only a non-zero end-file error is a terminal playback failure.
                // MPV log lines at level `error` can be recoverable decoder noise
                // (for example mjpeg overread warnings) and must not trigger a
                // JavaScript reload of an already-playing stream.
                if (prop && prop->error != 0) {
                    char errorMessage[160];
                    snprintf(errorMessage, sizeof(errorMessage),
                             "mpv end-file error=%d reason=%d", prop->error, prop->reason);
                    // M5: a non-zero end-file error means the stream is broken
                    // (corrupt file, network drop, unsupported codec). The user
                    // cannot "retry" their way out of these without picking a
                    // different file. Mark non-recoverable so the JS layer
                    // shows the "Pick another" affordance instead of an auto-retry.
                    callJavaError(prop->error, errorMessage, requestId.c_str(), /*recoverable=*/false);
                }
                break;
            }

            case MPV_EVENT_PLAYBACK_RESTART:
                TRACEI("[PlaybackTrace][Native][eventLoop] MPV_EVENT_PLAYBACK_RESTART");
                callJavaEvent("playbackRestart", "{}");
                break;

            case MPV_EVENT_SEEK:
                TRACEI("[PlaybackTrace][Native][eventLoop] MPV_EVENT_SEEK");
                callJavaEvent("seek", "{}");
                break;

            case MPV_EVENT_QUEUE_OVERFLOW:
                LOGE("MPV_EVENT_QUEUE_OVERFLOW");
                callJavaEvent("queueOverflow", "{}");
                break;

            case MPV_EVENT_PROPERTY_CHANGE: {
                auto *prop = (mpv_event_property *)event->data;
                if (!prop || !prop->name) {
                    LOGE("[PlaybackTrace][Native][eventLoop] property event missing data");
                    break;
                }
                if (prop->format == MPV_FORMAT_NONE) {
                    TRACEI("[PlaybackTrace][Native][eventLoop] property=%s format=NONE", prop->name);
                    break;
                }
                std::string json;
                if (prop->format == MPV_FORMAT_NODE && prop->data) {
                    json = jsonNode(static_cast<const mpv_node *>(prop->data));
                } else if (prop->format == MPV_FORMAT_STRING && prop->data) {
                    json = jsonQuote(static_cast<const char *>(prop->data));
                } else if (prop->format == MPV_FORMAT_FLAG && prop->data) {
                    json = *static_cast<const int *>(prop->data) ? "true" : "false";
                } else if (prop->format == MPV_FORMAT_DOUBLE && prop->data) {
                    char buf[64];
                    snprintf(buf, sizeof(buf), "%.6f", *static_cast<const double *>(prop->data));
                    json = buf;
                } else if (prop->format == MPV_FORMAT_INT64 && prop->data) {
                    char buf[32];
                    snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(*static_cast<const int64_t *>(prop->data)));
                    json = buf;
                } else {
                    json = "null";
                }
                TRACEI("[PlaybackTrace][Native][property] name=%s format=%d value=%s", prop->name, prop->format, json.c_str());
                callJavaPropertyChanged(prop->name, json.c_str());
                break;
            }

            case MPV_EVENT_LOG_MESSAGE: {
                auto *log = (mpv_event_log_message *)event->data;
                TRACEI("[PlaybackTrace][Native][mpv-log] prefix=%s level=%s text=%s", log && log->prefix ? log->prefix : "", log && log->level ? log->level : "", log && log->text ? log->text : "");
                __android_log_print(ANDROID_LOG_DEBUG, "mpv", "[%s] %s: %s",
                                    log->prefix, log->level, log->text);
                // Do not promote every `error`-level mpv log to a playback
                // failure. Decoder warnings such as recoverable mjpeg overread
                // messages are common during network playback and previously
                // caused the JS controller to reload the stream mid-playback.
                // Terminal failures are reported through MPV_EVENT_END_FILE.
                if (log->level && strcmp(log->level, "fatal") == 0) {
                    const std::string requestId = activeLoadRequestId(currentMpvPath());
                    // M5: mpv only promotes "fatal"-level log lines to a JS
                    // error. Fatal decoder/IO failures are not retryable
                    // without a different source, so we mark them
                    // non-recoverable.
                    callJavaError(-1, log->text ? log->text : "mpv fatal error", requestId.c_str(), /*recoverable=*/false);
                }
                break;
            }
            case MPV_EVENT_CLIENT_MESSAGE:
                // Not used
                break;
            case MPV_EVENT_VIDEO_RECONFIG:
                TRACEI("MPV_EVENT_VIDEO_RECONFIG");
                callJavaEvent("videoReconfig", "{}");
                break;
            case MPV_EVENT_AUDIO_RECONFIG:
                TRACEI("[PlaybackTrace][Native][eventLoop] MPV_EVENT_AUDIO_RECONFIG");
                callJavaEvent("audioReconfig", "{}");
                break;

            default:
                TRACEI("Unhandled mpv event: %d", event->event_id);
                break;
        }
    }

    releaseEventEnv();
}