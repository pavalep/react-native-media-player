#!/usr/bin/env node
/**
 * V16.0.6 patch release (D-032 / B-010 proper fix):
 * MpvBridgeModule.kt must extend NativeMpvPlayerSpec. Every @ReactMethod-
 * annotated function is an override of the spec's abstract method, so we add
 * `@Override` (Kotlin annotation) on its own line and the `override` keyword
 * on the `fun` line.
 *
 * We also normalize a handful of signature mismatches:
 *   - dumpObservedProperties(): Int       → Double       (spec returns double)
 *   - openPlayer(..., title: String?, ...): Promise
 *                                    → title: String  (spec is non-null)
 *   - enterPip(chapterTitle: String? = null, progressPct: String? = null)
 *        → enterPip(chapterTitle: String, progressPct: String)
 *        (spec is non-null, no defaults; defaults are dropped — the only
 *         internal callers were JS via @ReactMethod)
 *
 * Methods NOT in the spec (addListener / removeListeners / startNotification
 * / updateNotification / stopNotification / initialize lifecycle / the
 * IMpvConfigProvider & IMpvNativePtrProvider & IPipModeChangeEmitter
 * implementations) are left untouched so they keep their RN-bridge / private
 * implementor semantics.
 *
 * The toggleMute() stub is added in a separate pass — the spec declares
 * `abstract void toggleMute();` but MpvBridgeModule.kt 1.5.5 doesn't have
 * the Kotlin override, so extending NativeMpvPlayerSpec would otherwise
 * fail to compile with the dreaded
 *     "Class 'MpvBridgeModule' is not abstract and does not override abstract
 *      member 'public abstract void toggleMute()'".
 */
"use strict";

const fs = require("fs");
const path = require("path");

const SRC_PATH = path.resolve(
  "X:/Development/SIMBA/react-native-media-player/android/src/main/java/" +
    "com/simba/player/mpv/MpvBridgeModule.kt"
);

// @ReactMethod-annotated methods on MpvBridgeModule that are NOT in the
// NativeMpvPlayerSpec — we must NOT add `override` to them.
const NON_SPEC_REACT_METHODS = new Set([
  "addListener",       // RN NativeEventEmitter requirement
  "removeListeners",   // RN NativeEventEmitter requirement
  "startNotification", // lib-private notification flow
  "updateNotification",// lib-private notification flow
  "stopNotification",  // lib-private notification flow
]);

// Exact signature normalizations to apply BEFORE the @Override pass so
// capture groups line up with existing line breaks.
const SIGNATURE_NORMALIZATIONS = [
  // 1. dumpObservedProperties(): Int -> Double (spec returns double)
  {
    name: "dumpObservedProperties-return-type",
    pattern: /(    @ReactMethod\(isBlockingSynchronousMethod = true\)\r?\n    fun dumpObservedProperties)\(\): Int \{/,
    replacement: "$1(): Double {",
  },
  // 2. openPlayer title: String? -> String
  {
    name: "openPlayer-title-type",
    pattern: /(    fun openPlayer\(\r?\n        uri: String,\r?\n)        title: String\?,\r?\n/,
    replacement: "$1        title: String,\r\n",
  },
  // 2b. openPlayer body — title?.takeIf { ... } -> title.takeIf { ... }
  {
    name: "openPlayer-body-takeif",
    pattern: /        val resolvedTitle = title\?\.takeIf \{ it\.isNotBlank\(\) \} \?: uri/,
    replacement: "        val resolvedTitle = title.takeIf { it.isNotBlank() } ?: uri",
  },
  // 3. enterPip: drop nullable types + defaults
  {
    name: "enterPip-signature",
    pattern: /    fun enterPip\(chapterTitle: String\? = null, progressPct: String\? = null\) \{/,
    replacement: "    fun enterPip(chapterTitle: String, progressPct: String) {",
  },
];

const REACT_METHOD_LINE = /^(    )(@ReactMethod(?:\([^)]*\))?)\s*$/;
const FUN_LINE = /^(    )fun ([A-Za-z_][A-Za-z0-9_]*)(\(.*)$/;

function applySignatureNormalizations(src) {
  for (const norm of SIGNATURE_NORMALIZATIONS) {
    // Count non-overlapping matches via the `g` + `exec` loop (reliable even
    // when the regex has capture groups — `String.prototype.split` would
    // inflate its count by the number of captures).
    const re = new RegExp(norm.pattern.source, "g");
    let count = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      count++;
      // Guard against zero-length matches to avoid infinite loop in pathological cases.
      if (m[0].length === 0) re.lastIndex++;
    }
    if (count !== 1) {
      throw new Error(
        `signature normalization '${norm.name}' did not match exactly once (matched ${count} times)`
      );
    }
    // Now apply the actual replacement (preserve the original flags / backref semantics).
    const reNoG = new RegExp(norm.pattern.source, norm.pattern.flags);
    src = src.replace(reNoG, norm.replacement);
    console.log(`  [signature] ${norm.name}: matched ${count}x`);
  }
  return src;
}

function addOverrideAnnoAndKeyword(src) {
  const lines = src.split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const mAnno = line.match(REACT_METHOD_LINE);
    if (mAnno && i + 1 < lines.length) {
      const nextLine = lines[i + 1];
      const mFun = nextLine.match(FUN_LINE);
      if (mFun) {
        const name = mFun[2];
        if (NON_SPEC_REACT_METHODS.has(name)) {
          out.push(line);
          out.push(nextLine);
          i += 2;
          continue;
        }
        const indent = mAnno[1];
        out.push(line);
        out.push(`${indent}@Override`);
        out.push(`${indent}override fun ${name}${mFun[3]}`);
        i += 2;
        continue;
      }
    }
    out.push(line);
    i += 1;
  }
  return out.join("\n");
}

function main() {
  let src = fs.readFileSync(SRC_PATH, { encoding: "utf-8" });
  // Normalize CRLF -> LF for consistent regex matching. We write LF-only
  // back to keep diffs clean (the rest of the file uses LF exclusively
  // when checked out via git; the actual byte stream from the edit tool
  // happens to also be LF).
  src = src.replace(/\r\n/g, "\n");
  src = applySignatureNormalizations(src);
  src = addOverrideAnnoAndKeyword(src);
  fs.writeFileSync(SRC_PATH, src, { encoding: "utf-8" });

  const overrideCount = (src.match(/^    @Override$/mg) || []).length;
  const reactMethodCount = (src.match(/^    @ReactMethod/gm) || []).length;
  console.log(`Total @ReactMethod blocks: ${reactMethodCount}`);
  console.log(`Added @Override annotations: ${overrideCount}`);
  console.log(
    `Expected: ~${reactMethodCount - NON_SPEC_REACT_METHODS.size} @Override on spec overrides`
  );
}

main();
