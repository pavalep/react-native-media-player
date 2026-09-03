#include "native_state.h"

#include <mutex>

namespace {
std::mutex g_loadQueueMutex;
std::deque<PendingLoadRequest> g_pendingLoads;
PendingLoadRequest g_activeLoad{};

std::string jsonQuote(const std::string &value) {
    std::string result;
    result.reserve(value.size() + 2);
    result.push_back('"');
    for (const unsigned char character : value) {
        switch (character) {
            case '\\': result += "\\\\"; break;
            case '"': result += "\\\""; break;
            case '\n': result += "\\n"; break;
            case '\r': result += "\\r"; break;
            case '\t': result += "\\t"; break;
            default: result.push_back(static_cast<char>(character)); break;
        }
    }
    result.push_back('"');
    return result;
}
}

void enqueueLoadRequest(PendingLoadRequest request) {
    std::lock_guard<std::mutex> guard(g_loadQueueMutex);
    // L3: reap the previously-active request if it's been superseded.
    // Without this, a user navigating between files before FILE_LOADED
    // fires for the first one leaves the old entry in the queue
    // forever (it never matches the new file's resolvedPath and
    // consumeFileLoadedPayload never pops it). Drop it here so the
    // queue never holds more than one in-flight request at a time.
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
        // MPV can report FILE_LOADED before its `path` property becomes
        // readable. With exactly one pending V3 request, the event is still
        // unambiguous; preserve its token and let V3 correlate by request ID.
        if (g_pendingLoads.size() == 1) selected = g_pendingLoads.begin();
    } else {
        for (auto iterator = g_pendingLoads.begin(); iterator != g_pendingLoads.end(); ++iterator) {
            if (iterator->resolvedPath == resolvedPath) {
                selected = iterator;
                break;
            }
        }
        // Some mpv backends normalize a path (for example by changing a
        // document-provider fd representation). If there is only one pending
        // request, the FILE_LOADED event is still unambiguous by event order.
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
