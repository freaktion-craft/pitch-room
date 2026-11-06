// What the page may ask of the desktop app (window.pitchroom; absent in a browser): that it's there, a restart
// (the GPU's PyTorch, once installed, is only taken up by a new server), and the system's mic settings.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pitchroom", {
  desktop: true,
  platform: process.platform,
  restart: () => ipcRenderer.send("relaunch"),
  systemTheme: () => ipcRenderer.invoke("system-theme"), // the system's own "light" or "dark" (the window's the page's theme)
  setTheme: (t) => ipcRenderer.send("theme", t), // the Theme setting changed ("system", "light", "dark"): the window with it
  micAccess: () => ipcRenderer.invoke("mic-access"), // what the system says of the mic: "not-determined", "granted", "denied" or "restricted"
  micSettings: () => ipcRenderer.send("mic-settings"),
  cableSetupThere: () => ipcRenderer.invoke("cable-setup-there"), // Live's mic: whether this copy carries VB-CABLE's setup
  cableSetup: () => ipcRenderer.invoke("cable-setup"), // and runs it: "ok", "cancelled" or "none"
  pickFolder: () => ipcRenderer.invoke("pick-folder"), // the beta's folder, for Import beta library: its path, or null
  attention: () => ipcRenderer.send("attention"), // something done meanwhile: the Dock icon bounces once, the taskbar's flashes // the system's own Microphone privacy page, where a refused mic is allowed again
});
