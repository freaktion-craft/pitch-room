// The code the desktop app ships, made from the repo's into desktop/build-code: the page's scripts and styles
// minified (no comments; a function's own names shortened; the top-level ones kept, as the scripts share them), and the
// Python compiled by the app's own Python (runtime/, scripts/fetch-python.mjs) into bytecode without its docstrings,
// with no .py files beside it. What the server fills into index.html (/*SETTINGS*/null and the others) is kept.
//
//     node scripts/prepare-code.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { minify } from "terser";
import { transform } from "lightningcss";

const desktop = path.dirname(path.dirname(fileURLToPath(import.meta.url))), repo = path.dirname(desktop);
const out = path.join(desktop, "build-code");
const PY = ["server", "stems", "melody", "syllables", "lyrics", "covers", "playlists"];
const COPY = ["favicon.svg", "requirements-stems.txt", "LICENSE"];
const py = process.platform === "win32" ? path.join(desktop, "runtime", "python.exe") : path.join(desktop, "runtime", "bin", "python3");
if (!fs.existsSync(py)) throw new Error("No runtime/: run `npm run python` first.");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "js"), { recursive: true });
fs.mkdirSync(path.join(out, "css"), { recursive: true });
for (const f of COPY) fs.copyFileSync(path.join(repo, f), path.join(out, f));

const js = async (code, name) => {
  const r = await minify(code, { ecma: 2022, compress: { passes: 2 }, mangle: true, toplevel: false, format: { comments: false } });
  if (r.code == null) throw new Error(`${name}: terser gave nothing`);
  return r.code;
};
for (const f of fs.readdirSync(path.join(repo, "js")).filter((f) => f.endsWith(".js"))) {
  fs.writeFileSync(path.join(out, "js", f), await js(fs.readFileSync(path.join(repo, "js", f), "utf8"), f));
}
for (const f of fs.readdirSync(path.join(repo, "css")).filter((f) => f.endsWith(".css"))) {
  const { code } = transform({ filename: f, code: fs.readFileSync(path.join(repo, "css", f)), minify: true });
  fs.writeFileSync(path.join(out, "css", f), code);
}

// index.html: its comments gone, its inline scripts minified, the server's placeholders put back as they were
let html = fs.readFileSync(path.join(repo, "index.html"), "utf8");
const holes = ["SETTINGS", "LIBRARY", "UPDATE"];
html = html.replace(/<!--[\s\S]*?-->/g, "");
const parts = [], re = /<script>([\s\S]*?)<\/script>/g;
let last = 0;
for (let m; (m = re.exec(html)); ) {
  let code = m[1];
  for (const h of holes) code = code.split(`/*${h}*/null`).join(`__PITCHROOM_${h}__`);
  code = await js(code, "index.html");
  for (const h of holes) code = code.split(`__PITCHROOM_${h}__`).join(`/*${h}*/null`);
  parts.push(html.slice(last, m.index), `<script>${code}</script>`);
  last = m.index + m[0].length;
}
parts.push(html.slice(last));
html = parts.join("").replace(/\n\s*\n/g, "\n");
for (const h of holes) if (!html.includes(`/*${h}*/null`)) throw new Error(`index.html lost /*${h}*/null`);
fs.writeFileSync(path.join(out, "index.html"), html);

// the Python: bytecode beside where the .py would be (-b, so it's imported without its source), docstrings dropped
for (const f of PY) fs.copyFileSync(path.join(repo, `${f}.py`), path.join(out, `${f}.py`));
execFileSync(py, ["-OO", "-m", "compileall", "-b", "-q", "-o", "2", out], { stdio: "inherit" });
for (const f of PY) fs.rmSync(path.join(out, `${f}.py`));
fs.rmSync(path.join(out, "__pycache__"), { recursive: true, force: true });
console.log(`build-code: ${fs.readdirSync(out).join(", ")}`);
