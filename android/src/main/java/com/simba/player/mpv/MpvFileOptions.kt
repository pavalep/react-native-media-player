package com.simba.player.mpv

import org.json.JSONObject

/**
 * Turns a set of HTTP request headers into mpv's PER-FILE option list.
 *
 * WHY A HELPER, AND WHY IT LIVES HERE
 * -----------------------------------
 * mpv has no "send these headers with this one file" API. What it has is
 * `loadfile`'s per-file options. mpv 0.41's `loadfile` command is
 *
 *     loadfile <url> [<flags> [<index> [<options>]]]
 *
 * and `<options>` is a key/value list that mpv turns into FILE-LOCAL
 * options: mpv's `player/command.c` (`cmd_loadfile`) turns every pair into
 * a playlist-entry param, and `player/loadfile.c` (`load_per_file_options`)
 * applies every param with `M_SET_OPTION_FLAG_FILE_LOCAL`.
 *
 * That is the whole point. A GLOBAL `mpv_set_option_string("user-agent", ...)`
 * would leak the header onto every LATER file - the app's own music, a
 * podcast, anything - and the value would be read when the NEXT stream opens,
 * not the one it was set for. The per-file form is the only one that means
 * "this file".
 *
 * THE FORMAT, AND WHY IT IS THIS FLAKY
 * -------------------------------------
 * Two parsers sit between this string and mpv, and they are not the same:
 *
 *  1. mpv parses `<options>` as a KEY/VALUE LIST (`options/m_option.c`,
 *     `parse_keyvalue_list`): `key=value` pairs separated by commas. A value
 *     may be QUOTED, and a quoted value is taken verbatim (`read_subparam`) -
 *     that is how a value with a comma in it survives this layer.
 *  2. mpv then parses each option's own VALUE with that option's type.
 *     `user-agent` is a string (verbatim), but `http-header-fields` is a
 *     STRING LIST, and a list is split on commas (`separate_input_param` ->
 *     `get_nextsep`), with `\,` as the escape for a literal comma.
 *
 * So: quote the value for layer 1, and escape the commas for layer 2.
 *
 * THE USER-AGENT GETS ITS OWN OPTION
 * -----------------------------------
 * mpv's `user-agent` is a plain string option, so a User-Agent needs no
 * comma escaping at all. It also avoids ffmpeg sending the header TWICE:
 * `http-header-fields` is ffmpeg's "extra headers" list, and a
 * "User-Agent:" line in it would be added ALONGSIDE ffmpeg's own User-Agent
 * rather than replacing it.
 *
 * THE VALUES ARE UNTRUSTED
 * ------------------------
 * These headers come from a playlist a third party publishes, and they end
 * up in an HTTP request. CR and LF are the dangerous ones: a value carrying
 * one would end the header and start another. The sink is a network
 * request, so the control characters are dropped here, next to the sink,
 * rather than trusted to have been checked upstream.
 */
internal object MpvFileOptions {

    /** mpv's own User-Agent option. A plain string - no list escaping. */
    private const val OPTION_USER_AGENT = "user-agent"

    /** mpv's extra-header option. A string LIST - commas need escaping. */
    private const val OPTION_HEADER_FIELDS = "http-header-fields"

    /**
     * Parse the JSON the JS side sends into a header map.
     *
     * A blank or malformed payload is NOT an error: it means "no headers",
     * and a load with no headers is exactly what happened before this option
     * existed. Anything that is not a string is dropped.
     */
    fun parseHeaders(json: String?): Map<String, String> {
        if (json.isNullOrBlank()) return emptyMap()
        val out = LinkedHashMap<String, String>()
        try {
            val obj = JSONObject(json)
            val keys = obj.keys()
            while (keys.hasNext()) {
                val name = keys.next()
                if (!obj.isNull(name)) {
                    val value = obj.optString(name, "")
                    if (value.isNotEmpty()) out[name] = value
                }
            }
        } catch (e: Exception) {
            return emptyMap()
        }
        return out
    }

    /**
     * Build mpv's `loadfile` options string for a set of headers.
     *
     * Returns null when there is nothing to send - the caller then loads the
     * file the way it always did, with no options at all.
     */
    fun buildLoadFileOptions(headers: Map<String, String>): String? {
        if (headers.isEmpty()) return null
        val pairs = mutableListOf<String>()
        val extraFields = mutableListOf<String>()
        for ((rawName, rawValue) in headers) {
            val name = sanitize(rawName)
            val value = sanitize(rawValue)
            if (name.isEmpty() || value.isEmpty()) continue
            if (name.equals("User-Agent", ignoreCase = true)) {
                pairs.add("$OPTION_USER_AGENT=${quote(value)}")
            } else {
                extraFields.add(escapeListItem("$name: $value"))
            }
        }
        if (extraFields.isNotEmpty()) {
            pairs.add("$OPTION_HEADER_FIELDS=${quote(extraFields.joinToString(","))}")
        }
        if (pairs.isEmpty()) return null
        return pairs.joinToString(",")
    }

    /**
     * Strip everything that could break the format or inject a header.
     *
     * CR and LF are the dangerous ones: a value carrying one would end the
     * header and start another. NUL and the other C0 controls are dropped
     * for the same reason. A double quote is dropped because it would end
     * mpv's quoted value early.
     */
    private fun sanitize(value: String): String {
        val sb = StringBuilder(value.length)
        for (ch in value) {
            val code = ch.code
            if (code == 0x22) continue // the double quote
            if (code < 0x20 || code == 0x7F) continue // C0 controls and DEL
            sb.append(ch)
        }
        return sb.toString().trim()
    }

    /**
     * Quote a value for mpv's key/value list.
     *
     * The quotes are what let the value hold commas and spaces: mpv's
     * `read_subparam` takes a quoted value verbatim.
     */
    private fun quote(value: String): String = "\"" + value + "\""

    /**
     * Escape a value for mpv's STRING LIST parser.
     *
     * The list parser splits on commas and treats `\,` as a literal comma,
     * so both the comma and the backslash itself have to be escaped - the
     * backslash first, or the escape would be escaped again.
     */
    private fun escapeListItem(value: String): String =
        value.replace("\\", "\\\\").replace(",", "\\,")
}
