#include <jni.h>
#include <android/log.h>
#include <string>
#include <cstring>
#include <client.h>
#include <native_state.h>

#define LOG_TAG "MpvProperty"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

// ── mpv_node → JSON string ──────────────────────────────────────────────────
// Simple recursive conversion; production code should use a proper JSON lib.

static void appendNode(std::string &out, const mpv_node *node) {
    switch (node->format) {
        case MPV_FORMAT_NONE:
            out += "null";
            break;
        case MPV_FORMAT_STRING:
            out += "\"";
            for (const char *p = node->u.string; *p; p++) {
                switch (*p) {
                    case '"':  out += "\\\""; break;
                    case '\\': out += "\\\\"; break;
                    case '\n': out += "\\n";  break;
                    case '\r': out += "\\r";  break;
                    case '\t': out += "\\t";  break;
                    default:   out += *p;     break;
                }
            }
            out += "\"";
            break;
        case MPV_FORMAT_FLAG:
            out += node->u.flag ? "true" : "false";
            break;
        case MPV_FORMAT_INT64: {
            char buf[32];
            snprintf(buf, sizeof(buf), "%lld", (long long)node->u.int64);
            out += buf;
            break;
        }
        case MPV_FORMAT_DOUBLE: {
            char buf[64];
            snprintf(buf, sizeof(buf), "%.6f", node->u.double_);
            out += buf;
            break;
        }
        case MPV_FORMAT_NODE_ARRAY: {
            out += "[";
            for (int i = 0; i < node->u.list->num; i++) {
                if (i > 0) out += ",";
                appendNode(out, &node->u.list->values[i]);
            }
            out += "]";
            break;
        }
        case MPV_FORMAT_NODE_MAP: {
            out += "{";
            for (int i = 0; i < node->u.list->num; i++) {
                if (i > 0) out += ",";
                out += "\"";
                out += node->u.list->keys[i];
                out += "\":";
                appendNode(out, &node->u.list->values[i]);
            }
            out += "}";
            break;
        }
        default:
            out += "null";
            break;
    }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_simba_player_mpv_MPVLib_nativeGetProperty(
    JNIEnv *env, jclass, jlong nativePtr, jstring name) {
    if (!name) return env->NewStringUTF("null");
    NativeMpvReadLease lease(nativePtr);
    if (!lease.valid()) return env->NewStringUTF("null");
    mpv_handle *mpv = lease.get();
    const char *propName = env->GetStringUTFChars(name, nullptr);

    mpv_node node;
    int err = mpv_get_property(mpv, propName, MPV_FORMAT_NODE, &node);
    env->ReleaseStringUTFChars(name, propName);

    if (err < 0) {
        return env->NewStringUTF("null");
    }

    std::string json;
    appendNode(json, &node);
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
    const char *json = valueJson ? env->GetStringUTFChars(valueJson, nullptr) : "null";

    // For simple types, use string form for simplicity
    mpv_set_property_string(mpv, propName, json);

    if (valueJson) env->ReleaseStringUTFChars(valueJson, json);
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
    // Use a hash of the property name as the reply_userdata
    uint64_t hash = 0;
    for (const char *p = propName; *p; p++)
        hash = hash * 31 + *p;
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
         propName, (unsigned long long)hash, format, err);

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
    uint64_t hash = 0;
    for (const char *p = propName; *p; p++)
        hash = hash * 31 + *p;
    mpv_unobserve_property(mpv, hash);
    LOGI("Unobserving property: %s", propName);
    env->ReleaseStringUTFChars(name, propName);
}
