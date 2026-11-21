package com.simba.player.mpv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The mpv per-file option format.
 *
 * mpv parses the `loadfile` options argument in TWO layers with different
 * escaping rules: the key/value list (where a value may be QUOTED and is
 * then taken verbatim) and the option own type (where `http-header-fields`
 * is a string LIST, so a comma in a value has to be escaped). These tests
 * pin both layers, because getting either one wrong produces a header that
 * looks right and is not.
 *
 * The format is mpv own, not this module own, so the expectations below are
 * written out longhand rather than computed.
 */
class MpvFileOptionsTest {

    @Test
    fun `no headers means no options at all`() {
        assertNull(MpvFileOptions.buildLoadFileOptions(emptyMap()))
    }

    @Test
    fun `the user agent goes into mpv own string option`() {
        val options = MpvFileOptions.buildLoadFileOptions(
            mapOf("User-Agent" to "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
        )
        assertEquals("user-agent=\"Mozilla/5.0 (Windows NT 10.0; Win64; x64)\"", options)
    }

    @Test
    fun `a user agent with commas is NOT list escaped`() {
        // The User-Agent rides mpv `user-agent` option, which is a plain
        // string: there is no list parser in that layer, so a comma in the
        // value is a comma and nothing else.
        val ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"
        val options = MpvFileOptions.buildLoadFileOptions(mapOf("User-Agent" to ua))
        assertEquals("user-agent=\"$ua\"", options)
    }

    @Test
    fun `other headers go into the header list and their commas are escaped`() {
        val options = MpvFileOptions.buildLoadFileOptions(
            mapOf("Referer" to "https://example.com/a,b")
        )
        assertEquals("http-header-fields=\"Referer: https://example.com/a\\,b\"", options)
    }

    @Test
    fun `the user agent and the other headers are both carried`() {
        val options = MpvFileOptions.buildLoadFileOptions(
            linkedMapOf("User-Agent" to "UA", "Referer" to "https://example.com")
        )
        assertEquals(
            "user-agent=\"UA\",http-header-fields=\"Referer: https://example.com\"",
            options
        )
    }

    @Test
    fun `a header injection attempt is stripped`() {
        // The values are untrusted: they come from a playlist a third party
        // publishes and they end up in an HTTP request. A CR/LF would end
        // the header and start another one.
        val options = MpvFileOptions.buildLoadFileOptions(
            mapOf("Referer" to "https://good.example/\r\nX-Injected: yes")
        )
        assertEquals(
            "http-header-fields=\"Referer: https://good.example/X-Injected: yes\"",
            options
        )
    }

    @Test
    fun `a double quote cannot end the quoted value early`() {
        val options = MpvFileOptions.buildLoadFileOptions(mapOf("User-Agent" to "a\"b"))
        assertEquals("user-agent=\"ab\"", options)
    }

    @Test
    fun `a blank header value is dropped`() {
        assertNull(MpvFileOptions.buildLoadFileOptions(mapOf("User-Agent" to "   ")))
    }

    @Test
    fun `a blank payload parses to no headers`() {
        assertTrue(MpvFileOptions.parseHeaders(null).isEmpty())
        assertTrue(MpvFileOptions.parseHeaders("").isEmpty())
        assertTrue(MpvFileOptions.parseHeaders("   ").isEmpty())
    }

    @Test
    fun `a malformed payload parses to no headers`() {
        // Not an error: a load with no headers is exactly what happened
        // before the option existed.
        assertTrue(MpvFileOptions.parseHeaders("not json").isEmpty())
    }

    @Test
    fun `a payload parses into the headers it names`() {
        val headers = MpvFileOptions.parseHeaders(
            "{\"User-Agent\":\"UA\",\"Referer\":\"https://example.com\"}"
        )
        assertEquals(2, headers.size)
        assertEquals("UA", headers["User-Agent"])
        assertEquals("https://example.com", headers["Referer"])
    }
}
