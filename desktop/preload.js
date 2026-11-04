// What the page may ask of the desktop app (window.pitchroom; absent in a browser): that it's there, and a restart
// (the GPU's PyTorch, once installed, is only taken up by a new server).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pitchroom", {
  desktop: true,
  platform: process.platform,
  restart: () => ipcRenderer.send("relaunch"),
});
