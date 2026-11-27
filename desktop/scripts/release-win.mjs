// A release's Windows files, built by GitHub Actions when the tag was pushed (.github/workflows/windows.yml: built,
// installed and started there) and added to that release in freaktion-craft/pitchroom-releases from here, where gh can
// write to it (the run itself holds no token for that repo). The tag's run is found, its artifact "pitchroom-windows"
// downloaded, latest.yml checked against the tag and the installer, and the three files uploaded into the release by its
// id, replacing ones of the same name, as release-mac.mjs does the Mac's.
//
//     node scripts/release-win.mjs vX.Y.Z [--dry-run] [--wait]
//
// --dry-run: say what would be done. --wait: a run still going is waited for (gh run watch); without it, that stops
// here. Needs: git, gh signed in with write access to pitchroom-releases. On any system.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RELEASES, gh, ghJson, findRelease, upload } from "./release-mac.mjs";

const CODE = "freaktion-craft/pitch-room", WORKFLOW = "windows.yml", ARTIFACT = "pitchroom-windows";
const FILES = ["pitchroom_install.exe", "pitchroom_install.exe.blockmap", "latest.yml"];
const repo = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

// latest.yml as electron-builder writes it for the one installer: its version, the file it names, and that file's
// sha512 and size, against the installer downloaded beside it
export function checkWinInfo(dir, version) {
  for (const f of FILES) if (!fs.existsSync(path.join(dir, f)) || !fs.statSync(path.join(dir, f)).size) throw new Error(`${f} isn't in the run's artifact`);
  const yml = fs.readFileSync(path.join(dir, "latest.yml"), "utf8"), exe = fs.readFileSync(path.join(dir, "pitchroom_install.exe"));
  const of = (k) => (yml.match(new RegExp(`^\\s*${k}: (.+?)\\s*$`, "m")) || [])[1]?.replace(/^(['"])(.*)\1$/, "$2");
  const sha = createHash("sha512").update(exe).digest("base64");
  if (of("version") !== version) throw new Error(`latest.yml says ${of("version")}, the tag ${version}`);
  if (of("path") !== "pitchroom_install.exe") throw new Error(`latest.yml names ${of("path")}, not pitchroom_install.exe`);
  if (of("sha512") !== sha) throw new Error("latest.yml's sha512 isn't this installer's");
  if (of("size") && +of("size") !== exe.length) throw new Error(`latest.yml says ${of("size")} bytes, the installer is ${exe.length}`);
  return { sha, bytes: exe.length };
}
// the tag's own run: the newest of its pushes, of the commit the tag names
export function tagRun(runs, commit) {
  return runs.filter((r) => r.headSha === commit).sort((a, b) => b.databaseId - a.databaseId)[0] || null;
}

async function main() {
  const args = process.argv.slice(2), dry = args.includes("--dry-run"), wait = args.includes("--wait");
  const tag = args.find((a) => /^v\d+\.\d+\.\d+$/.test(a));
  if (!tag) throw new Error("which release? node scripts/release-win.mjs vX.Y.Z");
  const version = tag.slice(1), release = findRelease(tag);
  if (!release) throw new Error(`no release ${tag} in ${RELEASES}: make its draft first`);
  execFileSync("git", ["fetch", "--quiet", "origin", "tag", tag], { cwd: repo, stdio: "inherit" });
  const commit = execFileSync("git", ["rev-parse", `${tag}^{commit}`], { cwd: repo, encoding: "utf8" }).trim();
  const list = () => tagRun(ghJson("run", "list", "--repo", CODE, "--workflow", WORKFLOW, "--branch", tag, "--event", "push", "--limit", "10", "--json", "databaseId,status,conclusion,headSha,url"), commit);
  let run = list();
  if (!run) throw new Error(`no run of ${WORKFLOW} for ${tag} (${commit.slice(0, 7)}): was the tag pushed, and are Actions on for ${CODE}?`);
  console.log(`${tag} (${commit.slice(0, 7)}) → release ${release.id}, ${release.draft ? "a draft" : "published"}, with ${release.assets.map((a) => a.name).join(", ") || "nothing"}`);
  console.log(`run ${run.databaseId}: ${run.status}${run.conclusion ? `, ${run.conclusion}` : ""} ${run.url}`);
  if (dry) return;
  if (run.status !== "completed") {
    if (!wait) throw new Error("the run is still going: wait for it, or pass --wait");
    try { execFileSync("gh", ["run", "watch", String(run.databaseId), "--repo", CODE, "--interval", "30", "--exit-status"], { stdio: "inherit" }); } catch {} // (what it ended as is asked next)
    run = list();
  }
  if (!run || run.status !== "completed" || run.conclusion !== "success") throw new Error(`the run didn't pass (${run ? run.conclusion || run.status : "gone"}): ${run ? run.url : ""}`);

  const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  if (!token) throw new Error("gh isn't signed in");
  const dir = path.join(os.tmpdir(), `pitchroom-win-${version}`);
  fs.rmSync(dir, { recursive: true, force: true });
  gh("run", "download", String(run.databaseId), "--repo", CODE, "--name", ARTIFACT, "--dir", dir);
  const { sha, bytes } = checkWinInfo(dir, version);
  console.log(`downloaded: pitchroom_install.exe, ${(bytes / 1048576).toFixed(1)} MB, sha512 ${sha}`);
  for (const f of FILES) await upload(findRelease(tag), path.join(dir, f), token);
  const now = findRelease(tag).assets.map((a) => a.name), missing = FILES.filter((f) => !now.includes(f));
  if (missing.length) throw new Error(`missing from the release after uploading: ${missing.join(", ")}`);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`Done: ${tag}'s Windows files are in the release (${findRelease(tag).html_url})`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message || e); process.exit(1); });
