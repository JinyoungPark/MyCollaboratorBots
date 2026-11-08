// MyCollaboratorBots — Electron 본체. 창을 띄우고, 화면의 요청(봇·팀·대화·AI 연결·업데이트)을 처리한다.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const store = require("./store");
const ai = require("./ai");
const bots = require("./bots");
const docs = require("./docsearch");
const schedule = require("./schedule");
const applog = require("./applog");
const updater = require("./updater");
const version = require("./version");

if (process.env.MCB_DATA) app.setPath("userData", process.env.MCB_DATA);   // 시험용 저장 위치
// '--finish-update': 받아 둔 새 버전이 앱 폴더의 파일을 바꿔 끼울 때 (src/updater.js). 창 없이 그 일만
const UPDATING = process.argv.includes("--finish-update");
if (UPDATING) updater.finishFromArgs(require("electron"));
else if (!app.requestSingleInstanceLock()) app.quit();          // 두 번 실행하면 이미 열린 창을 앞으로
// 예상하지 못한 오류는 앱을 멈추지 않고 문제 기록에 남긴다 (설정 → 정보 → 진단 정보 복사)
process.on("uncaughtException", (e) => { console.error(e); applog.error("main", e); });
process.on("unhandledRejection", (e) => { console.error(e); applog.error("main", "처리 안 된 약속:", e); });

let win = null;
let db = null;
const send = (ch, ev) => { if (win && !win.isDestroyed()) win.webContents.send(ch, ev); };
const PROVIDERS = ["claude", "codex", "gemini"];

// 연결 끊기: 이 앱에서 그 AI를 쓰지 않게만 한다 (로그인은 이 PC의 다른 프로그램과 함께 쓰므로 그대로)
const aiOff = () => ({ claude: false, codex: false, gemini: false, ...(store.loadConfig().ai_off || {}) });
function setAiOff(target, off) {
  const cfg = store.loadConfig();
  cfg.ai_off = { ...aiOff(), [target]: off };
  store.saveConfig(cfg);
}

// AI 프로그램이 실행될 빈 폴더 (다른 프로젝트 설정이 끼어들지 않게)
function aiWorkDir() {
  const dir = path.join(app.getPath("userData"), "ai-work");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
// 봇의 답을 문서로 저장하는 곳: 문서/MyCollaboratorBots
const saveDir = () => process.env.MCB_SAVE_DIR || path.join(app.getPath("documents"), "MyCollaboratorBots");
const safeName = (s) => String(s || "").replace(/[\\/:*?"<>|\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "새 문서";
function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const { dir, name, ext } = path.parse(p);
  for (let i = 2; ; i++) { const q = path.join(dir, `${name} (${i})${ext}`); if (!fs.existsSync(q)) return q; }
}

async function handle(url, body) {
  switch (url) {
    // ---------- 봇 · 팀 · 대화 (src/bots.js) ----------
    case "/api/bots":
      return { bots: bots.bots(), rooms: bots.rooms(), actions: bots.ACTIONS, docs: docs.status() };
    case "/api/bots/save":
      try { return { ok: true, id: bots.saveBot(body) }; } catch (e) { return { ok: false, message: e.message }; }
    case "/api/bots/remove":
      try { bots.removeBot(body.id); return { ok: true }; } catch (e) { return { ok: false, message: e.message }; }
    case "/api/bots/room/save":
      try { return { ok: true, id: bots.saveRoom(body) }; } catch (e) { return { ok: false, message: e.message }; }
    case "/api/bots/room/remove":
      try { bots.removeRoom(body.id); return { ok: true }; } catch (e) { return { ok: false, message: e.message }; }
    case "/api/bots/room":
      return { messages: bots.messages(body.id), room: bots.rooms().find((r) => r.id === Number(body.id)) || null };
    case "/api/bots/send":
      return bots.send(body.id, body.text);
    case "/api/bots/stop":
      return bots.stop(body.id);
    case "/api/bots/clear":
      try { bots.clear(body.id); return { ok: true }; } catch (e) { return { ok: false, message: e.message }; }
    case "/api/bots/act":
      return body.allow ? bots.act(body.msg) : bots.deny(body.msg);
    case "/api/export-docx": {                        // 봇의 답 → 워드(또는 마크다운) 파일
      const asMd = body.format === "md";
      let bytes;
      try { bytes = asMd ? Buffer.from(String(body.markdown || "").trim() + "\n") : require("./docxwrite").build(String(body.markdown || ""), { title: body.title || "" }); }
      catch (e) { return { ok: false, message: "워드 파일을 만들지 못했습니다: " + String(e.message || e).slice(0, 80) }; }
      fs.mkdirSync(saveDir(), { recursive: true });
      const file = uniquePath(path.join(saveDir(), safeName(body.title) + (asMd ? ".md" : ".docx")));
      fs.writeFileSync(file, bytes);
      return { ok: true, path: file, folder: saveDir() };
    }
    case "/api/show-file":                            // 저장한 파일을 폴더에서 보여 주기 (이 앱이 저장한 곳 안만)
      if (!path.resolve(String(body.path || "")).startsWith(path.resolve(saveDir()) + path.sep)) return { ok: false };
      shell.showItemInFolder(path.resolve(body.path));
      return { ok: true };

    // ---------- 내 문서 검색 (src/docsearch.js) ----------
    case "/api/docs/status":
      return docs.status();
    case "/api/docs/open":                            // 근거 링크 → MyDocSearch 뷰어에서 그 위치
      try { return { ok: true, message: await docs.call("show_document", { id: Number(body.id), chunk: body.chunk ? Number(body.chunk) : null }) }; }
      catch (e) { return { ok: false, message: e.message }; }

    // ---------- AI 연결 (src/ai.js) ----------
    case "/api/ai/status":
      return { ...(await ai.status()), off: aiOff() };
    case "/api/ai/disconnect":
      if (!PROVIDERS.includes(body.target)) return { ok: false };
      setAiOff(body.target, true);
      return { ok: true };
    case "/api/ai/reconnect":
      if (!PROVIDERS.includes(body.target)) return { ok: false };
      setAiOff(body.target, false);
      return { ok: true };
    case "/api/ai/reset": {
      if (!PROVIDERS.includes(body.target)) return { ok: false };
      const r = ai.reset(body.target);
      const cfg = store.loadConfig();
      if (cfg.ai_off) delete cfg.ai_off[body.target];
      store.saveConfig(cfg);
      return r;
    }
    case "/api/ai/signin": {
      if (!PROVIDERS.includes(body.target)) return { ok: false, message: "알 수 없는 대상" };
      setAiOff(body.target, false);                   // 다시 로그인하면 연결도 다시 켠다
      return ai.signIn(body.target, (ev) => {
        // 브라우저에서 로그인을 마치면 앱 창을 앞으로 (Gemini는 브라우저에 영어 안내만 남는다)
        if (ev.done && body.target === "gemini" && win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
        send("ai-signin", { target: body.target, ...ev });
      });
    }
    case "/api/ai/signin-code":
      return ai.signInCode(body.target, body.code);
    case "/api/ai/signin-cancel":
      return ai.signInCancel(body.target);
    case "/api/ai/signout":
      return ai.signOut(body.target);
    case "/api/ai/models":
      if (!PROVIDERS.includes(body.provider)) return { models: [] };
      try { return await ai.models(body.provider); } catch (e) { return { models: [{ id: "", name: "기본", desc: "" }], error: String(e.message || e) }; }

    // ---------- 버전 · 업데이트 · 문제 기록 ----------
    case "/api/update": {
      // 업데이트를 마치고 처음 켠 경우 한 번 알려 준다
      const i = process.argv.indexOf("--update-done"), done = i >= 0 ? process.argv[i + 1] : "";
      if (i >= 0) process.argv.splice(i, 2);
      return { ...(await version.checkUpdate(!!body.force, updater.canUpdate())), justUpdated: done };
    }
    case "/api/update/prepare":
      return updater.prepare(String(body.version || ""), (ev) => send("update-event", ev));
    case "/api/update/apply": {
      const r = await updater.apply();
      if (r.ok) setTimeout(() => app.quit(), 300);          // 새 버전이 이 앱이 닫히기를 기다렸다 파일을 바꾼다
      return r;
    }
    case "/api/open-releases":
      shell.openExternal(body.url && String(body.url).startsWith(version.RELEASES) ? body.url : version.RELEASES);
      return { ok: true };
    case "/api/about":
      return about();
    case "/api/diag":                                 // 문제를 알릴 때 붙여 넣을 진단 정보 (대화 내용 없이)
      return { text: diagText() };
    case "/api/open-logs":
      shell.showItemInFolder(applog.file());
      return { ok: true };
    case "/api/log-error":                            // 화면에서 난 오류
      applog.error("ui", String(body.message || "").slice(0, 2000));
      return { ok: true };
  }
  throw new Error("알 수 없는 요청: " + url);
}

function about() {
  return { name: version.APP_NAME, version: version.VERSION, schema: store.SCHEMA_VERSION, electron: process.versions.electron,
    os: `${process.platform} ${os.release()} ${process.arch}`, data_dir: app.getPath("userData"), save_dir: saveDir(),
    log_file: applog.file(), errors: applog.errorCount(), releases: version.RELEASES, docs: docs.status() };
}
function diagText() {
  const a = about();
  const n = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  return [
    `${a.name} ${a.version} (데이터 ${a.schema} · Electron ${a.electron}) · ${a.os}`,
    `봇 ${n("bots")}개 · 팀 ${n("bot_rooms")}개 · 대화 ${n("bot_msgs")}개 · 연결 끊은 AI: ${Object.entries(aiOff()).filter(([, v]) => v).map(([k]) => k).join(", ") || "없음"}`,
    `내 문서 검색: ${a.docs.installed ? "설치됨" : "없음"}${a.docs.running ? " · 켜져 있음" : ""}`,
    "", `최근 문제 기록 (${a.errors}건):`, applog.tail(60) || "(없음)",
  ].join("\n");
}

function createWindow() {
  const cfg = store.loadConfig();
  win = new BrowserWindow({
    width: 1180, height: 800, minWidth: 720, minHeight: 500, title: version.APP_NAME,
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    backgroundColor: "#f5f7f9",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.removeMenu();
  // 메뉴를 없애 기본 확대 단축키도 빠졌으니 직접 받는다: Ctrl(맥 Cmd) + / - / 0, 크기는 설정에 남긴다
  const setZoom = (level) => {
    level = Math.max(-3, Math.min(4, level));
    win.webContents.setZoomLevel(level);
    const c = store.loadConfig();
    if (c.zoom_level !== level) store.saveConfig({ ...c, zoom_level: level });
  };
  win.webContents.on("did-finish-load", () => win.webContents.setZoomLevel(Number(cfg.zoom_level) || 0));
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown" || !(process.platform === "darwin" ? input.meta : input.control) || input.alt) return;
    const k = input.key, c = input.code, cur = win.webContents.getZoomLevel();
    if (k === "=" || k === "+" || c === "Equal" || c === "NumpadAdd") setZoom(cur + 0.5);
    else if (k === "-" || k === "_" || c === "Minus" || c === "NumpadSubtract") setZoom(cur - 0.5);
    else if (k === "0" || c === "Digit0" || c === "Numpad0") setZoom(0);
    else if ((k === "r" || c === "KeyR") && !app.isPackaged) win.reload();
    else return;
    e.preventDefault();
  });
  // 웹 링크는 기본 브라우저로 연다
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.on("render-process-gone", (_e, d) => {
    applog.error("ui", "화면이 멈춤:", d.reason);
    if (d.reason !== "clean-exit" && win && !win.isDestroyed()) win.reload();
  });
  win.loadFile(path.join(__dirname, "..", "ui", "index.html"));
}

app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(() => {
  if (UPDATING) return;
  applog.init(app.getPath("userData"));
  updater.init(app);
  updater.cleanup();
  if (app.setAboutPanelOptions) app.setAboutPanelOptions({ applicationName: version.APP_NAME, applicationVersion: version.VERSION });
  store.init(app.getPath("userData"));
  db = store.connect();
  ai.setToolsDir(path.join(app.getPath("userData"), "tools"));
  // Gemini(agy)에 브라우저와 같은 프록시를 넘기도록 (회사 프록시·PAC)
  ai.setProxyResolver((url) => require("electron").session.defaultSession.resolveProxy(url));
  ai.setLaunch(docs.launch());
  bots.init({ db, ai, docs, schedule, workDir: aiWorkDir, isOff: (p) => !!aiOff()[p],
    emit: (ev) => send("bot-event", ev),
    notify: (title, body) => { try { const { Notification } = require("electron"); if (Notification.isSupported()) new Notification({ title, body: body || "" }).show(); } catch { /* 알림 없음 */ } } });
  ipcMain.handle("api", async (_e, url, body) => {
    try { return await handle(url, body || {}); } catch (e) { applog.error("api " + String(url).split("?")[0], e); throw e; }
  });
  createWindow();
  bots.startLoop();
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => { try { ai.cancelRuns(); } catch { /* 없음 */ } });
