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

// ── Hardware-adaptive libmpv tuning (v3.5.0) ───────────────────────────────

enum class DeviceTier : int {
    Low = 0,
    Mid = 1,
    High = 2,
};

struct HardwareProfile {
    int64_t totalRamMb = 0;
    int cpuCores = 0;
    int screenWidthPx = 0;
    int screenHeightPx = 0;
    int glEsMajor = 3;
    bool isLowRam = false;
    DeviceTier tier = DeviceTier::Mid;
};

const char *deviceTierName(DeviceTier tier);

HardwareProfile detectHardwareProfile(
    int64_t totalRamMbHint,
    int cpuCoresHint,
    int screenWidthPx,
    int screenHeightPx,
    int glEsMajor,
    bool isLowRamHint);

void applyHardwareTuning(mpv_handle *mpv, const HardwareProfile &profile, bool isPreInit);
std::string hardwareProfileToJson(const HardwareProfile &profile);

// ── Shared hardened JSON serializer ────────────────────────────────────────

std::string jsonQuote(const char *value);
std::string jsonQuote(const std::string &value);
std::string jsonNode(const mpv_node *node);

// ── Load request correlation queue ─────────────────────────────────────────

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
