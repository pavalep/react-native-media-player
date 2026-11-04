package com.simba.player.mpv

import java.io.File

/**
 * The shared scanner behind the "a claim in a comment is still a claim"
 * guards.
 *
 * ## Why this exists
 *
 * The library's guards for the Picture-in-Picture facts are SOURCE tests.
 * The first ones stripped comments before looking, because they were
 * checking what the CODE does. That was right for them, and it left a hole:
 *
 *  - `playback-state` — a property mpv does **not** have — was read in four
 *    places, and the code guard caught the CODE. A docblock that said "read
 *    from mpv's `playback-state`" was invisible to it, and one of those
 *    docblocks survived into a published release.
 *  - the same for the crop claim, and for the auto-enter switch.
 *
 * A docblock is a CLAIM. It is read by the next person, and a false one
 * sends them looking for a mechanism that does not exist. So these guards
 * read the COMMENTS too.
 *
 * ## What a "block" is
 *
 * A run of consecutive lines that are all PROSE or all COMMENT. A blank line
 * ends a block, and so does a CODE line: in a Kotlin file, two comment runs
 * separated by a statement are two different claims, and a retraction in one
 * of them must not be allowed to excuse a false claim in the other.
 */
internal object ClaimScan {

    data class Block(val firstLine: Int, val text: String)

    /**
     * Every source file a claim could hide in, plus the shipped README.
     *
     * The `CHANGELOG.md` is deliberately NOT scanned: it is the historical
     * record, it QUOTES the old claims on purpose (a retraction that deletes
     * the wrong text is not a retraction), and it is reviewed by hand.
     */
    fun files(): List<File> {
        val out = mutableListOf<File>()
        val root = libRoot()
        out += walk(root.resolve("android/src/main/java"), setOf("kt", "java"))
        out += walk(root.resolve("src"), setOf("kt", "java", "ts", "tsx"))
        root.resolve("README.md").takeIf { it.isFile }?.let { out += it }
        return out
    }

    /** The file's paragraphs. */
    fun blocks(file: File): List<Block> {
        val out = mutableListOf<Block>()
        val buf = mutableListOf<String>()
        var start = 0
        var index = 0

        fun flush() {
            if (buf.isNotEmpty()) {
                out += Block(start, buf.joinToString(" ").replace(Regex("\\s+"), " ").trim())
                buf.clear()
            }
        }

        for (line in file.readLines()) {
            if (line.isBlank() || isCodeLine(file, line)) {
                flush()
            } else {
                if (buf.isEmpty()) start = index + 1
                buf += line
            }
            index += 1
        }
        flush()
        return out
    }

    /** The library's own root: the directory with `package.json` and `android/`. */
    fun libRoot(): File {
        var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        var depth = 0
        while (dir != null && depth < 8) {
            if (File(dir, "package.json").isFile && File(dir, "android").isDirectory) return dir
            dir = dir.parentFile
            depth += 1
        }
        throw AssertionError(
            "the library root (package.json + android/) not found from ${System.getProperty("user.dir")}",
        )
    }

    private fun walk(root: File, extensions: Set<String>): List<File> {
        if (!root.isDirectory) return emptyList()
        val out = mutableListOf<File>()
        root.walkTopDown()
            .onEnter { it.name != "node_modules" && it.name != "build" }
            .forEach { f ->
                if (f.isFile && f.extension.lowercase() in extensions) out += f
            }
        return out
    }

    /**
     * Whether the line is CODE rather than prose or comment.
     *
     * Only Kotlin and Java are inspected this way: in a TypeScript or
     * Markdown file a line of prose IS prose, and the blank lines around
     * it are what separate one paragraph from the next.
     */
    private fun isCodeLine(file: File, line: String): Boolean {
        val extension = file.extension.lowercase()
        if (extension != "kt" && extension != "java") return false
        val trimmed = line.trim()
        if (trimmed.isEmpty()) return false
        return !trimmed.startsWith("*") &&
            !trimmed.startsWith("//") &&
            !trimmed.startsWith("/*")
    }
}
