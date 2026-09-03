/* Copyright (C) 2018 the mpv developers
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

#ifndef MPV_CLIENT_API_RENDER_H_
#define MPV_CLIENT_API_RENDER_H_

#include "client.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Opaque context, returned by mpv_render_context_create().
 */
typedef struct mpv_render_context mpv_render_context;

/**
 * Parameters for mpv_render_param.
 */
typedef enum mpv_render_param_type {
    MPV_RENDER_PARAM_INVALID               = 0,
    MPV_RENDER_PARAM_API_TYPE              = 1,
    MPV_RENDER_PARAM_OPENGL_INIT_PARAMS    = 2,
    MPV_RENDER_PARAM_OPENGL_FBO            = 3,
    MPV_RENDER_PARAM_FLIP_Y                = 4,
    MPV_RENDER_PARAM_DEPTH                 = 5,
    MPV_RENDER_PARAM_ICC_PROFILE           = 6,
    MPV_RENDER_PARAM_AMBIENT_LIGHT         = 7,
    MPV_RENDER_PARAM_X11_DISPLAY           = 8,
    MPV_RENDER_PARAM_WL_DISPLAY            = 9,
    MPV_RENDER_PARAM_ADVANCED_CONTROL      = 10,
    MPV_RENDER_PARAM_NEXT_FRAME_INFO       = 11,
    MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME = 12,
    MPV_RENDER_PARAM_SKIP_RENDERING        = 13,
    MPV_RENDER_PARAM_DRM_DISPLAY           = 14,
    MPV_RENDER_PARAM_DRM_DRAW_SURFACE_SIZE = 15,
    MPV_RENDER_PARAM_DRM_DISPLAY_V2        = 16,
    MPV_RENDER_PARAM_SW_SIZE               = 17,
    MPV_RENDER_PARAM_SW_FORMAT             = 18,
    MPV_RENDER_PARAM_SW_STRIDE             = 19,
    MPV_RENDER_PARAM_SW_POINTER            = 20,
} mpv_render_param_type;

/**
 * Predefined values for MPV_RENDER_PARAM_API_TYPE.
 */
#define MPV_RENDER_API_TYPE_OPENGL "opengl"
#define MPV_RENDER_API_TYPE_SW     "sw"

/**
 * Flags returned by mpv_render_context_update().
 */
typedef enum mpv_render_update_flag {
    MPV_RENDER_UPDATE_FRAME  = 1 << 0,
    MPV_RENDER_UPDATE_OVERLAY = 1 << 1,
} mpv_render_update_flag;

/**
 * Flags used in mpv_render_frame_info.flags.
 */
typedef enum mpv_render_frame_info_flag {
    MPV_RENDER_FRAME_INFO_PRESENT = 1 << 0,
    MPV_RENDER_FRAME_INFO_REDRAW = 1 << 1,
    MPV_RENDER_FRAME_INFO_REPEAT = 1 << 2,
    MPV_RENDER_FRAME_INFO_BLOCK_VO = 1 << 3,
} mpv_render_frame_info_flag;

/**
 * Used to pass arbitrary parameters to mpv_render_context_create().
 * Also used for mpv_render_context_render(), mpv_render_context_get_info(),
 * and mpv_render_context_set_parameter().
 */
typedef struct mpv_render_param {
    enum mpv_render_param_type type;
    void *data;
} mpv_render_param;

/**
 * Information about the next video frame that will be rendered.
 */
typedef struct mpv_render_frame_info {
    uint64_t flags;
    int64_t target_time_ns;
} mpv_render_frame_info;

/**
 * Initialize the renderer state. Depending on the backend used, this will
 * access the underlying GPU API and initialize its own objects.
 *
 * @param res pointer to a pointer where the new context will be stored
 * @param mpv a mpv_handle created with mpv_create()
 * @param params an array of mpv_render_param, terminated by type==0
 * @return error code (<0 on error) or 0 on success
 */
int mpv_render_context_create(mpv_render_context **res, mpv_handle *mpv,
                              mpv_render_param *params);

/**
 * Destroy the mpv renderer state. The mpv core must still be running.
 * The context cannot be used after this call.
 */
void mpv_render_context_free(mpv_render_context *ctx);

/**
 * Render video.
 *
 * @param ctx the render context
 * @param params an array of mpv_render_param, terminated by type==0
 * @return error code (<0 on error) or 0 on success
 */
int mpv_render_context_render(mpv_render_context *ctx, mpv_render_param *params);

/**
 * Check for new frames and other events. Should be called from the same
 * thread that calls mpv_render_context_render().
 *
 * @return a bitmask of mpv_render_update_flag values
 */
uint64_t mpv_render_context_update(mpv_render_context *ctx);

/**
 * Set the callback that notifies you when a new video frame is available,
 * or if the video display configuration somehow changed.
 *
 * Similar to mpv_set_wakeup_callback(), you must not call any mpv API from
 * the callback, and all the other listed restrictions apply.
 *
 * @param callback function to call, or NULL to unset
 * @param callback_ctx opaque parameter passed to callback
 */
typedef void (*mpv_render_update_fn)(void *cb_ctx);

void mpv_render_context_set_update_callback(mpv_render_context *ctx,
                                            mpv_render_update_fn callback,
                                            void *callback_ctx);

/**
 * Tell the renderer that a frame was flipped at the given time. This is
 * optional, but can help the player to achieve better timing.
 */
void mpv_render_context_report_swap(mpv_render_context *ctx);

/**
 * Retrieve information from the render context.
 */
int mpv_render_context_get_info(mpv_render_context *ctx,
                                mpv_render_param param);

/**
 * Attempt to change a single parameter.
 */
int mpv_render_context_set_parameter(mpv_render_context *ctx,
                                     mpv_render_param param);

#ifdef __cplusplus
}
#endif

#endif /* MPV_CLIENT_API_RENDER_H_ */
