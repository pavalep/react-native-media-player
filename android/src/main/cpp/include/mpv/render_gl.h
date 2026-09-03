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

#ifndef MPV_CLIENT_API_RENDER_GL_H_
#define MPV_CLIENT_API_RENDER_GL_H_

#include "render.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * For initializing the mpv OpenGL state via MPV_RENDER_PARAM_OPENGL_INIT_PARAMS.
 */
typedef struct mpv_opengl_init_params {
    /**
     * This retrieves OpenGL function pointers, and will use them in subsequent
     * operation. On Android, use eglGetProcAddress.
     */
    void *(*get_proc_address)(void *ctx, const char *name);

    /**
     * Value passed as ctx parameter to get_proc_address().
     */
    void *get_proc_address_ctx;

    /**
     * Deprecated. Set to NULL.
     */
    const char *extra_exts;
} mpv_opengl_init_params;

/**
 * For MPV_RENDER_PARAM_OPENGL_FBO.
 */
typedef struct mpv_opengl_fbo {
    /** Framebuffer object name (0 = default framebuffer). */
    int fbo;
    /** Valid dimensions. Must always be set. */
    int w, h;
    /** Underlying texture internal format (e.g. GL_RGBA8), or 0 if unknown. */
    int internal_format;
} mpv_opengl_fbo;

#ifdef __cplusplus
}
#endif

#endif /* MPV_CLIENT_API_RENDER_GL_H_ */
