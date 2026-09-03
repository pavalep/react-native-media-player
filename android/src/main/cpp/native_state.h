#pragma once

#include <atomic>
#include <cstdint>
#include <deque>
#include <shared_mutex>
#include <string>
#include <utility>

#include <jni.h>
#include <client.h>

extern mpv_handle *g_mpv;
extern std::atomic<bool> g_running;
extern std::atomic<bool> g_initialized;
extern std::shared_mutex g_mpvLifecycleMutex;

class NativeMpvReadLease {
public:
    explicit NativeMpvReadLease(jlong nativePtr)
        : lock_(g_mpvLifecycleMutex),
          handle_(reinterpret_cast<mpv_handle *>(nativePtr)) {}

    bool valid() const {
        return handle_ != nullptr && handle_ == g_mpv && g_initialized.load();
    }

    mpv_handle *get() const { return handle_; }

private:
    std::shared_lock<std::shared_mutex> lock_;
    mpv_handle *handle_;
};

struct PendingLoadRequest {
    std::string requestId;
    std::string resolvedPath;
};

void enqueueLoadRequest(PendingLoadRequest request);
void clearActiveLoadRequest();
void dropLoadRequest(const std::string &requestId);
std::string consumeFileLoadedPayload(const std::string &resolvedPath);
std::string activeLoadRequestId(const std::string &resolvedPath);
void clearPendingLoadRequests();
