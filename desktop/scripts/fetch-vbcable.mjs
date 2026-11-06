// VB-CABLE (VB-Audio's virtual audio cable, donationware: www.vb-cable.com), for Live's mic on Windows, into
// desktop/vbcable: the official driver pack as it comes, unchanged (its licence allows passing it on as is). The app
// runs its own setup from there when the Live panel's "Set up the mic" is pressed (main.js, cable-setup): the user
// sees VB-CABLE's own installer and agrees to its terms there.
//
//     node scripts/fetch-vbcable.mjs
//
// The download is checked against the hash below (a new pack is a deliberate change). Run again to start over.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const URL = "https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip";
const SHA256 = "b950e39f01af1d04ea623c8f6d8eb9b6ea5c477c637295fabf20631c85116bfb"; // Pack45, October 2024
const desktop = path.dirname(path.dirname(fileURLToPath(import.meta.url))), out = path.join(desktop, "vbcable");

console.log("VB-CABLE driver pack…");
const r = await fetch(URL);
if (!r.ok) throw new Error(`${URL}: ${r.status}`);
const zip = Buffer.from(await r.arrayBuffer());
const got = createHash("sha256").update(zip).digest("hex");
if (got !== SHA256) throw new Error(`VB-CABLE pack: SHA-256 ${got}, expected ${SHA256}`);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const file = path.join(out, "VBCABLE_Driver_Pack45.zip");
fs.writeFileSync(file, zip);
const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "bsdtar"; // Windows' own (bsdtar) reads zips; a GNU tar on the PATH (Git's) doesn't
execFileSync(tar, ["-xf", "VBCABLE_Driver_Pack45.zip"], { cwd: out, stdio: "inherit" });
fs.rmSync(file);
if (!fs.existsSync(path.join(out, "VBCABLE_Setup_x64.exe"))) throw new Error("VB-CABLE pack: no VBCABLE_Setup_x64.exe in it");
console.log(`Done: ${path.relative(desktop, out)} (${fs.readdirSync(out).length} files)`);
