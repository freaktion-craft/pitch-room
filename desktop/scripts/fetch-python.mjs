// The desktop app's own Python: a standalone CPython (Astral's python-build-standalone, the builds uv uses) for this
// OS and processor, into desktop/runtime, with the base packages (../requirements.txt) put in it, all but
// praat-parselmouth (GPL-3.0, so not shipped in the app; melody.py only falls back to it without librosa). Those include
// yt-dlp and deno (~50 MB), so a song's found (its name, artist, art; a playlist's songs) from the start; the app keeps
// yt-dlp current itself (stems.freshen_finders). The heavy tools (requirements-stems.txt) aren't: the app installs those
// when the first song's added, into an environment in the user's folder.
//
//     node scripts/fetch-python.mjs [--arch arm64|x64]
//
// The download is checked against the release's SHA256SUMS. Run again to start over.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE = "20261026", VERSION = "3.11.18"; // pinned: a new one is a deliberate change
const here = path.dirname(fileURLToPath(import.meta.url)), desktop = path.dirname(here), repo = path.dirname(desktop);
const out = path.join(desktop, "runtime");
const arch = process.argv.includes("--arch") ? process.argv[process.argv.indexOf("--arch") + 1] : process.arch;
const triple = {
  darwin: { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" },
  win32: { x64: "x86_64-pc-windows-msvc" },
}[process.platform]?.[arch];
if (!triple) throw new Error(`No Python build for ${process.platform} ${arch}`);

const name = `cpython-${VERSION}+${RELEASE}-${triple}-install_only.tar.gz`;
const base = `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE}`;
const get = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return Buffer.from(await r.arrayBuffer()); };

console.log(`Python ${VERSION} for ${triple}…`);
const sums = (await get(`${base}/SHA256SUMS`)).toString();
const want = sums.split("\n").map((l) => l.trim().split(/\s+/)).find(([, f]) => f === name)?.[0];
if (!want) throw new Error(`${name} isn't in SHA256SUMS`);
const tgz = await get(`${base}/${name}`);
const got = createHash("sha256").update(tgz).digest("hex");
if (got !== want) throw new Error(`${name}: SHA-256 ${got}, expected ${want}`);

const tmp = fs.mkdtempSync(path.join(desktop, ".python-")); // beside runtime/, not in the temp folder: on another drive (Windows CI) it can't be moved
fs.writeFileSync(path.join(tmp, name), tgz);
execFileSync("tar", ["-xzf", name], { cwd: tmp, stdio: "inherit" }); // the archive holds python/
fs.rmSync(out, { recursive: true, force: true });
fs.renameSync(path.join(tmp, "python"), out);
fs.rmSync(tmp, { recursive: true, force: true });

const py = process.platform === "win32" ? path.join(out, "python.exe") : path.join(out, "bin", "python3");
const lib = process.platform === "win32" ? path.join(out, "Lib") : path.join(out, "lib", `python${VERSION.split(".").slice(0, 2).join(".")}`);
for (const d of ["test", "idlelib", "tkinter", "turtledemo"]) fs.rmSync(path.join(lib, d), { recursive: true, force: true }); // unused, ~40 MB
console.log("Base packages…");
const packages = fs.readFileSync(path.join(repo, "requirements.txt"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !/^praat-parselmouth\b/.test(l));
execFileSync(py, ["-m", "pip", "install", "--disable-pip-version-check", "--no-warn-script-location", "-q", ...packages], { stdio: "inherit" });
console.log(`Done: ${path.relative(repo, py)}`);
