// Pitchroom's desktop app: the same page and server as the web version, in a window of its own, with no terminal.
//
// The server runs hidden, with the Python inside the app (runtime/, see scripts/fetch-python.mjs) through an
// environment in the user's folder, so the heavy tools the page installs on first use (pip) land there and outlast
// the app's updates. What's yours (the library, the models, the settings) is kept there too: PITCHROOM_DATA.
//   macOS    ~/Library/Application Support/Pitchroom
//   Windows  %APPDATA%\Pitchroom
// Closing the window quits, and stops the server with it (after asking, while a song is being added).
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, session, shell, systemPreferences } = require("electron");
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const RELEASES = "freaktion-craft/pitchroom-releases"; // public, the installers only (the code's repo is private)
const PORTS = [5278, 5298]; // a range of its own, so a copy started from the repo (5178…) is never taken for this one
const BG = "#0e0e0e"; // --bg, oklch(0.165 0 0): the window before the page paints
const win32 = process.platform === "win32";

const DATA = app.getPath("userData");
const CODE = app.isPackaged ? path.join(process.resourcesPath, "app-code") : path.resolve(__dirname, "..");
const RUNTIME = app.isPackaged ? path.join(process.resourcesPath, "runtime") : path.join(__dirname, "runtime");
const BASE_PY = win32 ? path.join(RUNTIME, "python.exe") : path.join(RUNTIME, "bin", "python3");
const ENV = path.join(DATA, "python");
const ENV_PY = win32 ? path.join(ENV, "Scripts", "python.exe") : path.join(ENV, "bin", "python");
const LOGS = path.join(DATA, "logs"), LOG = path.join(LOGS, "server.log");
const STATE = path.join(DATA, "window.json");

let win = null, server = null, port = 0, quitting = false;

// ---------- the Python environment, in the user's folder ----------
// Made from the app's Python the first time (a fraction of a second: it sees the app's own packages, adds none). After
// an update moves or replaces that Python, it's pointed at the new one (venv --upgrade), keeping what was installed in
// it, unless the version changed (3.11 → 3.12): then it's made again and the tools are installed again from the page.
function run(file, args) {
  return new Promise((ok, fail) => execFile(file, args, { windowsHide: true }, (e, out, err) => (e ? fail(new Error(err || e.message)) : ok(out))));
}
async function ensureEnv() {
  const cfg = path.join(ENV, "pyvenv.cfg");
  const want = (await run(BASE_PY, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"])).trim();
  let have = null, home = null;
  try {
    const text = fs.readFileSync(cfg, "utf8");
    have = (text.match(/^version(?:_info)?\s*=\s*(\d+\.\d+)/m) || [])[1] || null;
    home = (text.match(/^home\s*=\s*(.+)$/m) || [])[1]?.trim() || null;
  } catch {}
  if (have === want && home === path.dirname(BASE_PY) && fs.existsSync(ENV_PY)) return;
  if (have !== want) fs.rmSync(ENV, { recursive: true, force: true });
  else if (!win32) { // --upgrade rewrites pyvenv.cfg but keeps links that are there: these would still point at the old Python
    for (const n of ["python", "python3", `python${want}`]) fs.rmSync(path.join(ENV, "bin", n), { force: true });
  }
  const args = ["-m", "venv", "--system-site-packages", "--without-pip", ...(have === want ? ["--upgrade"] : []), ENV];
  await run(BASE_PY, args);
}

// ---------- the server ----------
function free(p) {
  return new Promise((ok) => { const s = net.createServer().once("error", () => ok(false)).once("listening", () => s.close(() => ok(true))).listen(p, "127.0.0.1"); });
}
async function pickPort() {
  for (let p = PORTS[0]; p < PORTS[1]; p++) if (await free(p)) return p;
  throw new Error(`No free port between ${PORTS[0]} and ${PORTS[1] - 1}.`);
}
async function healthy(p) {
  try { const r = await fetch(`http://127.0.0.1:${p}/api/health`); return r.ok && (await r.json()).app === "stem"; } catch { return false; }
}
async function startServer() {
  await ensureEnv();
  port = await pickPort();
  fs.mkdirSync(LOGS, { recursive: true });
  try { fs.renameSync(LOG, path.join(LOGS, "server.previous.log")); } catch {}
  const log = fs.openSync(LOG, "a");
  const entry = fs.existsSync(path.join(CODE, "server.pyc")) ? "server.pyc" : "server.py"; // a release ships bytecode only (scripts/prepare-code.mjs)
  server = spawn(ENV_PY, [path.join(CODE, entry), String(port)], {
    cwd: CODE, windowsHide: true, detached: !win32, stdio: ["ignore", log, log],
    env: { ...process.env, PITCHROOM_DATA: DATA, PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" },
  });
  server.once("exit", (code) => { server = null; if (!quitting) serverStopped(code); });
  for (let i = 0; i < 300; i++) { // ≤ 30 s: the first start, numpy and the rest loading cold
    if (await healthy(port)) return;
    if (!server) throw new Error("The server stopped as it started.");
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("The server didn't answer within 30 s.");
}
function stopServer() {
  const s = server; server = null;
  if (!s) return;
  if (win32) execFile("taskkill", ["/pid", String(s.pid), "/T", "/F"], { windowsHide: true }, () => {}); // and what it started (pip, ffmpeg)
  else try { process.kill(-s.pid, "SIGTERM"); } catch { try { s.kill("SIGTERM"); } catch {} }
}
async function serverStopped(code) {
  const { response } = await dialog.showMessageBox(win, {
    type: "error", message: "Pitchroom's engine stopped", detail: `It ended with code ${code}. The log says why.`,
    buttons: ["Start it again", "Show log", "Quit"], defaultId: 0, cancelId: 2,
  });
  if (response === 0) { await startServer(); win.loadURL(`http://localhost:${port}/`); }
  else if (response === 1) { shell.showItemInFolder(LOG); serverStopped(code); }
  else app.quit();
}

// ---------- the window ----------
function savedBounds() { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; } }
function createWindow() {
  const b = savedBounds();
  win = new BrowserWindow({
    width: b.width || 1280, height: b.height || 860, x: b.x, y: b.y, minWidth: 720, minHeight: 560,
    title: "Pitchroom", backgroundColor: BG, show: false, autoHideMenuBar: true,
    // macOS: no title bar, the window's buttons alone in the corner above the page, which stays where it is (html.desktop-mac, base.css)
    ...(process.platform === "darwin" ? { titleBarStyle: "hidden" } : {}),
    // DevTools in development only: a released app has no way into its page
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, devTools: !app.isPackaged },
  });
  if (b.maximized) win.maximize();
  const ours = (url) => { try { const u = new URL(url); return u.hostname === "localhost" && +u.port === port; } catch { return false; } };
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!ours(url)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  win.once("ready-to-show", () => win.show());
  win.on("close", async (e) => {
    try { fs.writeFileSync(STATE, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch {}
    if (quitting) return;
    e.preventDefault();
    requestQuit();
  });
  win.loadURL(`http://localhost:${port}/`);
}
// Every way out (the window's close, ⌘Q, the menu) comes here: asked first while something would be lost.
let asking = false;
async function requestQuit() {
  if (asking) return;
  asking = true;
  try {
    if (await busy()) {
      const { response } = await dialog.showMessageBox(win, {
        type: "warning", message: "A song is still being worked on", detail: "Quitting stops it. It can be added again later.",
        buttons: ["Quit", "Keep working"], defaultId: 1, cancelId: 1,
      });
      if (response !== 0) return;
    }
    quitting = true; app.quit();
  } finally { asking = false; }
}
async function busy() { // a song being added, or the tools being installed
  try {
    const [jobs, st] = await Promise.all(["/api/jobs", "/api/stems/status"].map((p) => fetch(`http://127.0.0.1:${port}${p}`).then((r) => r.json())));
    return jobs.length > 0 || st?.install?.status === "running";
  } catch { return false; }
}

// The microphone (and the clipboard, for a copied YouTube link) for the page, never for anything else; on macOS the
// system's own question first, once (NSMicrophoneUsageDescription says why).
function permissions() {
  const ours = (origin) => { try { const u = new URL(origin); return u.hostname === "localhost" && +u.port === port; } catch { return false; } };
  const allowed = new Set(["media", "clipboard-read", "clipboard-sanitized-write", "fullscreen"]);
  session.defaultSession.setPermissionCheckHandler((wc, perm, origin) => allowed.has(perm) && ours(origin));
  session.defaultSession.setPermissionRequestHandler(async (wc, perm, done, details) => {
    if (!allowed.has(perm) || !ours(details.requestingUrl || wc.getURL())) return done(false);
    if (perm === "media" && process.platform === "darwin" && (details.mediaTypes || []).includes("audio")) {
      return done(await systemPreferences.askForMediaAccess("microphone"));
    }
    done(true);
  });
}

// ---------- updates ----------
// Unsigned for now, so no silent update: the latest release on GitHub is looked up, and a newer one offered as a download.
const newer = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
async function checkUpdates(asked) {
  try {
    const r = await fetch(`https://api.github.com/repos/${RELEASES}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
    if (r.status === 404) { if (asked) dialog.showMessageBox(win, { message: "You have the latest Pitchroom", detail: `Version ${app.getVersion()}.` }); return; }
    const rel = await r.json(), v = String(rel.tag_name || "").replace(/^v/, "");
    if (v && newer(v, app.getVersion())) {
      const { response } = await dialog.showMessageBox(win, {
        message: `Pitchroom ${v} is out`, detail: `You have ${app.getVersion()}. Download it, then open the new one in place of this.`,
        buttons: ["Download", "Later"], defaultId: 0, cancelId: 1,
      });
      if (response === 0) shell.openExternal(rel.html_url);
    } else if (asked) dialog.showMessageBox(win, { message: "You have the latest Pitchroom", detail: `Version ${app.getVersion()}.` });
  } catch (e) {
    if (asked) dialog.showMessageBox(win, { type: "warning", message: "Couldn't check for updates", detail: e.message });
  }
}

// ---------- the menu ----------
function menu() {
  const mac = process.platform === "darwin";
  const help = [
    { label: "Show Log", click: () => shell.showItemInFolder(LOG) },
    { label: "Third-Party Notices", click: () => shell.openPath(app.isPackaged ? path.join(process.resourcesPath, "THIRD-PARTY-NOTICES.md") : path.join(__dirname, "THIRD-PARTY-NOTICES.md")) },
    { label: "Open Data Folder", click: () => shell.openPath(DATA) },
    { type: "separator" },
    { label: "Pitchroom Releases", click: () => shell.openExternal(`https://github.com/${RELEASES}/releases`) },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ label: app.name, submenu: [{ role: "about" }, { label: "Check for Updates…", click: () => checkUpdates(true) }, { type: "separator" },
      { role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] }] : []),
    ...(mac ? [] : [{ label: "File", submenu: [{ label: "Check for Updates…", click: () => checkUpdates(true) }, { type: "separator" }, { role: "quit" }] }]),
    { role: "editMenu" },
    { label: "View", submenu: [{ role: "reload" }, ...(app.isPackaged ? [] : [{ role: "toggleDevTools" }]), { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { role: "windowMenu" },
    { role: "help", submenu: help },
  ]));
}

// ---------- start ----------
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  ipcMain.on("relaunch", () => { quitting = true; app.relaunch(); app.quit(); });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (e) => { if (!quitting && win) { e.preventDefault(); requestQuit(); return; } quitting = true; stopServer(); });
  app.whenReady().then(async () => {
    nativeTheme.themeSource = "dark"; // the title bar with the page, which is dark only
    app.setAboutPanelOptions({ applicationName: "Pitchroom", applicationVersion: app.getVersion(), copyright: "© freaktion" });
    menu();
    try { await startServer(); } catch (e) {
      dialog.showErrorBox("Pitchroom couldn't start", `${e.message}\n\nThe log: ${LOG}`);
      quitting = true; stopServer(); return app.quit();
    }
    permissions();
    createWindow();
    setTimeout(() => checkUpdates(false), 8000);
  });
}
