// The Pro icons for the Windows build GitHub Actions makes (.github/workflows/windows.yml): this checkout's
// icons.local.js (never in the repo) gzipped, in base64, into the repo's Actions secrets ICONS_LOCAL_1 to 6, each part
// short enough for a variable on Windows (32,767 characters). Parts an earlier, longer file left are deleted. Run it
// before a release's tag is pushed: the build takes the icons as they are then.
//
//     node scripts/icons-secret.mjs [--dry-run]
//
// Needs gh signed in as someone who can set this repo's secrets.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const CODE = "freaktion-craft/pitch-room", NAME = "ICONS_LOCAL_", PARTS = 6, PART = 30000;
const repo = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

export function iconParts(buf) {
  const b64 = zlib.gzipSync(buf, { level: 9 }).toString("base64"), parts = [];
  for (let i = 0; i < b64.length; i += PART) parts.push(b64.slice(i, i + PART));
  if (parts.length > PARTS) throw new Error(`icons.local.js needs ${parts.length} parts and the workflow reads ${PARTS}: raise both`);
  return parts;
}

function main() {
  const dry = process.argv.includes("--dry-run"), file = path.join(repo, "icons.local.js");
  if (!fs.existsSync(file)) throw new Error("no icons.local.js in this checkout");
  const parts = iconParts(fs.readFileSync(file));
  console.log(`icons.local.js: ${fs.statSync(file).size} bytes, ${parts.length} part${parts.length > 1 ? "s" : ""} of ${PARTS}`);
  if (dry) return;
  const have = execFileSync("gh", ["secret", "list", "--repo", CODE, "--app", "actions", "--json", "name", "--jq", ".[].name"], { encoding: "utf8" }).split("\n").filter(Boolean);
  parts.forEach((p, i) => execFileSync("gh", ["secret", "set", NAME + (i + 1), "--repo", CODE, "--app", "actions"], { input: p, stdio: ["pipe", "inherit", "inherit"] })); // (the value on stdin: never in a command line)
  for (let i = parts.length + 1; i <= PARTS; i++) if (have.includes(NAME + i)) execFileSync("gh", ["secret", "delete", NAME + i, "--repo", CODE, "--app", "actions"], { stdio: "inherit" });
  console.log(`Done: ${NAME}1 to ${parts.length} set in ${CODE}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) try { main(); } catch (e) { console.error(e.message || e); process.exit(1); }
