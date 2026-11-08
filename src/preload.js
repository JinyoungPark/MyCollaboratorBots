// 화면(ui)에 꼭 필요한 통로 하나만 열어 준다: window.mcb.call(경로, 내용)
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mcb", {
  call: (url, body) => ipcRenderer.invoke("api", url, body),
  onBot: (cb) => ipcRenderer.on("bot-event", (_e, ev) => cb(ev)),
  onSignIn: (cb) => ipcRenderer.on("ai-signin", (_e, ev) => cb(ev)),
  onUpdate: (cb) => ipcRenderer.on("update-event", (_e, ev) => cb(ev)),
});
