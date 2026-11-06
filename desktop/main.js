// Pitchroom's desktop app: the same page and server as the web version, in a window of its own, with no terminal.
//
// The server runs hidden, with the Python inside the app (runtime/, see scripts/fetch-python.mjs) through an
// environment in the user's folder, so the heavy tools the page installs on first use (pip) land there and outlast
// the app's updates. What's yours (the library, the models, the settings) is kept there too: PITCHROOM_DATA.
//   macOS    ~/Library/Application Support/Pitchroom
//   Windows  %APPDATA%\Pitchroom
// Closing the window quits, and stops the server with it (after asking, while a song is being added).
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, screen, session, shell, systemPreferences } = require("electron");
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { autoUpdater } = require("electron-updater");

const RELEASES = "freaktion-craft/pitchroom-releases"; // public, the installers only (the code's repo is private)
const PORTS = [5278, 5298]; // a range of its own, so a copy started from the repo (5178…) is never taken for this one
// the page's theme (its Theme setting: shade()): the window before the page paints in its --bg (oklch(0.165 0 0), oklch(0.965 0 0)),
// the Windows title bar's buttons in its --ink (oklch(0.94 0 0), oklch(0.2 0 0))
const BG = { dark: "#0e0e0e", light: "#f3f3f3" }, SYMBOL = { dark: "#ebebeb", light: "#161616" };
const win32 = process.platform === "win32";
const TITLEBAR = 32; // Windows: the window's buttons' strip over the page, px (--titlebar, base.css)

// Pitchroom WIP (scripts/wip.ps1): the app as the repo has it at that moment, unreleased work and all, made into a
// folder of its own (no installer) under another name, so it's an app apart: its own folder for what's yours (the
// library, the tools, the settings: %APPDATA%\Pitchroom WIP), its own lock; never updated to a release. package.json's
// "wip" (put in as it's made): which commit it was made from.
const WIP = app.isPackaged ? require("./package.json").wip || "" : "";

const DATA = app.getPath("userData");
// the Theme setting, as the page keeps it (settings.json, beside the library: stems.get_settings): "system" (the default),
// "light" or "dark". As the system's own theme for the window (nativeTheme.themeSource), so the title bar, the page's
// prefers-color-scheme and the window's colours all go with it; the page says when it's changed (setTheme, preload.js)
const THEMES = ["system", "light", "dark"];
function savedTheme() {
  try { const t = JSON.parse(fs.readFileSync(path.join(DATA, "settings.json"), "utf8")).theme; return THEMES.includes(t) ? t : "system"; } catch (e) { return "system"; }
}
const shade = () => (nativeTheme.shouldUseDarkColors ? "dark" : "light");
function paintWindows() { // the theme changed (the setting, or the system's with it on System): the open windows with it
  const s = shade();
  for (const w of [win, splash]) {
    if (!w || w.isDestroyed()) continue;
    w.setBackgroundColor(BG[s]); w.setAccentColor?.(BG[s]);
    if (w === win && win32) w.setTitleBarOverlay({ color: "#00000000", symbolColor: SYMBOL[s], height: TITLEBAR });
  }
}
const CODE = app.isPackaged ? path.join(process.resourcesPath, "app-code") : path.resolve(__dirname, "..");
const RUNTIME = app.isPackaged ? path.join(process.resourcesPath, "runtime") : path.join(__dirname, "runtime");
const BASE_PY = win32 ? path.join(RUNTIME, "python.exe") : path.join(RUNTIME, "bin", "python3");
const ENV = path.join(DATA, "python");
const ENV_PY = win32 ? path.join(ENV, "Scripts", "python.exe") : path.join(ENV, "bin", "python");
const LOGS = path.join(DATA, "logs"), LOG = path.join(LOGS, "server.log");
const STATE = path.join(DATA, "window.json");

let win = null, splash = null, server = null, port = 0, quitting = false;

// ---------- the splash: the name, a bar and a line, while an update comes in and the engine starts ----------
let shown = { text: "Starting…" };
function showSplash() {
  splash = new BrowserWindow({
    width: 360, height: 220, frame: false, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    center: true, show: false, title: "Pitchroom", backgroundColor: BG[shade()], accentColor: BG[shade()],
    webPreferences: { contextIsolation: true, sandbox: true, devTools: !app.isPackaged },
  });
  splash.webContents.on("did-finish-load", () => status(shown.text, shown.percent));
  splash.once("ready-to-show", () => splash?.show());
  splash.on("closed", () => { splash = null; });
  splash.loadFile(path.join(__dirname, "splash.html"), { query: { theme: shade() } });
}
function status(text, percent) {
  shown = { text, percent };
  splash?.webContents.executeJavaScript(`set(${JSON.stringify(shown)})`).catch(() => {});
}
function closeSplash() { if (splash && !splash.isDestroyed()) splash.destroy(); splash = null; }

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
// The page no smaller than PAGE_MIN: 1440 wide, and tall enough for Practice's keyboard under its stage at the least
// the stage goes to (fitStage, js/stage.js: 865 at 1440 wide; a little more under macOS's buttons). The window's frame
// on top of that; on a screen too small for it, the screen's room.
const PAGE_MIN = { w: 1440, h: 880 };
function fitMinimum(w) {
  const [ow, oh] = w.getSize(), [cw, ch] = w.getContentSize(), room = screen.getDisplayMatching(w.getBounds()).workAreaSize;
  const mw = Math.min(room.width, PAGE_MIN.w + ow - cw), mh = Math.min(room.height, PAGE_MIN.h + oh - ch);
  w.setMinimumSize(mw, mh);
  if (!w.isMaximized() && (ow < mw || oh < mh)) w.setSize(Math.max(ow, mw), Math.max(oh, mh)); // a size kept from smaller, up to it
}
function createWindow() {
  const b = savedBounds(), room = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: b.width || Math.min(room.width, 1520), height: b.height || Math.min(room.height, 960), x: b.x, y: b.y,
    title: app.name, backgroundColor: BG[shade()], show: false, autoHideMenuBar: true,
    accentColor: BG[shade()], // Windows 11: its edge the page's own colour (a pale line, or a dark one, round the window otherwise)
    // macOS: no title bar, the window's buttons alone in the corner above the page, which stays where it is (html.desktop-mac, base.css)
    // Windows: no title bar of the system's either, its three buttons drawn over the page's top right corner, on the
    // page, in its ink, as tall as the strip along the top that moves the window (html.desktop-win, base.css)
    ...(process.platform === "darwin" ? { titleBarStyle: "hidden" }
      : win32 ? { titleBarStyle: "hidden", titleBarOverlay: { color: "#00000000", symbolColor: SYMBOL[shade()], height: TITLEBAR } } : {}), // (clear: on what's there, the first steps' picture too)
    // DevTools in development only: a released app has no way into its page
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, devTools: !app.isPackaged },
  });
  fitMinimum(win); win.on("moved", () => fitMinimum(win)); // (another screen, another room)
  if (WIP) win.on("page-title-updated", (e) => { e.preventDefault(); win.setTitle(`Pitchroom WIP · ${WIP}`); }); // told apart from the release in the taskbar, and which it is
  if (b.maximized) win.maximize();
  const ours =(url) => { try { const u = new URL(url); return u.hostname === "localhost" && +u.port === port; } catch { return false; } };
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!ours(url)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  win.once("ready-to-show", () => { win.show(); closeSplash(); });
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
    return jobs.some((j) => j.status === "queued" || j.status === "running") || st?.install?.status === "running"; // (not one only waiting for its lyrics pasted)
  } catch { return false; }
}

// The microphone (and the clipboard, for a copied YouTube link) for the page, never for anything else; on macOS the
// system's own question first, once (NSMicrophoneUsageDescription says why).
function permissions() {
  const ours = (origin) => { try { const u = new URL(origin); return u.hostname === "localhost" && +u.port === port; } catch { return false; } };
  const allowed = new Set(["media", "clipboard-read", "clipboard-sanitized-write", "fullscreen", "speaker-selection"]); // (speaker-selection: Live's output, live.js)
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
// Windows and the Linux AppImage update themselves, in the splash before the engine starts: the latest release's
// latest.yml looked up (≤ 5 s, or it's skipped this time), a newer version downloaded, installed silently and opened.
// macOS can't till the app's signed (Squirrel.Mac checks the signature): a newer release is offered as a download.
const SELF_UPDATES = app.isPackaged && !WIP && (win32 || (process.platform === "linux" && !!process.env.APPIMAGE)); // (WIP: never a release over it)
const within = (ms, p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`no answer in ${ms / 1000} s`)), ms))]);
async function updateFirst() { // true: it's installing, the app's about to quit
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;
  autoUpdater.disableDifferentialDownload = true; // the whole installer in one go: from GitHub, 244 MB took 3 s that way, the changed parts alone (216 ranges) 3 min
  try {
    status("Checking for updates…");
    const r = await within(5000, autoUpdater.checkForUpdates());
    const v = r?.updateInfo?.version;
    if (!v || !newer(v, app.getVersion())) return false;
    let stalled = null;
    const stall = new Promise((_, no) => { stalled = no; });
    let idle = setTimeout(() => stalled(new Error("the download stopped")), 30000);
    autoUpdater.on("download-progress", (p) => {
      clearTimeout(idle); idle = setTimeout(() => stalled(new Error("the download stopped")), 30000);
      status(`Updating to ${v} · ${Math.floor(p.percent)}%`, p.percent);
    });
    status(`Updating to ${v}`, 0);
    await Promise.race([autoUpdater.downloadUpdate(), stall]);
    clearTimeout(idle);
    status("Installing…"); // no percent: the bar swings while the installer works (it says nothing of how far it is)
    quitting = true;
    await standIn(); // the splash left to its double while the installer has the app closed
    setImmediate(() => autoUpdater.quitAndInstall(true, true)); // silent, then the new one opens
    return true;
  } catch (e) {
    console.error("update skipped:", e.message); // and the app starts as it is
    return false;
  }
}
// The installer closes the app before it puts the new one in, and shows nothing of its own (about 40 s), so first the
// splash is left to a double of it (update-splash.ps1, through Windows' own PowerShell: not the app, so not closed
// with it). In the splash's place, its colours, its bar in step with it, then filling as the new one goes in; it goes
// when the new one shows its splash there. Resolves once the double's up (true), or without it after 4 s (false): the
// update goes on either way. Through conhost --headless: a console of its own that no one sees (no window, not even
// Windows Terminal's), and detached, so it's no child of this app's (Node's children on Windows end with it).
// splash.html's colours, #AARRGGBB; its line's 50 % ink as it comes out on the page (WPF draws see-through text lighter)
const SWING = { dark: ["#FF0E0E0E", "#1FFFFFFF", "#FFD4D4D4", "#FF878787"], light: ["#FFF3F3F3", "#1F000000", "#FF333333", "#FF7A7A7A"] };
function standIn() {
  return new Promise((ok) => {
    if (!win32 || !splash || splash.isDestroyed()) return ok(false);
    try {
      const tmp = app.getPath("temp"), script = path.join(tmp, "pitchroom-update-splash.ps1"), ready = path.join(tmp, "pitchroom-update-splash.ready");
      fs.writeFileSync(script, fs.readFileSync(path.join(__dirname, "update-splash.ps1"))); // out of app.asar, where PowerShell can read it
      fs.rmSync(ready, { force: true });
      const dip = splash.getBounds(), px = screen.dipToScreenRect(splash, dip), scale = screen.getDisplayMatching(dip).scaleFactor;
      const [bg, track, fill, ink] = SWING[shade()], sys = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
      spawn(path.join(sys, "conhost.exe"), ["--headless", path.join(sys, "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoProfile", "-NonInteractive",
        "-ExecutionPolicy", "Bypass", "-File", script, "-X", px.x, "-Y", px.y, "-W", px.width, "-H", px.height, "-Scale", scale,
        "-Bg", bg, "-Track", track, "-Fill", fill, "-Ink", ink, "-Text", shown.text, "-Progress", "Installing · {0}%", "-Old", process.pid, "-Dir", path.dirname(process.execPath), "-Ready", ready].map(String),
        { detached: true, windowsHide: true, stdio: "ignore" }).unref();
      const t0 = Date.now(), iv = setInterval(() => {
        const up = fs.existsSync(ready);
        if (up || Date.now() - t0 > 4000) { clearInterval(iv); ok(up); }
      }, 50);
    } catch (e) { console.error("no stand-in:", e.message); ok(false); }
  });
}
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
  // the system's own light or dark (the window's set to the page's theme, so the page can't see it), for what's laid out as the
  // system's own is (the mic's ask): macOS's appearance; Windows' apps' theme, light unless it's set dark
  ipcMain.handle("system-theme", () => new Promise((ok) => {
    if (process.platform === "darwin") return ok(systemPreferences.getUserDefault("AppleInterfaceStyle", "string") === "Dark" ? "dark" : "light");
    if (process.platform !== "win32") return ok("dark");
    execFile("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize", "/v", "AppsUseLightTheme"], { windowsHide: true },
      (e, out) => ok(!e && /AppsUseLightTheme\s+REG_DWORD\s+0x0\b/.test(out) ? "dark" : "light"));
  }));
  ipcMain.on("attention", (e) => { // not if you're looking already
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w || w.isFocused()) return;
    if (process.platform === "darwin") app.dock?.bounce("informational"); else w.flashFrame(true);
  });
  ipcMain.handle("mic-access", () => (process.platform === "linux" ? "granted" : systemPreferences.getMediaAccessStatus("microphone"))); // (asked yet? allowed?)
  ipcMain.on("mic-settings", () => shell.openExternal(process.platform === "darwin" // where the mic's allowed for apps, once refused
    ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone" : "ms-settings:privacy-microphone"));
  ipcMain.handle("pick-folder", async (e) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
      title: "The Pitchroom beta folder", buttonLabel: "Import", defaultPath: app.getPath("downloads"), properties: ["openDirectory"],
    });
    return r.canceled ? null : r.filePaths[0] || null;
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (e) => { if (!quitting && win) { e.preventDefault(); requestQuit(); return; } quitting = true; stopServer(); });
  app.whenReady().then(async () => {
    nativeTheme.themeSource = savedTheme(); // the title bar, and the splash, with the page from the first
    nativeTheme.on("updated", paintWindows);
    ipcMain.on("theme", (e, t) => { nativeTheme.themeSource = THEMES.includes(t) ? t : "system"; paintWindows(); });
    app.setAboutPanelOptions({ applicationName: "Pitchroom", applicationVersion: app.getVersion(), copyright: "© freaktion" });
    menu();
    showSplash();
    if (SELF_UPDATES && (await updateFirst())) return;
    status("Starting…");
    try { await startServer(); } catch (e) {
      closeSplash();
      dialog.showErrorBox("Pitchroom couldn't start", `${e.message}\n\nThe log: ${LOG}`);
      quitting = true; stopServer(); return app.quit();
    }
    permissions();
    createWindow();
    if (!SELF_UPDATES && !WIP) setTimeout(() => checkUpdates(false), 8000);
  });
}
