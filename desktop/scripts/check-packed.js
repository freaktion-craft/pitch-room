// electron-builder's afterPack: every package the app needs at run time is in app.asar, or the build fails. (1.0.18
// shipped electron-updater without its own dependencies and couldn't start: it was built through a junctioned
// node_modules, which electron-builder only warned about, "cannot find path for dependency".)
const fs = require("fs");
const path = require("path");
const asar = require("@electron/asar");

const desk = path.join(__dirname, "..");

// a package's folder as Node finds it from dir: node_modules/<name> there or in a folder above
function find(name, dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    const p = path.join(d, "node_modules", name);
    if (fs.existsSync(path.join(p, "package.json"))) return p;
    if (path.dirname(d) === d) return null;
  }
}

// the names of every package the app's dependencies need, all the way down (dependencies only: not dev, peer or
// optional ones)
function needed() {
  const own = JSON.parse(fs.readFileSync(path.join(desk, "package.json"), "utf8"));
  const names = new Set(), seen = new Set(), todo = Object.keys(own.dependencies || {}).map((n) => [n, desk]);
  while (todo.length) {
    const [name, from] = todo.pop();
    const dir = find(name, from);
    if (!dir) throw new Error(`${name} isn't installed in desktop/node_modules (run npm ci there)`);
    names.add(name);
    if (seen.has(dir)) continue;
    seen.add(dir);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    for (const dep of Object.keys(pkg.dependencies || {})) todo.push([dep, dir]);
  }
  return names;
}

// the names of the packages in the asar, at any depth
function packed(file) {
  const names = new Set();
  for (const f of asar.listPackage(file)) {
    const m = f.split(path.sep).join("/").match(/node_modules\/((?:@[^/]+\/)?[^/]+)\/package\.json$/);
    if (m) names.add(m[1]);
  }
  return names;
}

exports.default = async function checkPacked(context) {
  const name = context.packager?.appInfo?.productFilename || "Pitchroom";
  const file = [
    path.join(context.appOutDir, "resources", "app.asar"), // Windows
    path.join(context.appOutDir, `${name}.app`, "Contents", "Resources", "app.asar"), // macOS
  ].find((f) => fs.existsSync(f));
  if (!file) throw new Error(`check-packed: no app.asar under ${context.appOutDir}`);
  const want = needed(), have = packed(file);
  const missing = [...want].filter((n) => !have.has(n)).sort();
  if (missing.length) throw new Error(`check-packed: app.asar lacks ${missing.join(", ")} (the app won't start without them)`);
  console.log(`  • packed dependencies checked  count=${want.size}`);
};
