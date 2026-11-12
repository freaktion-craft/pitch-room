// A release's Mac files, built on a Mac and added to that release in freaktion-craft/pitchroom-releases (there are no
// GitHub Actions builds), as after a Windows-only release built on the developer's PC. The release's tag is built as it
// was tagged, in a worktree of its own (its own `npm ci`; never this checkout's node_modules), for Apple silicon and Intel in turn (the app's Python is per processor: fetch-python.mjs
// --arch), and the two builds' update files are made one latest-mac.yml, as electron-builder makes it when it builds
// both at once. Then the dmg, zip and blockmap of each, and latest-mac.yml, are uploaded into the release (by its id: two
// drafts can share a tag), replacing ones of the same name; whether it's the latest is left as it is.
//
//     node scripts/release-mac.mjs [vX.Y.Z] [--dry-run] [--no-upload] [--keep]
//
// vX.Y.Z: the release (default: the latest published one). --dry-run: say what would be done, on any system. --no-upload:
// build only (the files stay in the worktree, kept). --keep: keep the worktree after. Needs: macOS, Node 22.12+, git,
// gh signed in with write access to pitchroom-releases; on Apple silicon, Rosetta for the Intel build (`softwareupdate
// --install-rosetta`). On an Intel Mac only the Intel build can be made (the Apple silicon Python can't run there).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const RELEASES = "freaktion-craft/pitchroom-releases";
const here = path.dirname(fileURLToPath(import.meta.url)), desktop = path.dirname(here), repo = path.dirname(desktop);

// ---------- latest-mac.yml: the two builds' files as one ----------
// Each build's own (its zip first, then its dmg), Intel's first, as electron-builder orders them building both at once
// (zip first, then by arch: x64 before arm64); path and sha512 (for updaters before 2.15) the first zip's. electron-updater
// picks a Mac's own: on Apple silicon the files with "arm64" in their name, on Intel the others (MacUpdater).
export function mergeMacInfo(infos) {
  const versions = new Set(infos.map((i) => String(i.version)));
  if (versions.size !== 1) throw new Error(`the builds' versions differ: ${[...versions].join(", ")}`);
  const files = [...new Map(infos.flatMap((i) => i.files).map((f) => [f.url, f])).values()]; // (one of each)
  const byArch = (arm) => files.filter((f) => /arm64/.test(f.url) === arm).sort((a, b) => b.url.endsWith(".zip") - a.url.endsWith(".zip"));
  const all = [...byArch(false), ...byArch(true)];
  const first = all.find((f) => f.url.endsWith(".zip"));
  if (!first) throw new Error("no zip among the builds' files");
  return { version: infos[0].version, files: all, path: first.url, sha512: first.sha512, releaseDate: infos.map((i) => i.releaseDate).filter(Boolean).sort().pop() || new Date().toISOString() };
}
// a build's update info made from its files, where electron-builder left none (sha512 as it writes it: base64)
export function macInfoOf(dir, version, arch) {
  const files = ["zip", "dmg"].map((ext) => `Pitchroom-${version}-mac-${arch}.${ext}`).filter((f) => fs.existsSync(path.join(dir, f))).map((url) => {
    const buf = fs.readFileSync(path.join(dir, url));
    return { url, sha512: createHash("sha512").update(buf).digest("base64"), size: buf.length };
  });
  if (!files.length) throw new Error(`no Mac files for ${arch} in ${dir}`);
  return { version, files, path: files[0].url, sha512: files[0].sha512, releaseDate: new Date().toISOString() };
}

// ---------- the release ----------
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" });
const ghJson = (...args) => JSON.parse(gh(...args));
// the release a tag names: the published one, else the draft holding the Windows installer, else any draft of it
function findRelease(tag) {
  const all = ghJson("api", `repos/${RELEASES}/releases?per_page=50`).filter((r) => r.tag_name === tag);
  return all.find((r) => !r.draft) || all.find((r) => r.assets.some((a) => a.name === "pitchroom_install.exe")) || all[0] || null;
}
async function upload(release, file, token) {
  const name = path.basename(file);
  for (const a of release.assets.filter((x) => x.name === name)) gh("api", "-X", "DELETE", `repos/${RELEASES}/releases/assets/${a.id}`); // (one of an earlier run)
  const r = await fetch(`https://uploads.github.com/repos/${RELEASES}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
    method: "POST", body: fs.readFileSync(file),
    headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/octet-stream" },
  });
  if (!r.ok) throw new Error(`${name}: upload ${r.status} ${await r.text()}`);
  console.log(`  uploaded ${name}`);
}

async function main() {
  const args = process.argv.slice(2), flag = (f) => args.includes(f);
  const dry = flag("--dry-run"), noUpload = flag("--no-upload"), keep = flag("--keep") || noUpload;
  const tag = args.find((a) => /^v\d+\.\d+\.\d+$/.test(a)) || ghJson("api", `repos/${RELEASES}/releases/latest`).tag_name;
  const version = tag.slice(1);
  const release = findRelease(tag);
  if (!release && !noUpload) throw new Error(`no release ${tag} in ${RELEASES}: release Windows first, or build with --no-upload`);
  execFileSync("git", ["fetch", "--quiet", "origin", "tag", tag], { cwd: repo, stdio: "inherit" });
  const commit = execFileSync("git", ["rev-parse", `${tag}^{commit}`], { cwd: repo, encoding: "utf8" }).trim();
  const host = process.platform === "darwin" ? process.arch : null;
  const archs = host === "x64" ? ["x64"] : ["arm64", "x64"];
  const dir = path.join(os.tmpdir(), `pitchroom-mac-${version}`);
  console.log(`${tag} (${commit.slice(0, 7)}) → ${release ? `release ${release.id}, ${release.draft ? "a draft" : "published"}, with ${release.assets.map((a) => a.name).join(", ") || "nothing"}` : "no release (build only)"}`);
  console.log(`builds: ${archs.join(", ")}, in ${dir}${noUpload ? "; not uploaded" : ""}`);
  if (dry) return;
  if (process.platform !== "darwin") throw new Error("Mac files are built on a Mac (run with --dry-run to see the plan here)");
  if (archs.includes("x64") && host === "arm64") {
    try { execFileSync("arch", ["-x86_64", "/usr/bin/true"]); } catch { throw new Error("the Intel build needs Rosetta: softwareupdate --install-rosetta"); }
  }
  const token = noUpload ? null : execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  if (!noUpload && !token) throw new Error("gh isn't signed in");
  if (host === "x64") console.log("An Intel Mac: the Apple silicon build needs an Apple silicon Mac, so its files aren't added.");

  if (fs.existsSync(dir)) execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: repo, stdio: "inherit" });
  execFileSync("git", ["worktree", "add", "--detach", dir, commit], { cwd: repo, stdio: "inherit" });
  try {
    const wd = path.join(dir, "desktop"), run = (cmd, a) => execFileSync(cmd, a, { cwd: wd, stdio: "inherit" });
    const pro = path.join(repo, "icons.local.js"); // (as the Windows build made here has: the Pro icons, where this copy has them)
    if (fs.existsSync(pro)) fs.copyFileSync(pro, path.join(dir, "icons.local.js"));
    run("npm", ["ci"]);
    const yaml = createRequire(path.join(wd, "package.json"))("js-yaml"); // (the worktree's own, from its npm ci)
    const dist = path.join(wd, "dist"), infos = [];
    for (const [i, arch] of archs.entries()) {
      run("node", ["scripts/fetch-python.mjs", "--arch", arch]);
      if (i === 0) run("node", ["scripts/prepare-code.mjs"]); // (bytecode is the same for both)
      run("npx", ["electron-builder", "--mac", `--${arch}`, "--publish", "never"]);
      const yml = path.join(dist, "latest-mac.yml");
      infos.push(fs.existsSync(yml) ? yaml.load(fs.readFileSync(yml, "utf8")) : macInfoOf(dist, version, arch));
      fs.rmSync(yml, { force: true }); // (the next build writes its own)
    }
    fs.writeFileSync(path.join(dist, "latest-mac.yml"), yaml.dump(mergeMacInfo(infos), { lineWidth: 8000 }));
    const files = fs.readdirSync(dist).filter((f) => f === "latest-mac.yml" || (f.startsWith(`Pitchroom-${version}-mac-`) && /\.(dmg|zip|blockmap)$/.test(f))).map((f) => path.join(dist, f));
    console.log(`built: ${files.map((f) => path.basename(f)).join(", ")}`);
    if (noUpload) { console.log(`kept in ${dist}`); return; }
    for (const f of files) await upload(findRelease(tag), f, token);
    const now = findRelease(tag).assets.map((a) => a.name);
    const want = ["latest-mac.yml", ...archs.map((a) => `Pitchroom-${version}-mac-${a}.dmg`), ...archs.map((a) => `Pitchroom-${version}-mac-${a}.zip`)];
    const missing = want.filter((w) => !now.includes(w));
    if (missing.length) throw new Error(`missing from the release after uploading: ${missing.join(", ")}`);
    console.log(`Done: ${tag}'s Mac files are in https://github.com/${RELEASES}/releases/tag/${tag}`);
  } finally {
    if (!keep) execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: repo, stdio: "inherit" }); // (no junctions in it: its own npm ci)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message || e); process.exit(1); });
