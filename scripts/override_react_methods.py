#!/usr/bin/env python3
"""
V16.0.6 patch release (D-032 / B-010 proper fix):
MpvBridgeModule.kt must extend NativeMpvPlayerSpec. Every @ReactMethod-
annotated function is an override of the spec's abstract method, so we add
`@Override` (Kotlin annotation) on its own line and the `override` keyword
on the `fun` line.

We also normalize a handful of signature mismatches:
  - dumpObservedProperties(): Int       → Double       (spec returns `double`)
  - openPlayer(..., title: String?, ...): Promise
                                   → title: String  (spec is non-null)
  - enterPip(chapterTitle: String? = null, progressPct: String? = null)
       → enterPip(chapterTitle: String, progressPct: String)
       (spec is non-null, no defaults; defaults are dropped — the only
        internal callers were JS via @ReactMethod)

Methods NOT in the spec (addListener / removeListeners / startNotification
/ updateNotification / stopNotification / initialize lifecycle / the
IMpvConfigProvider & IMpvNativePtrProvider & IPipModeChangeEmitter
implementations) are left untouched so they keep their RN-bridge / private
implementor semantics.

The toggleMute() stub is added in a separate pass — the spec declares
`abstract void toggleMute();` but MpvBridgeModule.kt 1.5.5 doesn't have
the Kotlin override, so extending NativeMpvPlayerSpec would otherwise
fail to compile with the dreaded
    "Class 'MpvBridgeModule' is not abstract and does not override abstract
     member 'public abstract void toggleMute()'".
"""
import io
import re
import sys

SRC_PATH = (
    "X:/Development/SIMBA/react-native-media-player/android/src/main/java/"
    "com/simba/player/mpv/MpvBridgeModule.kt"
)

# Methods on MpvBridgeModule that have @ReactMethod but are NOT in the
# NativeMpvPlayerSpec (we shouldn't add `override` to them — adding
# `override` would be a Kotlin compiler error since the spec doesn't
# declare them as abstract overrides, and they aren't overrides of
# ReactContextBaseJavaModule either; they're just additional @ReactMethod
# surfaces RN will register).
NON_SPEC_REACT_METHODS = {
    "addListener",       # RN NativeEventEmitter requirement (line ~1179)
    "removeListeners",   # RN NativeEventEmitter requirement (line ~1185)
    "startNotification", # lib-private notification flow (line ~1508)
    "updateNotification",# lib-private notification flow (line ~1541)
    "stopNotification",  # lib-private notification flow (line ~1570)
}

# Methods whose signatures must be normalized to match the spec.
# Format: method_name -> (new_return_annotation_or_None, regex_pattern, replacement)
SIGNATURE_NORMALIZATIONS = [
    # 1. dumpObservedProperties(): Int -> Double (spec returns double)
    (
        "dumpObservedProperties",
        r"(    @ReactMethod\(isBlockingSynchronousMethod = true\)\n)"
        r"(    fun dumpObservedProperties)\(\): Int \{",
        r"\1\2(): Double {",
    ),
    # 2. openPlayer title: String? -> String
    (
        "openPlayer",
        r"(    fun openPlayer\(\n        uri: String,\n)"
        r"        title: String\?,\n",
        r"\1        title: String,\n",
    ),
    # 2b. openPlayer body — title?.takeIf { ... } -> title.takeIf { ... }
    (
        "openPlayer-body",
        r"        val resolvedTitle = title\?\.takeIf \{ it\.isNotBlank\(\) \} \?: uri",
        "        val resolvedTitle = title.takeIf { it.isNotBlank() } ?: uri",
    ),
    # 3. enterPip: drop nullable types + defaults
    (
        "enterPip",
        r"    fun enterPip\(chapterTitle: String\? = null, progressPct: String\? = null\) \{",
        "    fun enterPip(chapterTitle: String, progressPct: String) {",
    ),
]


def main() -> int:
    with open(SRC_PATH, "r", encoding="utf-8") as f:
        src = f.read()

    # Step 1 — apply signature normalizations BEFORE adding @Override so the
    # capture groups line up cleanly with the existing lines.
    for name, pattern, replacement in SIGNATURE_NORMALIZATIONS:
        new_src, n = re.subn(pattern, replacement, src, count=1)
        if n != 1:
            print(f"ERROR: signature normalization '{name}' did not match exactly once (matched {n} times)", file=sys.stderr)
            return 2
        print(f"  [signature] {name}: matched {n}x")
        src = new_src

    # Step 2 — convert each @ReactMethod fun <name>... block to add
    # `@Override` annotation and `override` keyword. We do this line by
    # line so the regex pattern is unambiguous.
    lines = io.StringIO(src).readlines()
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        # Match `@ReactMethod` (with optional params) on its own indented line,
        # followed by an indented `fun <ident>(...) ... {` line.
        m_anno = re.match(r"^(    )(@ReactMethod(?:\([^)]*\))?)\s*$", line)
        if m_anno and i + 1 < len(lines):
            next_line = lines[i + 1]
            m_fun = re.match(
                r"^(    )fun (?P<name>[A-Za-z_][A-Za-z0-9_]*)(?P<rest>\(.*)$",
                next_line,
            )
            if m_fun:
                name = m_fun.group("name")
                if name in NON_SPEC_REACT_METHODS:
                    out.append(line)
                    out.append(next_line)
                    i += 2
                    continue
                indent = m_anno.group(1)
                # Add @Override on its own line. Use the same indent.
                out.append(line)                            # @ReactMethod(...)
                out.append(f"{indent}@Override\n")          # @Override
                out.append(f"{indent}override fun {name}{m_fun.group('rest')}\n")  # override fun ...
                i += 2
                continue
        out.append(line)
        i += 1

    new_src = "".join(out)

    # Write back
    with open(SRC_PATH, "w", encoding="utf-8") as f:
        f.write(new_src)

    # Quick sanity: count the @Override we added
    override_count = new_src.count("    @Override\n")
    react_method_count = len(re.findall(r"^    @ReactMethod", new_src, flags=re.MULTILINE))
    print(f"Total @ReactMethod blocks: {react_method_count}")
    print(f"Added @Override annotations: {override_count}")
    print(f"Expected: ~{react_method_count - len(NON_SPEC_REACT_METHODS)} @Override on spec overrides")
    return 0


if __name__ == "__main__":
    sys.exit(main())
