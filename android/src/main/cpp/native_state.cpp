#include "native_state.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <mutex>
#include <unistd.h>
#include <android/log.h>

#define HW_LOG_TAG "MpvHardware"
#define HW_LOGI(...) __android_log_print(ANDROID_LOG_INFO, HW_LOG_TAG, __VA_ARGS__)

namespace {
std::mutex g_loadQueueMutex;
std::deque<PendingLoadRequest> g_pendingLoads;
PendingLoadRequest g_activeLoad{};

void setMpvConfig(mpv_handle *mpv, const char *name, const char *value, bool isPreInit) {
    if (!mpv || !name || !value) return;
    if (isPreInit) {
        mpv_set_option_string(mpv, name, value);
    } else {
        mpv_set_property_string(mpv, name, value);
    }
}
} // namespace

// ── Shared hardened JSON serializer ────────────────────────────────────────

std::string jsonQuote(const char *value) {
    std::string out;
    out.push_back('"');
    if (value) {
        for (const unsigned char *p = reinterpret_cast<const unsigned char *>(value); *p; ++p) {
            switch (*p) {
                case '\\': out += "\\\\"; break;
                case '"':  out += "\\\""; break;
                case '\b': out += "\\b";  break;
                case '\f': out += "\\f";  break;
                case '\n': out += "\\n";  break;
                case '\r': out += "\\r";  break;
                case '\t': out += "\\t";  break;
                default:
                    if (*p < 0x20) {
                        char escaped[8];
                        snprintf(escaped, sizeof(escaped), "\\u%04x", *p);
                        out += escaped;
                    } else {
                        out.push_back(static_cast<char>(*p));
                    }
                    break;
            }
        }
    }
    out.push_back('"');
    return out;
}

std::string jsonQuote(const std::string &value) {
    return jsonQuote(value.c_str());
}

std::string jsonNode(const mpv_node *node) {
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
            if (!std::isfinite(node->u.double_)) {
                return "null";
            }
            char buf[64];
            snprintf(buf, sizeof(buf), "%.6f", node->u.double_);
            return buf;
        }
        case MPV_FORMAT_BYTE_ARRAY:
            return "null";
        case MPV_FORMAT_NODE_ARRAY: {
            std::string out = "[";
            const mpv_node_list *list = node->u.list;
            if (list && list->values) {
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
            if (list && list->values) {
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

// ── Hardware-adaptive libmpv tuning ────────────────────────────────────────

const char *deviceTierName(DeviceTier tier) {
    switch (tier) {
        case DeviceTier::Low:  return "low";
        case DeviceTier::Mid:  return "mid";
        case DeviceTier::High: return "high";
        default:               return "mid";
    }
}

HardwareProfile detectHardwareProfile(
    int64_t totalRamMbHint,
    int cpuCoresHint,
    int screenWidthPx,
    int screenHeightPx,
    int glEsMajor,
    bool isLowRamHint) {
    HardwareProfile p{};

    // Query OS physical RAM directly in C++ when hint is absent.
    int64_t ramMb = totalRamMbHint;
    if (ramMb <= 0) {
        const long pages = sysconf(_SC_PHYS_PAGES);
        const long pageSize = sysconf(_SC_PAGE_SIZE);
        if (pages > 0 && pageSize > 0) {
            ramMb = (static_cast<int64_t>(pages) * static_cast<int64_t>(pageSize)) / (1024 * 1024);
        }
    }

    int cores = cpuCoresHint;
    if (cores <= 0) {
        const long online = sysconf(_SC_NPROCESSORS_ONLN);
        cores = online > 0 ? static_cast<int>(online) : 4;
    }

    p.totalRamMb = ramMb;
    p.cpuCores = cores;
    p.screenWidthPx = screenWidthPx > 0 ? screenWidthPx : 0;
    p.screenHeightPx = screenHeightPx > 0 ? screenHeightPx : 0;
    p.glEsMajor = glEsMajor > 0 ? glEsMajor : 3;
    p.isLowRam = isLowRamHint || (ramMb > 0 && ramMb <= 3200);

    const int shortEdge = (p.screenWidthPx > 0 && p.screenHeightPx > 0)
        ? std::min(p.screenWidthPx, p.screenHeightPx)
        : 1080;

    if (p.isLowRam || p.glEsMajor < 3 || (ramMb > 0 && ramMb <= 3500) ||
        (shortEdge <= 720 && ramMb > 0 && ramMb <= 4500) || cores <= 4) {
        p.tier = DeviceTier::Low;
    } else if ((ramMb > 0 && ramMb <= 6500) || shortEdge < 1080) {
        p.tier = DeviceTier::Mid;
    } else {
        p.tier = DeviceTier::High;
    }

    return p;
}

void applyHardwareTuning(mpv_handle *mpv, const HardwareProfile &profile, bool isPreInit) {
    if (!mpv) return;

    // Resilient hardware decoding: prefer zero-copy MediaCodec Surface,
    // automatically fall back to mediacodec-copy on quirky OEM drivers or when
    // video filters (vf) are active, before ever dropping to CPU decode.
    setMpvConfig(mpv, "hwdec", "mediacodec,mediacodec-copy", isPreInit);
    setMpvConfig(mpv, "framedrop", "vo", isPreInit);
    setMpvConfig(mpv, "video-output-levels", "auto", isPreInit);
    setMpvConfig(mpv, "deband", "no", isPreInit);

    const int safeCores = profile.cpuCores > 0 ? profile.cpuCores : 4;
    char threadsBuf[16];

    switch (profile.tier) {
        case DeviceTier::Low: {
            // Budget / low-RAM / <=720p / weak GPU:
            // Minimize GPU fragment shader cost and native heap footprint.
            setMpvConfig(mpv, "scale", "bilinear", isPreInit);
            setMpvConfig(mpv, "dscale", "bilinear", isPreInit);
            setMpvConfig(mpv, "cscale", "bilinear", isPreInit);
            setMpvConfig(mpv, "correct-downscaling", "no", isPreInit);
            setMpvConfig(mpv, "dither-depth", "no", isPreInit);
            setMpvConfig(mpv, "fbo-format", "rgba8", isPreInit);
            setMpvConfig(mpv, "target-colorspace-hint", "no", isPreInit);
            snprintf(threadsBuf, sizeof(threadsBuf), "%d", std::max(1, std::min(safeCores, 4)));
            setMpvConfig(mpv, "vd-lavc-threads", threadsBuf, isPreInit);
            setMpvConfig(mpv, "vd-lavc-fast", "yes", isPreInit);
            setMpvConfig(mpv, "vd-lavc-skiploopfilter", "nonref", isPreInit);
            setMpvConfig(mpv, "cache", "yes", isPreInit);
            setMpvConfig(mpv, "cache-secs", "60", isPreInit);
            setMpvConfig(mpv, "demuxer-readahead-secs", "60", isPreInit);
            setMpvConfig(mpv, "demuxer-max-bytes", "32MiB", isPreInit);
            setMpvConfig(mpv, "demuxer-max-back-bytes", "16MiB", isPreInit);
            break;
        }
        case DeviceTier::Mid: {
            // Mid-range 4-6 GB RAM / 1080p:
            // Crisp downscaling with 8-bit FBOs and balanced RAM cache.
            setMpvConfig(mpv, "scale", "bilinear", isPreInit);
            setMpvConfig(mpv, "dscale", "mitchell", isPreInit);
            setMpvConfig(mpv, "cscale", "bilinear", isPreInit);
            setMpvConfig(mpv, "correct-downscaling", "no", isPreInit);
            setMpvConfig(mpv, "dither-depth", "auto", isPreInit);
            setMpvConfig(mpv, "fbo-format", "rgba8", isPreInit);
            setMpvConfig(mpv, "target-colorspace-hint", "yes", isPreInit);
            snprintf(threadsBuf, sizeof(threadsBuf), "%d", std::max(2, std::min(safeCores, 6)));
            setMpvConfig(mpv, "vd-lavc-threads", threadsBuf, isPreInit);
            setMpvConfig(mpv, "vd-lavc-fast", "no", isPreInit);
            setMpvConfig(mpv, "vd-lavc-skiploopfilter", "default", isPreInit);
            setMpvConfig(mpv, "cache", "yes", isPreInit);
            setMpvConfig(mpv, "cache-secs", "180", isPreInit);
            setMpvConfig(mpv, "demuxer-readahead-secs", "180", isPreInit);
            setMpvConfig(mpv, "demuxer-max-bytes", "80MiB", isPreInit);
            setMpvConfig(mpv, "demuxer-max-back-bytes", "40MiB", isPreInit);
            break;
        }
        case DeviceTier::High: {
            // Flagship >=8 GB RAM / >=1080p-1440p / GLES 3+:
            // Full cinema-grade scaling, HDR colorspace hint, and 300s buffer.
            setMpvConfig(mpv, "scale", "spline36", isPreInit);
            setMpvConfig(mpv, "dscale", "mitchell", isPreInit);
            setMpvConfig(mpv, "cscale", "bilinear", isPreInit);
            setMpvConfig(mpv, "correct-downscaling", "yes", isPreInit);
            setMpvConfig(mpv, "dither-depth", "auto", isPreInit);
            setMpvConfig(mpv, "fbo-format", "rgba16f", isPreInit);
            setMpvConfig(mpv, "target-colorspace-hint", "yes", isPreInit);
            setMpvConfig(mpv, "vd-lavc-threads", "0", isPreInit);
            setMpvConfig(mpv, "vd-lavc-fast", "no", isPreInit);
            setMpvConfig(mpv, "vd-lavc-skiploopfilter", "default", isPreInit);
            setMpvConfig(mpv, "cache", "yes", isPreInit);
            setMpvConfig(mpv, "cache-secs", "300", isPreInit);
            setMpvConfig(mpv, "demuxer-readahead-secs", "300", isPreInit);
            setMpvConfig(mpv, "demuxer-max-bytes", "150MiB", isPreInit);
            setMpvConfig(mpv, "demuxer-max-back-bytes", "75MiB", isPreInit);
            break;
        }
    }

    HW_LOGI(
        "Applied libmpv hardware profile tier=%s (ramMb=%lld cores=%d screen=%dx%d gles=%d lowRam=%d preInit=%d)",
        deviceTierName(profile.tier),
        static_cast<long long>(profile.totalRamMb),
        profile.cpuCores,
        profile.screenWidthPx,
        profile.screenHeightPx,
        profile.glEsMajor,
        profile.isLowRam ? 1 : 0,
        isPreInit ? 1 : 0);
}

std::string hardwareProfileToJson(const HardwareProfile &profile) {
    char buf[256];
    snprintf(
        buf,
        sizeof(buf),
        "{\"tier\":\"%s\",\"totalRamMb\":%lld,\"cpuCores\":%d,\"screenWidthPx\":%d,\"screenHeightPx\":%d,\"glEsMajor\":%d,\"isLowRam\":%s}",
        deviceTierName(profile.tier),
        static_cast<long long>(profile.totalRamMb),
        profile.cpuCores,
        profile.screenWidthPx,
        profile.screenHeightPx,
        profile.glEsMajor,
        profile.isLowRam ? "true" : "false");
    return std::string(buf);
}

// ── Load request correlation queue ─────────────────────────────────────────

void enqueueLoadRequest(PendingLoadRequest request) {
    std::lock_guard<std::mutex> guard(g_loadQueueMutex);
    if (!g_activeLoad.requestId.empty() && g_activeLoad.requestId != request.requestId) {
        for (auto iterator = g_pendingLoads.begin(); iterator != g_pendingLoads.end();) {
            if (iterator->requestId == g_activeLoad.requestId) {
                iterator = g_pendingLoads.erase(iterator);
                break;
            } else {
                ++iterator;
            }
        }
    }
    for (auto iterator = g_pendingLoads.begin(); iterator != g_pendingLoads.end();) {
        if (!request.resolvedPath.empty() && iterator->resolvedPath == request.resolvedPath) {
            iterator = g_pendingLoads.erase(iterator);
        } else {
            ++iterator;
        }
    }
    g_activeLoad = request;
    g_pendingLoads.push_back(std::move(request));
}

void clearActiveLoadRequest() {
    std::lock_guard<std::mutex> guard(g_loadQueueMutex);
    g_activeLoad = {};
}

void dropLoadRequest(const std::string &requestId) {
    if (requestId.empty()) return;
    std::lock_guard<std::mutex> guard(g_loadQueueMutex);
    for (auto iterator = g_pendingLoads.begin(); iterator != g_pendingLoads.end(); ++iterator) {
        if (iterator->requestId == requestId) {
            g_pendingLoads.erase(iterator);
            if (g_activeLoad.requestId == requestId) g_activeLoad = {};
            return;
        }
    }
}

std::string activeLoadRequestId(const std::string &resolvedPath) {
    std::lock_guard<std::mutex> guard(g_loadQueueMutex);
    if (g_activeLoad.requestId.empty()) return "";
    if (!resolvedPath.empty() && !g_activeLoad.resolvedPath.empty() &&
        g_activeLoad.resolvedPath != resolvedPath) {
        return "";
    }
    return g_activeLoad.requestId;
}

std::string consumeFileLoadedPayload(const std::string &resolvedPath) {
    std::lock_guard<std::mutex> guard(g_loadQueueMutex);
    if (g_pendingLoads.empty()) return "{}";

    auto selected = g_pendingLoads.end();
    if (resolvedPath.empty()) {
        if (g_pendingLoads.size() == 1) selected = g_pendingLoads.begin();
    } else {
        for (auto iterator = g_pendingLoads.begin(); iterator != g_pendingLoads.end(); ++iterator) {
            if (iterator->resolvedPath == resolvedPath) {
                selected = iterator;
                break;
            }
        }
        if (selected == g_pendingLoads.end() && g_pendingLoads.size() == 1) {
            selected = g_pendingLoads.begin();
        }
    }
    if (selected == g_pendingLoads.end()) return "{}";

    const std::string requestId = selected->requestId;
    const std::string path = selected->resolvedPath;
    g_pendingLoads.erase(selected);
    if (requestId.empty()) return "{}";

    return "{\"requestId\":" + jsonQuote(requestId)
        + ",\"resolvedPath\":" + jsonQuote(path) + "}";
}

void clearPendingLoadRequests() {
    std::lock_guard<std::mutex> guard(g_loadQueueMutex);
    g_pendingLoads.clear();
    g_activeLoad = {};
}
