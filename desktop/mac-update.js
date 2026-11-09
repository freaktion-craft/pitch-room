// The macOS app updating itself (main.js, updateMac), while it's unsigned: macOS's own updater (Squirrel.Mac, through
// electron-updater) takes only a new app signed as the old one was, so this does it as Windows' installer would. In
// the splash before the engine starts: the latest release's latest-mac.yml read, this Mac's zip of a newer version
// downloaded (its sha512 as the file says), unpacked and checked, then, once the app's quit, a little script puts it in
// the old one's place and opens it. Downloaded by the app, not a browser, it's not marked as from the internet, so macOS
// asks nothing of it as it opens. What's yours is in ~/Library/Application Support/Pitchroom, untouched.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");

// latest-mac.yml (as release-mac.mjs or electron-builder writes it): its version and its files, {url, sha512, size}
function parseInfo(text) {
  const version = ((text || "").match(/^version:\s*'?([^'\s]+)'?\s*$/m) || [])[1] || "";
  const files = [...(text || "").matchAll(/^\s*-\s*url:\s*(\S+)\s*\n\s*sha512:\s*(\S+)\s*\n\s*size:\s*(\d+)/gm)]
    .map((m) => ({ url: m[1], sha512: m[2], size: Number(m[3]) }));
  return { version, files };
}
// this Mac's zip: Apple silicon's with "arm64" in its name, Intel's without
const zipFor = (files, arch) => files.find((f) => f.url.endsWith(".zip") && /arm64/.test(f.url) === (arch === "arm64")) || null;

// the .app this runs from (execPath: …/Pitchroom.app/Contents/MacOS/Pitchroom), where a new one can be put in its
// place, or null: not run from a disk image (/Volumes), nor moved aside to a place of macOS's own, read-only (App
// Translocation: an app opened where it was downloaded, still marked as from the internet), and it and its folder
// writable (an app put in /Applications by another user may not be)
function bundleOf(execPath) {
  const app = path.resolve(execPath, "..", "..", "..");
  if (!app.endsWith(".app") || app.includes("/AppTranslocation/") || app.startsWith("/Volumes/")) return null;
  try {
    fs.accessSync(path.dirname(app), fs.constants.W_OK);
    fs.accessSync(app, fs.constants.W_OK);
  } catch (e) { return null; }
  return app;
}

// url into the file to, checked against want ({sha512, size}); progress(percent) as it comes. Stopped if nothing comes
// for stall ms.
async function download(url, to, want, progress, stall = 30000) {
  const ctl = new AbortController();
  let idle = setTimeout(() => ctl.abort(), stall);
  const out = fs.createWriteStream(to);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`${path.basename(url)}: ${r.status}`);
    const total = Number(r.headers.get("content-length")) || want.size || 0, hash = crypto.createHash("sha512");
    let got = 0;
    for await (const chunk of r.body) {
      clearTimeout(idle); idle = setTimeout(() => ctl.abort(), stall);
      hash.update(chunk); got += chunk.length;
      if (!out.write(chunk)) await new Promise((ok) => out.once("drain", ok));
      if (total) progress?.(Math.min(100, (got / total) * 100));
    }
    await new Promise((ok, no) => out.end((e) => (e ? no(e) : ok())));
    if (hash.digest("base64") !== want.sha512) throw new Error("the download isn't the release's file");
  } catch (e) {
    out.destroy();
    throw ctl.signal.aborted ? new Error("the download stopped") : e;
  } finally { clearTimeout(idle); }
}

const run = (file, args) => new Promise((ok, no) => execFile(file, args, (e, stdout) => (e ? no(e) : ok(String(stdout)))));
// the zip unpacked in dir (as the Finder would: ditto), its app's version checked; the new app's path. The zip's gone
// after (it's 230 MB).
async function unpack(zip, dir, version) {
  const out = path.join(dir, "new");
  await run("/usr/bin/ditto", ["-x", "-k", zip, out]);
  const app = path.join(out, "Pitchroom.app");
  const v = (await run("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", path.join(app, "Contents", "Info.plist")]).catch(() => "")).trim();
  if (v !== version) throw new Error(`the zip's app is ${v || "unreadable"}, not ${version}`);
  fs.rmSync(zip, { force: true });
  return app;
}

// Run once the app's quit (its pid gone, 30 s at most): the old app moved aside, the new one put in its place, the old
// one put back should that fail; then whichever's there opened. $1 the app's pid, $2 the app, $3 the new one, $4 where
// the old one goes meanwhile, $5 its log.
const SWAP = `#!/bin/sh
pid=$1 app=$2 new=$3 old=$4
exec >>"$5" 2>&1
n=0
while kill -0 "$pid" 2>/dev/null; do
  n=$((n + 1)); [ "$n" -gt 300 ] && { echo "the app didn't quit"; exit 1; }
  sleep 0.1
done
rm -rf "$old"
if mv "$app" "$old"; then
  if mv "$new" "$app"; then rm -rf "$old"; echo "updated"; else mv "$old" "$app"; echo "couldn't put the new one in: the old one's back"; fi
else
  echo "couldn't move the old one aside"
fi
open "$app"
`;
// the script started, apart from the app (so it outlives it), in dir: it waits for pid to end
function swapAfter(pid, app, fresh, dir, script = SWAP) {
  const file = path.join(dir, "swap.sh");
  fs.writeFileSync(file, script);
  spawn("/bin/sh", [file, String(pid), app, fresh, path.join(dir, "old.app"), path.join(dir, "swap.log")], { detached: true, stdio: "ignore" }).unref();
}

module.exports = { parseInfo, zipFor, bundleOf, download, unpack, SWAP, swapAfter };
