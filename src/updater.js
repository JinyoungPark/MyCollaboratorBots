// 자동 업데이트 (윈도우 zip판): 설치형이 아니라 실행 중인 앱이 자기 파일을 덮어쓸 수 없으므로 두 단계로 나눈다.
//   1) 지금 앱(prepare): 앱 폴더에 쓸 수 있는지 확인 → 새 zip을 앱 데이터 폴더/update에 받기 → 풀기 → 버전 확인
//   2) 새 버전(finish): 받아 둔 새 MyCollaboratorBots.exe를 '--finish-update'로 띄우고 지금 앱은 닫는다.
//      새 버전이 지금 앱이 끝나기를 기다렸다가, 앱 폴더의 이전 파일을 _previous로 옮기고 새 파일을 넣은 뒤 다시 연다.
//      중간에 막히면(백신·권한) 이전 파일로 되돌리고, 직접 받아 실행하라고 안내한다.
// 봇·팀·대화 기록·설정은 앱 데이터 폴더에 있어 그대로 남는다. 받은 파일은 브라우저를 거치지 않아 'Windows의 PC 보호' 표시도 붙지 않는다.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { RELEASES, APP_NAME, ASSET_PREFIX } = require("./version");
const BACKUP = "_previous";
const asset = (v) => `${ASSET_PREFIX}-${v}-windows-portable.zip`;
const MANUAL = "‘받기’를 눌러 새 zip을 직접 받은 뒤, 압축을 풀고 MyCollaboratorBots.exe를 실행하세요. 봇·팀·설정은 그대로 이어서 씁니다.";

let app = null, dataDir = null;
function init(a) { app = a; dataDir = a.getPath("userData"); }
const updDir = () => path.join(dataDir, "update");
const appDir = () => process.env.MCB_UPDATE_APPDIR || path.dirname(process.execPath);       // 시험용으로 바꿀 수 있음
const exeName = () => process.env.MCB_UPDATE_EXE || path.basename(process.execPath);
// 윈도우에서 압축을 풀어 쓰는 앱만 (개발 중 실행·맥은 지금처럼 '받기' 안내)
const canUpdate = () => !!process.env.MCB_UPDATE_APPDIR || (process.platform === "win32" && !!app && app.isPackaged);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 백신이 막 받은·막 닫힌 실행 파일을 잠시 잡고 있을 수 있어 몇 번 다시 해 본다
async function retry(fn, tries = 10) {
  for (let i = 1; ; i++) {
    try { return fn(); } catch (e) {
      if (i >= tries || !/EPERM|EBUSY|EACCES|ENOTEMPTY/.test(e.code || "")) throw e;
      await sleep(500);
    }
  }
}

// ---------- 1단계: 받기·풀기 (지금 앱) ----------

async function download(url, dest, onPct) {
  const { net } = require("electron");
  const res = await net.fetch(url);
  if (!res.ok) throw new Error(`내려받기 실패 (HTTP ${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  const out = fs.createWriteStream(dest);
  let got = 0, last = -1;
  try {
    for await (const chunk of res.body) {
      got += chunk.length;
      const pct = total ? Math.floor((got / total) * 100) : 0;
      if (pct !== last) { onPct(pct); last = pct; }
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
    }
  } finally {
    await new Promise((r) => { out.once("close", r); out.end(); });
  }
  if (total && got !== total) throw new Error("받다가 끊겼습니다");
}

// zip을 조각조각 읽으며 푼다 (약 500MB를 한꺼번에 메모리에 올리지 않게). 폴더 밖으로 나가는 이름은 거절
async function unzip(zip, dir) {
  const { Unzip, UnzipInflate } = require("fflate");
  fs.mkdirSync(dir, { recursive: true });
  let err = null, files = 0;
  const uz = new Unzip((file) => {
    const dest = path.resolve(dir, file.name);
    if (dest !== dir && !dest.startsWith(dir + path.sep)) { err = err || new Error("zip 안의 경로가 이상합니다: " + file.name); return; }
    if (file.name.endsWith("/")) { fs.mkdirSync(dest, { recursive: true }); return; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const fd = fs.openSync(dest, "w");
    files++;
    file.ondata = (e, chunk, final) => {
      if (e) err = err || e;
      else if (chunk && chunk.length) fs.writeSync(fd, chunk);
      if (e || final) fs.closeSync(fd);
    };
    file.start();
  });
  uz.register(UnzipInflate);
  for await (const chunk of fs.createReadStream(zip, { highWaterMark: 1 << 20 })) {
    uz.push(chunk);
    if (err) throw err;
  }
  uz.push(new Uint8Array(0), true);
  if (err) throw err;
  return files;
}

// 앱 폴더에 파일을 만들고 지울 수 있는지 (Program Files·읽기 전용 폴더면 자동 업데이트 불가)
function writable(dir) {
  const t = path.join(dir, `.mcb-update-test-${process.pid}`);
  try { fs.writeFileSync(t, "x"); fs.rmSync(t); return true; } catch { return false; }
}

let job = null;
async function prepare(version, emit) {
  if (!canUpdate()) return { ok: false, manual: true, message: "이 실행 방식에서는 자동 업데이트를 할 수 없습니다. " + MANUAL };
  if (!/^\d+(\.\d+)+$/.test(String(version))) return { ok: false, message: "버전 번호가 이상합니다." };
  if (job) return { ok: false, message: "이미 업데이트를 준비하고 있습니다." };
  const dir = appDir();
  if (!writable(dir)) return { ok: false, manual: true, message: `앱 폴더(${dir})에 파일을 쓸 수 없어 자동 업데이트를 할 수 없습니다. ` + MANUAL };
  job = { version };
  const zip = path.join(updDir(), asset(version)), stage = path.join(updDir(), version);
  try {
    fs.rmSync(updDir(), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    fs.mkdirSync(updDir(), { recursive: true });
    const base = process.env.MCB_UPDATE_DL || `${RELEASES}/download`;
    try {
      await download(`${base}/v${version}/${asset(version)}`, zip, (pct) => emit({ phase: "download", pct, text: `새 버전 ${version} 받는 중… ${pct}%` }));
    } catch (e) {
      throw new Error(`새 버전을 받지 못했습니다 (${e.message || e}${e.cause && e.cause.code ? ": " + e.cause.code : ""})`);
    }
    emit({ phase: "unzip", text: "받은 파일 푸는 중…" });
    try { await unzip(zip, stage); } catch (e) { throw new Error(`받은 파일을 풀지 못했습니다 (${e.message || e})`); }
    fs.rmSync(zip, { force: true });
    // 받은 것이 정말 그 버전의 앱인지 (회사망 차단 페이지·깨진 파일이면 여기서 걸린다)
    let v = "";
    try { v = JSON.parse(fs.readFileSync(path.join(stage, "resources", "app", "package.json"), "utf8")).version; } catch { /* 없음 */ }
    if (v !== version || !fs.existsSync(path.join(stage, exeName()))) throw new Error(`받은 파일이 ${APP_NAME} 새 버전이 아닙니다`);
    job.stage = stage;
    emit({ phase: "ready", text: `새 버전 ${version} 준비 완료` });
    return { ok: true, version };
  } catch (e) {
    job = null;
    try { fs.rmSync(updDir(), { recursive: true, force: true }); } catch { /* 다음에 지움 */ }
    return { ok: false, manual: true, message: `${e.message || e}. ` + MANUAL };
  }
}

// 받아 둔 새 버전을 '--finish-update'로 띄우고 지금 앱은 닫는다
function apply() {
  if (!job || !job.stage) return { ok: false, message: "준비된 업데이트가 없습니다." };
  const exe = path.join(job.stage, exeName());
  const child = spawn(exe, ["--finish-update", appDir(), String(process.pid), job.version], { detached: true, stdio: "ignore", cwd: job.stage });
  // 실제로 떴을 때만 이 앱을 닫는다 (백신이 막으면 지금 앱을 그대로 둔다)
  return new Promise((resolve) => {
    child.once("spawn", () => { child.unref(); resolve({ ok: true }); });
    child.once("error", (e) => resolve({ ok: false, message: `받아 둔 새 버전을 실행하지 못했습니다 (${e.code || e.message}). ` + MANUAL }));
  });
}

// 업데이트를 마친 뒤 처음 켤 때: 이전 파일·받은 파일을 치운다 (바로 전 단계 프로그램이 아직 닫히는 중일 수 있어 잠시 뒤)
function cleanup() {
  if (!canUpdate()) return;
  setTimeout(async () => {
    for (const d of [path.join(appDir(), BACKUP), updDir()]) {
      if (!fs.existsSync(d) || (d === updDir() && job)) continue;      // 그 사이 시작한 업데이트 준비는 건드리지 않음
      try { await retry(() => fs.rmSync(d, { recursive: true, force: true })); } catch { /* 다음에 켤 때 다시 */ }
    }
  }, 5000);
}

// ---------- 2단계: 바꿔 끼우기 (받아 둔 새 버전이 실행) ----------

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }

// 옮기기: 같은 드라이브면 이름 바꾸기, 다른 드라이브면 복사 후 지우기
async function move(src, dst) {
  try { await retry(() => fs.renameSync(src, dst)); } catch (e) {
    if (e.code !== "EXDEV") throw e;
    await retry(() => fs.cpSync(src, dst, { recursive: true, force: true }));
    await retry(() => fs.rmSync(src, { recursive: true, force: true }));
  }
}

// opts: { appDir, pid, version, stage, exe } · deps: { message(kind, text) → Promise<boolean 받기?>, open(url), launch(exe, args), progress(text) }
async function finish(opts, deps) {
  const { appDir: dir, stage, exe } = opts;
  const names = fs.readdirSync(stage);                 // 앱이 가진 이름만 건드린다 (앱 폴더에 다른 파일이 같이 있어도 그대로)
  const backup = path.join(dir, BACKUP);
  const moved = [];
  let phase = "wait";
  try {
    deps.progress("이전 버전이 닫히기를 기다리는 중…");
    for (let i = 0; alive(opts.pid); i++) {
      if (i > 120) throw new Error("이전 버전이 닫히지 않았습니다");
      await sleep(500);
    }
    deps.progress("파일 바꾸는 중…");
    phase = "backup";
    if (fs.existsSync(backup)) await retry(() => fs.rmSync(backup, { recursive: true, force: true }));
    fs.mkdirSync(backup, { recursive: true });
    for (const n of names) {
      if (!fs.existsSync(path.join(dir, n))) continue;
      await move(path.join(dir, n), path.join(backup, n));
      moved.push(n);
    }
    phase = "copy";
    for (const n of names) await retry(() => fs.cpSync(path.join(stage, n), path.join(dir, n), { recursive: true, force: true }));
  } catch (e) {
    // 되돌리기: 넣은 새 파일을 지우고 옮긴 이전 파일을 제자리로
    let restored = true;
    // 넣기 단계였다면 앱 폴더의 같은 이름은 모두 새(또는 반쯤 넣은) 파일이다 — 이전 파일은 모두 _previous에 있음
    if (phase === "copy") for (const n of names) {
      try { await retry(() => fs.rmSync(path.join(dir, n), { recursive: true, force: true }), 5); } catch { restored = false; }
    }
    for (const n of moved) {
      try { await move(path.join(backup, n), path.join(dir, n)); } catch { restored = false; }
    }
    if (restored) try { fs.rmSync(backup, { recursive: true, force: true }); } catch { /* 남아도 됨 */ }
    const why = e.code ? `${e.code}${e.path ? " · " + path.basename(e.path) : ""}` : (e.message || String(e));
    const text = restored
      ? `새 버전 ${opts.version}으로 바꾸지 못했습니다 (${why}).\n백신·보안 프로그램이 막았거나 앱 폴더에 쓸 권한이 없을 수 있습니다.\n\n이전 버전 그대로 다시 엽니다. ${MANUAL}`
      : `새 버전 ${opts.version}으로 바꾸다 멈췄고, 이전 파일을 모두 되돌리지 못했습니다 (${why}).\n이전 파일은 ${backup} 에 있습니다.\n\n${MANUAL}`;
    const get = await deps.message("error", text);
    if (get) deps.open(`${RELEASES}/tag/v${opts.version}`);
    if (restored) deps.launch(path.join(dir, exe), []);
    return { ok: false, restored, message: text };
  }
  deps.launch(path.join(dir, exe), ["--update-done", opts.version]);
  return { ok: true };
}

// '--finish-update <앱 폴더> <이전 앱 pid> <버전>'으로 실행됐을 때 (main.js 맨 앞에서 부름): 작은 안내 창만 띄우고 바꿔 끼운 뒤 끝낸다
function finishFromArgs(electron) {
  const { app: a, BrowserWindow, dialog, shell } = electron;
  const i = process.argv.indexOf("--finish-update");
  const [dir, pid, version] = process.argv.slice(i + 1, i + 4);
  a.whenReady().then(async () => {
    const w = new BrowserWindow({ width: 380, height: 120, frame: false, resizable: false, center: true, show: true, webPreferences: { sandbox: true } });
    const show = (t) => w.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(
      `<body style="font-family:'Malgun Gothic',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-size:14px;color:#17222c;background:#f5f7f9">${APP_NAME} ${version} 업데이트 — ${t}</body>`)).catch(() => {});
    await finish({ appDir: dir, pid: Number(pid), version, stage: path.dirname(process.execPath), exe: path.basename(process.execPath) }, {
      progress: show,
      message: async (_k, text) => {
        w.hide();
        const r = await dialog.showMessageBox({ type: "warning", title: APP_NAME, message: "업데이트하지 못했습니다", detail: text, buttons: ["받기 페이지 열기", "닫기"], defaultId: 0 });
        return r.response === 0;
      },
      open: (url) => shell.openExternal(url),
      launch: (exe, args) => spawn(exe, args, { detached: true, stdio: "ignore", cwd: dir }).unref(),
    });
    setTimeout(() => a.exit(0), 500);
  });
}

module.exports = { init, canUpdate, prepare, apply, cleanup, finish, finishFromArgs, unzip, BACKUP };
