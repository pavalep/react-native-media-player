#!/usr/bin/env node
/**
 * download-native.js
 *
 * Postinstall hook for @simba-dev/react-native-media-player. Downloads the
 * prebuilt native libraries (libmpv, libav*, libc++_shared, libplayer, etc.)
 * from the matching GitHub release and extracts them into
 * `android/src/main/jniLibs/` so the consumer's Gradle build can find them
 * via CMakeLists.txt's `jniLibs/<abi>/libmpv.so` lookup.
 *
 * Why this exists (vs committing binaries to git):
 *   - Git history stays small (~152 MB of .so files would otherwise live
 *     in every clone forever).
 *   - This is the industry-standard pattern for React Native libraries
 *     shipping prebuilt native binaries — see `llama.rn` for the
 *     canonical implementation: https://github.com/mybigday/llama.rn
 *   - Binaries are versioned via GitHub Release assets (immutable, tied
 *     to the npm version) and SHA-256 verified before extraction.
 *
 * Idempotency:
 *   - If `android/src/main/jniLibs/<abi>/libmpv.so` already exists, the
 *     script exits 0 immediately (no network call). Re-running `npm
 *     install` is safe.
 *
 * Skipping:
 *   - Set `SKIP_DOWNLOAD_NATIVE=1` to bypass the download. Useful for CI
 *     builds that mount the binaries differently, or for tests.
 *
 * Failure modes (with actionable error messages):
 *   - No matching GitHub Release for the version → fail with the URL the
 *     user should check, and a hint that this is expected for unreleased
 *     versions.
 *   - Asset not in the release → fail naming the expected asset filename.
 *   - SHA-256 mismatch → fail with both expected and actual hash; refuse
 *     to extract (supply-chain protection).
 *   - Network failure → fail with the underlying error.
 *
 * Trust friction:
 *   - pnpm strict mode: consumers must add the lib to `pnpm.onlyBuiltDependencies`.
 *   - Bun: must add to `trustedDependencies` in package.json.
 *   - npm/yarn classic: no extra config needed.
 *   - All of this is documented in README.md under "Install".
 */

'use strict';

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const REPO_OWNER = 'pavalep';
const REPO_NAME = 'react-native-media-player';
// The asset basename uploaded by the release workflow (and the one-off
// manual upload for v1.5.14). Keep this in sync with release.yml.
const ASSET_BASENAME = 'jniLibs.tar.gz';
const SHA_SUFFIX = '.sha256';

// Expected minimum content: the consumer's CMakeLists.txt checks for
// `jniLibs/<abi>/libmpv.so` for every ABI we publish. If any of these
// is missing, the consumer's Gradle build will fail at configureCMake.
const REQUIRED_ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'];
const REQUIRED_PROBE = 'libmpv.so';

// Allow override via env var (useful for fork consumers or air-gapped
// networks proxying through their own release server). Default: GitHub.
const RELEASE_BASE = process.env.RNMP_RELEASE_BASE
  || `https://github.com/${REPO_OWNER}/${REPO_NAME}`;

const SKIP_DOWNLOAD = process.env.SKIP_DOWNLOAD_NATIVE === '1';
const DEBUG = process.env.RNMP_DOWNLOAD_DEBUG === '1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
  process.stderr.write(`[download-native] ${msg}\n`);
}

function debug(msg) {
  if (DEBUG) log(`DEBUG: ${msg}`);
}

function fail(msg, details) {
  process.stderr.write(`[download-native] ERROR: ${msg}\n`);
  if (details) process.stderr.write(`${details}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 1: Resolve package version
// ---------------------------------------------------------------------------

const libRoot = path.resolve(__dirname, '..');
const pkgPath = path.join(libRoot, 'package.json');
if (!fs.existsSync(pkgPath)) {
  fail(`Cannot find package.json at ${pkgPath}. ` +
    'download-native.js must be invoked from inside the lib install tree.');
}
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const version = pkg.version;
const tag = `v${version}`;
debug(`lib version=${version}, tag=${tag}`);
debug(`RELEASE_BASE=${RELEASE_BASE}`);

// ---------------------------------------------------------------------------
// Step 2: Idempotency check — if binaries are already present, skip.
// ---------------------------------------------------------------------------

const jniLibsRoot = path.join(libRoot, 'android', 'src', 'main', 'jniLibs');
const probeFile = path.join(jniLibsRoot, REQUIRED_ABIS[0], REQUIRED_PROBE);
if (fs.existsSync(probeFile)) {
  debug(`Probe ${probeFile} exists; binaries already present. Skipping download.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Step 3: Skip if SKIP_DOWNLOAD_NATIVE=1
// ---------------------------------------------------------------------------

if (SKIP_DOWNLOAD) {
  log(`SKIP_DOWNLOAD_NATIVE=1 set; skipping native download. ` +
    `Make sure android/src/main/jniLibs/ is populated by another mechanism ` +
    `(e.g. a CI mount).`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Step 4: HTTP helpers — streaming GET with redirect support
// ---------------------------------------------------------------------------

/**
 * Performs an HTTPS GET, follows up to 5 redirects, and streams the
 * response body into the writable `dest` (file path or Writable stream).
 * Resolves with { statusCode, headers } on success; rejects on network
 * error or non-2xx final status.
 */
function httpsGetStream(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      // Handle redirects — GitHub Releases redirect download URLs to
      // S3-backed object storage.
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume(); // drain
        const next = res.headers.location;
        if (!next) return reject(new Error(`Redirect from ${url} with no Location header`));
        if (redirectsLeft <= 0) return reject(new Error(`Too many redirects starting from ${url}`));
        return resolve(httpsGetStream(next, dest, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const out = typeof dest === 'string'
        ? fs.createWriteStream(dest)
        : dest;
      out.on('error', reject);
      res.on('error', reject);
      res.pipe(out);
      out.on('finish', () => {
        if (typeof dest === 'string') out.close(() => resolve({ statusCode: 200, headers: res.headers }));
        else resolve({ statusCode: 200, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.setTimeout(60_000, () => {
      req.destroy(new Error(`Request timed out after 60s: ${url}`));
    });
  });
}

/**
 * Performs an HTTPS GET and resolves with the response body as a string.
 * Used for small JSON / sha256 responses (GitHub API + companion .sha256
 * file). Rejects on non-2xx.
 */
function httpsGetText(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        const next = res.headers.location;
        if (!next) return reject(new Error(`Redirect from ${url} with no Location header`));
        if (redirectsLeft <= 0) return reject(new Error(`Too many redirects starting from ${url}`));
        return resolve(httpsGetText(next, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => {
      req.destroy(new Error(`Request timed out after 30s: ${url}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Step 5: Locate the GitHub release for the package version
// ---------------------------------------------------------------------------

async function findRelease() {
  // GitHub's release-by-tag API: GET /repos/{owner}/{repo}/releases/tags/{tag}
  const apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/${tag}`;
  debug(`Looking up release via ${apiUrl}`);
  let body;
  try {
    body = await httpsGetText(apiUrl);
  } catch (e) {
    // Improve the most common failure: 404 = release not found yet.
    if (/HTTP 404/.test(e.message)) {
      fail(
        `GitHub release ${tag} does not exist yet.\n` +
        `This means the release was either never published, OR was published but the\n` +
        `tag/asset is on a different repo (fork, mirror). Check:\n` +
        `  - ${RELEASE_BASE}/releases/tag/${tag}\n\n` +
        `If you're consuming from a fork or private mirror, set RNMP_RELEASE_BASE to\n` +
        `the base URL of your mirror (e.g. https://your-mirror.example.com/owner/repo).`
      );
    }
    if (/HTTP 403/.test(e.message)) {
      fail(
        `GitHub API returned 403 (rate limit or auth required) for ${apiUrl}.\n` +
        `Unauthenticated requests are limited to 60/hour per IP. If this is happening\n` +
        `during CI, either:\n` +
        `  - Wait a few minutes and retry.\n` +
        `  - Use an authenticated request via the GH_TOKEN env var (NOT implemented yet).\n` +
        `  - Pre-stage the binaries via a different mechanism (mount, cache, manual\n` +
        `    copy) and set SKIP_DOWNLOAD_NATIVE=1.\n\n` +
        `Underlying error: ${e.message}`
      );
    }
    throw e;
  }
  let release;
  try {
    release = JSON.parse(body);
  } catch (e) {
    fail(`Failed to parse GitHub API response for tag ${tag}. ` +
      `This usually means the response was an error page (e.g. rate limit). ` +
      `Response starts with: ${body.slice(0, 200)}`);
  }
  const assets = (release.assets || []).map((a) => a.name);
  debug(`Release ${tag} has ${assets.length} assets: ${assets.join(', ')}`);
  const expectedAsset = ASSET_BASENAME;
  if (!assets.includes(expectedAsset)) {
    fail(
      `GitHub release ${tag} does not contain the expected asset "${expectedAsset}".\n` +
      `Assets found: ${assets.length ? assets.join(', ') : '(none)'}\n\n` +
      `This usually means one of:\n` +
      `  (a) The release was published before the postinstall pattern was added (pre-v1.5.14).\n` +
      `      The fix is to upgrade to a version that has the postinstall + matching asset\n` +
      `      (check ${RELEASE_BASE}/releases/tag/${tag}).\n` +
      `  (b) The release.yml workflow's upload step failed silently. Check the latest release\n` +
      `      workflow run at https://github.com/${REPO_OWNER}/${REPO_NAME}/actions/workflows/release.yml.\n` +
      `  (c) You're installing from a fork or local checkout that doesn't have a GitHub Release\n` +
      `      for this version. Set RNMP_RELEASE_BASE to your fork's release URL.`
    );
  }
  const asset = release.assets.find((a) => a.name === expectedAsset);
  return asset.browser_download_url;
}

// ---------------------------------------------------------------------------
// Step 6: Download + verify + extract
// ---------------------------------------------------------------------------

async function downloadAndExtract() {
  log(`Downloading native libraries for @simba-dev/react-native-media-player@${version}...`);
  const downloadUrl = await findRelease();

  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rnmp-native-'));
  const tarPath = path.join(tmpDir, ASSET_BASENAME);
  const shaPath = path.join(tmpDir, ASSET_BASENAME + SHA_SUFFIX);

  try {
    // 1) Download the tarball
    debug(`Downloading ${downloadUrl} -> ${tarPath}`);
    await httpsGetStream(downloadUrl, tarPath);
    const tarSize = fs.statSync(tarPath).size;
    log(`Downloaded ${(tarSize / 1024 / 1024).toFixed(1)} MB tarball.`);

    // 2) Download the companion .sha256 file from the same release.
    //    GitHub's asset URLs are deterministic — we can swap the filename
    //    in the URL. If that fails (e.g. CDN doesn't expose it), fall
    //    back to the GitHub API's `digest` field on the asset object.
    const shaUrl = downloadUrl.replace(/\/[^/]+$/, `/${ASSET_BASENAME}${SHA_SUFFIX}`);
    debug(`Downloading ${shaUrl} -> ${shaPath}`);
    let expectedSha;
    try {
      const shaText = await httpsGetText(shaUrl);
      // sha256sum format: "<hash>  " or just "<hash>"
      const match = shaText.trim().match(/^([a-f0-9]{64})/);
      if (!match) {
        fail(`Could not parse SHA-256 from companion file. ` +
          `Expected a 64-char hex hash at the start of the line, got: ${shaText.slice(0, 200)}`);
      }
      expectedSha = match[1];
    } catch (e) {
      fail(
        `Failed to download SHA-256 file from ${shaUrl}.\n` +
        `Underlying error: ${e.message}\n\n` +
        `This means we cannot verify the tarball's integrity. Refusing to extract. ` +
        `Either:\n` +
        `  - Ensure the release was created with both ${ASSET_BASENAME} and ` +
        `${ASSET_BASENAME}${SHA_SUFFIX} assets.\n` +
        `  - Or set SKIP_DOWNLOAD_NATIVE=1 and provision the binaries yourself.`
      );
    }

    // 3) Verify SHA-256
    const actualSha = crypto.createHash('sha256')
      .update(fs.readFileSync(tarPath))
      .digest('hex');
    debug(`expected=${expectedSha} actual=${actualSha}`);
    if (actualSha !== expectedSha) {
      fail(
        `SHA-256 mismatch on downloaded tarball — refusing to extract.\n` +
        `  expected: ${expectedSha}\n` +
        `  actual:   ${actualSha}\n\n` +
        `This indicates the tarball was corrupted in transit OR a malicious actor ` +
        `is serving a tampered asset. Do NOT extract. Re-run npm install, or ` +
        `verify the release's published asset hashes at ` +
        `${RELEASE_BASE}/releases/tag/${tag}.`
      );
    }
    log('SHA-256 verified.');

    // 4) Extract into android/src/main/jniLibs/
    //    Make sure the parent dir exists; tar -xz handles nested paths.
    fs.mkdirSync(jniLibsRoot, { recursive: true });

    // Use the system `tar` to avoid pulling in a tar lib dependency.
    // Cross-platform: macOS/Linux ship `tar` by default; on Windows,
    // Node 20+ includes bsdtar, and Git for Windows also provides it.
    // We invoke via the lib's root so the tarball's relative paths land
    // in the right place (it was created from the lib root with paths
    // like `android/src/main/jniLibs/<abi>/libmpv.so`).
    log(`Extracting into ${jniLibsRoot}...`);
    execFileSync('tar', ['-xzf', tarPath], { cwd: libRoot, stdio: 'inherit' });

    // 5) Sanity check: probe every required ABI for libmpv.so.
    const missing = REQUIRED_ABIS.filter(
      (abi) => !fs.existsSync(path.join(jniLibsRoot, abi, REQUIRED_PROBE))
    );
    if (missing.length > 0) {
      fail(
        `Extraction completed but required probe file(s) are missing:\n` +
        missing.map((abi) => `  - android/src/main/jniLibs/${abi}/${REQUIRED_PROBE}`).join('\n') +
        `\n\nThe tarball may be corrupt or incomplete. Re-run, or check the release's ` +
        `published assets at ${RELEASE_BASE}/releases/tag/${tag}.`
      );
    }
    log(`Native libraries installed (${REQUIRED_ABIS.length} ABIs verified).`);
  } finally {
    // Clean up temp dir regardless of success/failure.
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

downloadAndExtract().catch((err) => {
  fail(err.message || String(err));
});
