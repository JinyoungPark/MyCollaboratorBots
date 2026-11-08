// 내 구독 계정으로 AI 봇 돌리기. 사용자가 로그인해 둔 공식 프로그램(Claude Code, Codex, Gemini는 Google의 Antigravity CLI)을 이 PC에서 실행한다.
// 내 문서 검색(MyDocSearch)이 설치돼 있으면 그 문서 검색 MCP 서버를 붙여 준다 (src/docsearch.js가 띄우는 방법을 알려 줌).
// 이 앱은 로그인 정보를 읽거나 저장하지 않는다. (MyDocSearch의 src/ai.js에서 봇에 필요한 부분만 떼어 옴)

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");
const agy = require("./agy");

const SERVER_NAME = "mydocsearch";
const TOOL_NAMES = ["search_documents", "read_document", "list_folders"];
const home = os.homedir();
const isWin = process.platform === "win32";

const SYSTEM_PROMPT = "너는 사용자를 돕는 AI 봇이다. 한국어로 답한다. 파일을 만들거나 고치거나 명령을 실행하지 않는다.";

// ---------- 프로그램 찾기 ----------

function exists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

function fromPath(names) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    for (const n of names) if (dir && exists(path.join(dir, n))) return path.join(dir, n);
  }
  return null;
}

function newestUnder(base, rel) {
  // base/<버전>/<해시>/rel 중 가장 새 버전 (Claude 앱에 들어 있는 Claude Code)
  try {
    const vers = fs.readdirSync(base).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of vers) for (const h of fs.readdirSync(path.join(base, v))) {
      const p = path.join(base, v, h, rel);
      if (exists(p)) return p;
    }
  } catch { /* 없음 */ }
  return null;
}

function findClaude() {
  const names = isWin ? ["claude.exe", "claude.cmd"] : ["claude"];
  const cands = isWin
    ? [path.join(home, ".local", "bin", "claude.exe"), path.join(process.env.APPDATA || "", "npm", "claude.cmd"),
      path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links", "claude.exe")]
    : [path.join(home, ".local", "bin", "claude"), path.join(home, ".claude", "local", "claude"), "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude"];
  return fromPath(names) || cands.find(exists) ||
    (process.platform === "darwin"
      ? newestUnder(path.join(home, "Library", "Application Support", "Claude", "claude-code"), "claude.app/Contents/MacOS/claude")
      : null);
}

function findCodex() {
  const names = isWin ? ["codex.exe", "codex.cmd"] : ["codex"];
  const cands = isWin
    ? [path.join(process.env.APPDATA || "", "npm", "codex.cmd"), path.join(process.env.LOCALAPPDATA || "", "Programs", "codex", "codex.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links", "codex.exe")]
    : ["/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex", "/Applications/Codex.app/Contents/Resources/codex",
      "/opt/homebrew/bin/codex", "/usr/local/bin/codex", path.join(home, ".local", "bin", "codex")];
  return (appCodex() && exists(appCodex()) ? appCodex() : null) || fromPath(names) || cands.find(exists) || null;
}

// Gemini: Google의 Antigravity CLI(agy) — 앱이 받아 둔 것(tools/agy) 또는 공식 설치 스크립트로 깐 것 (src/agy.js)
const findGemini = () => agy.find(toolsDir);

// 회사 프록시: 브라우저(Electron)가 쓰는 프록시를 그대로 Gemini(agy)에 넘긴다 (HTTPS_PROXY). 직접 연결이면 넘기지 않는다
let resolveProxy = null;               // main.js가 넣어 줌: (url) => Promise<"DIRECT" | "PROXY host:port; …">
function setProxyResolver(fn) { resolveProxy = fn; }
let proxyCache = null;
async function refreshProxy() {
  if (process.env.HTTPS_PROXY || process.env.https_proxy) return (proxyCache = {});      // 사용자가 직접 정해 둔 프록시가 우선
  if (!resolveProxy) return (proxyCache = {});
  try {
    const p = String(await resolveProxy("https://oauth2.googleapis.com/")).split(";")[0].trim();
    const m = /^(PROXY|HTTPS)\s+(\S+)$/i.exec(p);
    proxyCache = m ? { HTTPS_PROXY: `${m[1].toUpperCase() === "HTTPS" ? "https" : "http"}://${m[2]}`, HTTP_PROXY: `http://${m[2]}` } : {};
  } catch { proxyCache = {}; }
  return proxyCache;
}
const netEnv = () => ({ ...(proxyCache || {}) });

// .cmd 파일은 셸을 거쳐야 실행된다 (윈도우 npm 설치본)
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30000, windowsHide: true, shell: isWin && cmd.endsWith(".cmd"), ...opts },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout || ""), err: String(stderr || "") }));
  });
}

// ---------- 상태 ----------

let launch = null;                      // MCP 서버를 띄우는 방법 { command, args, env }
function setLaunch(l) { launch = l; }

async function status() {
  const claude = findClaude();
  const codex = findCodex();
  const out = { claude: { path: claude, installed: !!claude, loggedIn: false },
    codex: { path: codex, installed: !!codex, loggedIn: false },
    gemini: { path: findGemini(), installed: !!findGemini(), loggedIn: false } };
  if (claude) {
    const r = await run(claude, ["auth", "status"]);
    try { out.claude.loggedIn = !!JSON.parse(r.out).loggedIn; } catch { out.claude.loggedIn = /logged in/i.test(r.out); }
  }
  if (codex) {
    const r = await run(codex, ["login", "status"]);
    out.codex.loggedIn = /logged in/i.test(r.out + r.err) && !/not logged in/i.test(r.out + r.err);
  }
  if (out.gemini.installed) { await refreshProxy(); const a = await agy.auth(out.gemini.path, netEnv()); out.gemini.loggedIn = a.loggedIn; out.gemini.how = a.how; }
  return out;
}

// ---------- 설치·로그인 (로그인 버튼) ----------
// 사용자는 "Claude로 로그인"/"ChatGPT로 로그인"만 누른다. 필요한 공식 프로그램이 없으면 앱이 뒤에서 내려받아 설치하고,
// 로그인 명령을 창 없이 실행해 브라우저에 각 회사의 공식 로그인 화면을 띄운다.
//   Claude  — 공식 설치 스크립트(claude.ai/install) → `claude auth login` (브라우저에 나온 코드를 앱에 붙여 넣음)
//   ChatGPT — Codex 공식 배포 파일(github.com/openai/codex 릴리스)을 앱 폴더에 풀기 → `codex login` (브라우저 로그인만으로 끝)
//   Gemini  — Google 공식 배포 목록에서 Antigravity CLI(agy)를 앱 폴더에 받기(SHA-512 확인) → agy를 창 없이 실행
//             (브라우저에 Google 로그인 화면, 나온 코드를 앱에 붙여 넣음 — src/agy.js)
// 이 앱은 비밀번호·토큰을 읽거나 저장하지 않는다. 로그인 정보는 각 공식 프로그램이 자기 위치에 저장한다.

let toolsDir = null;                    // 앱이 내려받은 프로그램을 두는 곳 (앱 데이터 폴더/tools)
function setToolsDir(d) { toolsDir = d; }
const appCodex = () => toolsDir && path.join(toolsDir, "codex", isWin ? "codex.exe" : "codex");

function codexAsset() {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  return isWin ? `codex-${arch}-pc-windows-msvc.exe.tar.gz` : `codex-${arch}-apple-darwin.tar.gz`;
}

// 진행 중인 설치·로그인 (대상마다 하나)
const jobs = {};

function runHidden(cmd, args, onOut, opts = {}) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], ...opts });
    let out = "";
    const on = (d) => { const t = d.toString("utf8"); out += t; onOut && onOut(t, c); };
    c.stdout.on("data", on); c.stderr.on("data", on);
    c.on("error", (e) => resolve({ code: -1, out: out + String(e.message || e), child: c }));
    c.on("close", (code) => resolve({ code, out, child: c }));
    opts.onChild && opts.onChild(c);
  });
}

// 인터넷 받기는 Electron(크롬) 네트워크로 — 윈도우 프록시 설정과 회사 보안 장비 인증서(윈도우 인증서 저장소)를 그대로 쓴다.
// Node 내장 fetch는 둘 다 모르므로 회사망에서 "fetch failed"가 난다. 시험(ELECTRON_RUN_AS_NODE)에서는 Node fetch
function netFetch(url) {
  try { const { app, net } = require("electron"); if (net && net.fetch && app.isReady()) return net.fetch(url); } catch { /* Electron 밖 */ }
  return fetch(url);
}

async function download(url, dest, onPct) {
  const res = await netFetch(url);
  if (!res.ok) throw new Error(`내려받기 실패 (${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  const out = fs.createWriteStream(dest);
  let got = 0, last = -1;
  for await (const chunk of res.body) {
    got += chunk.length;
    const pct = total ? Math.floor((got / total) * 100) : 0;
    if (pct !== last) { onPct(pct); last = pct; }
    if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
  }
  // 'close'까지 기다린다 — 윈도우에서는 파일이 아직 열려 있으면 이름 바꾸기·옮기기가 EPERM으로 거절된다
  await new Promise((r, j) => { out.once("close", r); out.once("error", j); out.end(); });
}

async function installClaude(emit) {
  emit({ phase: "install", text: "Claude 프로그램 설치 중… (1~3분)" });
  const r = isWin
    ? await runHidden("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "irm https://claude.ai/install.ps1 | iex"])
    : await runHidden("/bin/bash", ["-c", "curl -fsSL https://claude.ai/install.sh | bash"]);
  if (!findClaude()) throw new Error("Claude 프로그램 설치에 실패했습니다.\n" + r.out.trim().split("\n").slice(-4).join("\n"));
}

// tar.gz에서 첫 번째 codex 실행 파일만 꺼낸다. 운영체제의 tar 명령을 쓰지 않고 앱이 직접 푼다 (윈도우 tar.exe 차이·경로 문제 회피)
async function extractCodex(tgz, dest) {
  const zlib = require("zlib");
  const tmp = dest + ".part";
  let buf = Buffer.alloc(0), left = 0, skip = 0, out = null, found = false, ended = false;
  const input = fs.createReadStream(tgz).pipe(zlib.createGunzip());
  for await (const chunk of input) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length && !ended) {
      if (left > 0) {                                     // 파일 내용
        const n = Math.min(left, buf.length);
        if (out) await new Promise((r, j) => out.write(buf.subarray(0, n), (e) => (e ? j(e) : r())));
        left -= n; buf = buf.subarray(n);
        if (left === 0 && out) { await new Promise((r) => out.end(r)); out = null; found = true; ended = true; }
        continue;
      }
      if (skip > 0) { const n = Math.min(skip, buf.length); skip -= n; buf = buf.subarray(n); continue; }   // 512바이트 맞춤
      if (buf.length < 512) break;
      const h = buf.subarray(0, 512); buf = buf.subarray(512);
      if (h.every((x) => x === 0)) { ended = true; break; }
      const name = h.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
      const size = parseInt(h.subarray(124, 136).toString("ascii").replace(/\0.*$/s, "").trim() || "0", 8);
      const type = String.fromCharCode(h[156] || 48);
      left = size; skip = (512 - (size % 512)) % 512;
      if ((type === "0" || type === "\0") && path.basename(name).startsWith("codex") && size > 1e6) out = fs.createWriteStream(tmp);
      if (size === 0) left = 0;
    }
    if (ended) break;
  }
  input.destroy();
  if (!found) { fs.rmSync(tmp, { force: true }); throw new Error("받은 파일 안에서 Codex 프로그램을 찾지 못했습니다."); }
  fs.rmSync(dest, { force: true });
  fs.renameSync(tmp, dest);
}

const installGemini = (emit) => agy.install(toolsDir, emit, download, netFetch);
async function loginGemini(emit) {
  emit({ phase: "login", text: "Google 로그인 준비 중…" });
  await refreshProxy();
  await agy.login(findGemini(), emit, jobs.gemini, netEnv(), path.join(toolsDir || os.tmpdir(), "gemini-login"));
}

async function installCodex(emit) {
  if (!toolsDir) throw new Error("설치 위치가 정해지지 않았습니다.");
  const dir = path.join(toolsDir, "codex");
  fs.mkdirSync(dir, { recursive: true });
  const tgz = path.join(dir, "codex.tar.gz");
  const url = `https://github.com/openai/codex/releases/latest/download/${codexAsset()}`;
  try {
    await download(url, tgz, (pct) => emit({ phase: "install", text: `ChatGPT 프로그램 내려받는 중… ${pct}%` }));
  } catch (e) {
    throw new Error(`ChatGPT 프로그램을 내려받지 못했습니다 (${e.message || e}). 회사망에서 github.com 접속이 막혀 있는지 확인하세요.`);
  }
  // 회사망 차단 페이지(HTML)를 받은 경우: gzip 파일 표시(1f 8b)가 없다
  const head = Buffer.alloc(2);
  const fd = fs.openSync(tgz, "r"); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd);
  if (head[0] !== 0x1f || head[1] !== 0x8b) {
    fs.rmSync(tgz, { force: true });
    throw new Error("받은 파일이 프로그램 파일이 아닙니다. 회사망(보안 프록시)이 github.com 다운로드를 막고 있을 수 있습니다.");
  }
  emit({ phase: "install", text: "ChatGPT 프로그램 설치 중…" });
  try {
    await extractCodex(tgz, appCodex());
  } finally {
    fs.rmSync(tgz, { force: true });
  }
  if (!isWin) fs.chmodSync(appCodex(), 0o755);
  if (!exists(appCodex())) throw new Error("설치한 프로그램이 사라졌습니다. 백신 프로그램이 막았을 수 있습니다 (codex.exe 허용 필요).");
}

// 로그인: 공식 프로그램이 브라우저를 연다. 주소도 화면에 보여 준다(브라우저가 안 열릴 때). Claude는 코드 붙여 넣기를 기다린다
async function loginRun(target, emit) {
  if (target === "gemini") return loginGemini(emit);
  const cmd = target === "claude" ? findClaude() : findCodex();
  const args = target === "claude" ? ["auth", "login"] : ["login"];
  if (target === "codex") fs.mkdirSync(process.env.CODEX_HOME || path.join(home, ".codex"), { recursive: true });   // 새 PC: 설정 폴더가 없으면 codex가 멈춘다
  emit({ phase: "login", text: "브라우저에서 로그인하세요…" });
  const r = await runHidden(cmd, args, (t) => {
    const url = (t.match(/https:\/\/[^\s]+/g) || []).find((u) => /oauth|authorize/.test(u));
    if (url) emit({ phase: "login", text: "브라우저에서 로그인하세요…", url });
    if (/paste code/i.test(t)) emit({ phase: "login", text: "로그인 후 브라우저에 나온 코드를 붙여 넣으세요", needCode: true });
  }, { shell: isWin && cmd.endsWith(".cmd"), env: { ...process.env, NO_COLOR: "1" }, onChild: (c) => { jobs[target].child = c; } });
  if (jobs[target]?.cancelled) throw new Error("취소했습니다.");
  const st = await status();
  if (!st[target].loggedIn) throw new Error("로그인이 끝나지 않았습니다." + (r.code ? "\n" + r.out.trim().split("\n").slice(-2).join("\n") : ""));
}

// 로그인 버튼: 설치(필요하면) → 로그인. emit({ phase, text, url?, needCode?, done?, error? })
const FIND = { claude: findClaude, codex: findCodex, gemini: findGemini };
const INSTALL = { claude: installClaude, codex: installCodex, gemini: installGemini };

function signIn(target, emit) {
  if (!FIND[target]) return { ok: false, message: "알 수 없는 대상" };
  if (jobs[target]) return { ok: false, message: "이미 진행 중입니다." };
  jobs[target] = {};
  if (target === "gemini") agy.forget();          // 로그인 상태를 새로 확인한다 (기억해 둔 1분짜리 상태 말고)
  (async () => {
    try {
      if (!FIND[target]()) await INSTALL[target](emit);
      if (jobs[target].cancelled) throw new Error("취소했습니다.");
      const st = await status();
      if (!st[target].loggedIn) await loginRun(target, emit);
      emit({ phase: "done", done: true });
    } catch (e) {
      emit({ phase: "error", error: String(e.message || e) });
    } finally {
      delete jobs[target];
    }
  })();
  return { ok: true };
}

const installTool = (target, emit) => INSTALL[target](emit);

// Claude 로그인 코드: 사용자가 브라우저에서 복사해 붙여 넣은 값을 로그인 중인 공식 프로그램에 그대로 넘긴다 (저장하지 않음)
function signInCode(target, code) {
  const c = jobs[target]?.child;
  if (!c || !c.stdin.writable) return { ok: false, message: "로그인이 진행 중이 아닙니다." };
  c.stdin.write(String(code || "").trim() + "\n");
  return { ok: true };
}

// 이 PC에서 완전히 로그아웃: 공식 프로그램의 로그아웃 명령 (claude auth logout / codex logout).
// 같은 로그인을 쓰는 이 PC의 다른 프로그램(Claude 데스크톱 앱·Claude Code, Codex·ChatGPT 앱)도 함께 로그아웃된다
async function signOut(target) {
  // agy에는 창 없이 쓰는 로그아웃 명령이 없다 → 앱에서는 연결만 끊는다
  if (target === "gemini") return { ok: false, message: "Gemini(Antigravity) 로그인은 앱에서 지울 수 없습니다. 이 앱에서 쓰지 않으려면 ‘연결 끊기’를 누르세요." };
  const exe = target === "claude" ? findClaude() : target === "codex" ? findCodex() : null;
  if (!exe) return { ok: false, message: "프로그램을 찾지 못했습니다." };
  const r = await run(exe, target === "claude" ? ["auth", "logout"] : ["logout"]);
  return r.code === 0 ? { ok: true } : { ok: false, message: (r.err || r.out || "로그아웃하지 못했습니다.").trim().slice(0, 200) };
}

function signInCancel(target) {
  const j = jobs[target];
  if (j) { j.cancelled = true; if (j.child) j.child.kill(); }
  return { ok: true };
}

// 설정 초기화: 진행 중인 로그인을 멈추고, 이 앱이 받아 둔 프로그램(tools/codex·tools/agy)을 지워 처음부터 다시 하게 한다.
// 이 PC의 다른 프로그램도 함께 쓰는 로그인(Claude Code·Codex·Google Antigravity)과 따로 설치된 프로그램은 건드리지 않는다
function reset(target) {
  signInCancel(target);
  const dirs = !toolsDir ? [] : target === "gemini" ? ["agy", "gemini-login"] : target === "codex" ? ["codex"] : [];
  if (target === "gemini") agy.forget();
  try {
    // 윈도우: 방금 멈춘 프로그램이나 백신이 파일을 잠시 잡고 있을 수 있어 몇 번 다시 시도한다
    for (const d of dirs) fs.rmSync(path.join(toolsDir, d), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (e) {
    return { ok: false, message: "받아 둔 프로그램을 지우지 못했습니다. 앱을 다시 시작한 뒤 다시 해 보세요. (" + (e.code || e.message) + ")" };
  }
  return { ok: true };
}


// ---------- 모델 ----------
// Claude: Claude Code가 받는 별칭(최신 모델로 연결됨). 쓸 수 있는 모델은 요금제에 따라 다르다
const CLAUDE_MODELS = [
  { id: "", name: "기본", desc: "Claude Code 기본 모델 (요금제에 따라 다름)" },
  { id: "fable", name: "Fable", desc: "가장 뛰어남 · 가장 느리고 사용량을 많이 씀" },
  { id: "opus", name: "Opus", desc: "복잡한 질문에 강함" },
  { id: "sonnet", name: "Sonnet", desc: "빠르고 균형 잡힘" },
  { id: "haiku", name: "Haiku", desc: "가장 빠르고 사용량을 적게 씀" },
];

// claude-opus-5-5 → Claude Opus 5.5
// Gemini: agy가 이 계정에 알려 주는 모델 (`agy models`). 예전 설정의 별칭(pro·flash)은 그 이름이 든 모델로 바꾼다
async function geminiModels() {
  const a = await agy.auth(findGemini(), netEnv());
  return a.models.map((m) => ({ id: m.id, name: m.name }));
}
function geminiModel(id) {
  if (!id || !/^(pro|flash|flash-lite)$/.test(id)) return id;
  const hit = agy.cachedModels().filter((m) => m.id.startsWith("gemini") && m.id.includes(id === "flash-lite" ? "flash" : id));
  return (hit.find((m) => /medium/.test(m.id)) || hit[0] || {}).id || "";
}

function prettyClaude(id) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id || "");
  return m ? `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? "." + m[3] : ""}` : id;
}

const codexConfigFile = () => path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "config.toml");
function codexConfiguredModel() {
  try {
    const top = fs.readFileSync(codexConfigFile(), "utf8").split(/^\[/m)[0];      // 맨 위(섹션 밖)의 model 설정
    return (/^model\s*=\s*"([^"]+)"/m.exec(top) || [])[1] || null;
  } catch { return null; }
}

let codexCatalog = null;
async function codexModels() {
  if (codexCatalog && codexCatalog.length) return codexCatalog;
  const c = findCodex();
  if (!c) return [];
  const pick = (json) => (json.models || []).filter((m) => m.visibility === "list")
    .map((m) => ({ id: m.slug, name: m.display_name || m.slug, desc: m.description || "" }));
  // Codex가 받아 둔 목록 파일이 있으면 바로 쓰고(빠름), 없으면 목록 명령을 실행한다. 빈 목록은 기억하지 않아 다음에 다시 시도한다
  try { codexCatalog = pick(JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "models_cache.json"), "utf8"))); }
  catch { codexCatalog = []; }
  if (codexCatalog.length) return codexCatalog;
  const r = await run(c, ["debug", "models"], { maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
  try { codexCatalog = pick(JSON.parse(r.out)); } catch { codexCatalog = []; }
  return codexCatalog;
}

// 화면에 보여 줄 모델 목록과, "기본"을 고르면 실제로 쓰이는 모델
async function models(provider) {
  if (provider === "claude") return { models: CLAUDE_MODELS, defaultName: null };
  if (provider === "gemini") return { models: [{ id: "", name: "기본", desc: "Antigravity 기본 모델" }, ...(await geminiModels())], defaultName: null };
  if (provider === "codex") {
    const list = await codexModels();
    const conf = codexConfiguredModel();
    const def = list.find((m) => m.id === conf) || (conf ? { id: conf, name: conf } : list[0]);
    return { models: [{ id: "", name: "기본", desc: def ? `Codex 기본 모델 (${def.name})` : "Codex 기본 모델" }, ...list], defaultName: def ? def.name : null };
  }
  return { models: [], defaultName: null };
}

async function modelLabel(provider, id) {
  if (provider === "claude") return prettyClaude(id);
  if (provider === "gemini") return ((await geminiModels()).find((m) => m.id === id) || {}).name || id;
  const list = await codexModels();
  return (list.find((m) => m.id === id) || {}).name || id;
}

// ---------- 묻기 ----------

function toml(v) {                      // Codex -c 값은 TOML로 읽는다 (JSON 문자열·배열은 TOML과 호환)
  if (typeof v === "string" || Array.isArray(v)) return JSON.stringify(v);
  return "{ " + Object.entries(v).map(([k, x]) => `${k} = ${JSON.stringify(x)}`).join(", ") + " }";
}

// 봇용: 화면 없이 한 번 실행하고 끝나면 { ok, text, error, seconds, tools } 를 돌려준다 (묻기와 따로 돈다)
// opts.system: 시스템 지시, opts.toolEnv: 문서 검색 도구에 줄 환경값(범위 등), opts.extra: 함께 쓸 사용자 MCP 서버 { 이름: 설정 },
// opts.web: 웹 검색만 쓰고 내 문서 도구는 넘기지 않음
function runTask(provider, prompt, { workDir, model = "", system, toolEnv, extra, web = false, onEvent, timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const tools = [];
    let child = null, timer = null, usedModel = "";
    const r = start(provider, prompt, (ev) => {
      if (onEvent) onEvent(ev);
      if (ev.type === "tool") tools.push({ name: ev.name, input: ev.input });
      if (ev.type === "usage" && ev.model) usedModel = ev.model;
      if (ev.type === "done") { clearTimeout(timer); runs.delete(child); resolve({ ok: !ev.error && !!ev.text, text: ev.text || "", error: ev.error || "", seconds: ev.seconds, tools, model: usedModel }); }
    }, workDir, model, { system, toolEnv, extra, web });
    if (!r.child) return resolve({ ok: false, text: "", error: r.message, tools });
    child = r.child;
    runs.add(child);
    timer = setTimeout(() => child.kill(), timeoutMs);
  });
}
const runs = new Set();
const cancelRuns = () => { for (const c of runs) c.kill(); };

// 웹 정보 모으기 루틴에서만 켜는 AI 자체 도구
const WEB_TOOLS = { claude: ["WebSearch", "WebFetch"] };

function start(provider, question, emit, workDir, model = "", { system = SYSTEM_PROMPT, toolEnv = null, extra = null, web = false } = {}) {
  // 이 앱의 묻기·루틴은 검색·읽기 도구만 (앱을 조작하는 도구는 외부 AI 앱에만, src/control.js)
  // web: 웹 정보 모으기 루틴 — AI의 웹 검색·웹 페이지 읽기만 켜고 내 문서 도구는 아예 넘기지 않는다
  //      (웹 페이지에 숨은 지시가 있어도 내 문서를 읽어 밖으로 보낼 길이 없게)
  // 내 문서 검색이 없으면(launch 없음) 문서 도구 없이 돈다
  const tl = launch ? { ...launch, env: { ...launch.env, MDS_TOOLS: "basic", ...(toolEnv || {}) } } : null;
  const docs = !web && !!tl;
  let cmd, args, input = null, cwd = workDir, env = {}, runDir = null;
  if (provider === "claude") {
    cmd = findClaude();
    if (!cmd) return { ok: false, message: "Claude Code가 설치돼 있지 않습니다." };
    const mcpFile = path.join(workDir, `mcp-claude-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { ...(docs ? { [SERVER_NAME]: { type: "stdio", ...tl } } : {}), ...(extra || {}) } }));
    setTimeout(() => fs.rm(mcpFile, () => {}), 60 * 60 * 1000).unref();
    const allowed = [...(web ? WEB_TOOLS.claude : docs ? TOOL_NAMES.map((t) => `mcp__${SERVER_NAME}__${t}`) : []), ...Object.keys(extra || {}).map((n) => `mcp__${n}`)];
    args = ["-p", question, "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      // --tools "": Claude Code 자체 도구(파일·명령·웹·Artifact·Workflow·예약 등)를 모두 끈다 — 문서에 숨은 지시가 있어도 할 수 있는 일은 검색·읽기뿐
      "--tools", web ? WEB_TOOLS.claude.join(",") : "", "--mcp-config", mcpFile, "--strict-mcp-config", "--allowedTools", ...allowed,
      "--disallowedTools", "Bash", "Edit", "Write", "Read", "Glob", "Grep", ...(web ? [] : ["WebFetch", "WebSearch"]), "Task", "NotebookEdit",
      "--append-system-prompt", system, "--no-session-persistence", ...(model ? ["--model", model] : [])];
  } else if (provider === "codex") {
    cmd = findCodex();
    if (!cmd) return { ok: false, message: "Codex가 설치돼 있지 않습니다." };
    const base = `mcp_servers.${SERVER_NAME}`;
    // 웹 검색: 새 Codex는 web_search="live", 예전 Codex는 tools.web_search=true (모르는 설정은 무시된다)
    const docArgs = web ? ["-c", 'web_search="live"', "-c", "tools.web_search=true"]
      : !docs ? [] : ["-c", `${base}.command=${toml(tl.command)}`, "-c", `${base}.args=${toml(tl.args)}`,
        "-c", `${base}.env=${toml(tl.env)}`, "-c", `${base}.default_tools_approval_mode="approve"`];
    args = ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", ...(model ? ["-m", model] : []), ...docArgs,
      ...Object.keys(extra || {}).flatMap((n) => ["-c", `mcp_servers.${n}.default_tools_approval_mode="approve"`]),
      `${system}\n\n질문: ${question}`];
  } else if (provider === "gemini") {
    cmd = findGemini();
    if (!cmd) return { ok: false, message: "Gemini(Antigravity) 프로그램이 설치돼 있지 않습니다. 설정 → AI 연결에서 ‘Google로 로그인’을 누르세요." };
    // 질문마다 빈 폴더에 플러그인(내 문서 MCP 서버 · 지시 · 도구 문지기)을 만든다. 끝나면 지운다 (src/agy.js)
    runDir = path.join(workDir, `gemini-${process.pid}-${Date.now()}`);
    const servers = !docs ? {} : { [SERVER_NAME]: { command: tl.command, args: tl.args, env: tl.env } };
    for (const [n, c] of Object.entries(extra || {})) servers[n] = c;
    const settings = agy.prepare(runDir, { servers, system, web, hookScript: path.join(__dirname, "agy-hook.js"), nodeCmd: process.execPath });
    const m = geminiModel(model);
    // 질문은 인자로 (agy는 표준 입력으로 질문을 받지 않는다). 아주 긴 요청은 지시 파일에 붙이고 짧은 안내만 넘긴다
    let q = question;
    if (q.length > 12000) {
      fs.appendFileSync(path.join(runDir, ".agents", "plugins", agy.PLUGIN, "rules", "AGENTS.md"), "\n## 이번 요청\n\n" + q + "\n");
      q = "지시의 ‘이번 요청’ 항목을 수행하라.";
    }
    args = ["-p", q, "--output-format", "stream-json", ...settings, ...(m ? ["--model", m] : [])];
    cwd = runDir;
    env = { ...netEnv() };
  } else {
    return { ok: false, message: "알 수 없는 AI" };
  }
  const started = Date.now();
  const child = spawn(cmd, args, { cwd, windowsHide: true, shell: isWin && cmd.endsWith(".cmd"),
    env: { ...process.env, NO_COLOR: "1", ...env }, stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"] });
  if (input != null) { child.stdin.on("error", () => {}); child.stdin.end(input); }
  let buf = "", errText = "", finalText = "", streamed = "";
  const gst = { streamed: "", finalText: "", model: "", failText: "", conversation: "" };       // Gemini(agy) 진행 상태
  const onLine = (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (provider === "claude") parseClaude(ev);
    else if (provider === "gemini") parseGemini(ev);
    else parseCodex(ev);
  };
  const parseClaude = (ev) => {
    if (ev.type === "stream_event" && ev.event?.type === "content_block_delta" && ev.event.delta?.type === "text_delta") {
      streamed += ev.event.delta.text;
      emit({ type: "delta", text: ev.event.delta.text });
    } else if (ev.type === "assistant") {
      for (const c of ev.message?.content || []) {
        if (c.type === "tool_use" && c.name.startsWith(`mcp__${SERVER_NAME}__`)) {
          emit({ type: "tool", name: c.name.replace(`mcp__${SERVER_NAME}__`, ""), input: c.input });
        }
      }
      if ((ev.message?.content || []).some((c) => c.type === "tool_use") && streamed) {
        emit({ type: "reset" });                 // 도구를 부르기 전의 중간 말은 지운다
        streamed = "";
      }
    } else if (ev.type === "result") {
      finalText = ev.result || streamed;
      const used = Object.entries(ev.modelUsage || {}).sort((a, b) => (b[1].outputTokens || 0) - (a[1].outputTokens || 0))[0];
      emit({ type: "usage", cost: ev.total_cost_usd, turns: ev.num_turns, model: used ? prettyClaude(used[0]) : "",
        error: ev.is_error ? (ev.result || "오류") : "" });
    }
  };
  const parseCodex = (ev) => {
    const item = ev.item || {};
    if (ev.type === "item.started" && item.type === "mcp_tool_call") emit({ type: "tool", name: item.tool, input: item.arguments });
    else if (ev.type === "item.completed" && item.type === "agent_message") {
      emit({ type: "reset" });                   // 마지막 메시지가 최종 답 (앞의 진행 안내는 지운다)
      finalText = item.text;
      emit({ type: "delta", text: item.text });
    }
    else if (ev.type === "turn.completed") emit({ type: "usage", tokens: ev.usage });
    else if (ev.type === "error" || ev.type === "turn.failed") emit({ type: "usage", error: ev.message || ev.error?.message || "오류" });
  };
  const parseGemini = (ev) => {
    if (ev.event === "init") gst.conversation = ev.conversation_id || "";
    agy.parse(ev, gst, emit, TOOL_NAMES);
    if (ev.event === "result") finalText = gst.finalText;
  };
  child.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  child.stderr.on("data", (d) => { errText += d.toString("utf8"); });
  child.on("close", (code) => {
    if (buf.trim()) onLine(buf);
    if (runDir) fs.rm(runDir, { recursive: true, force: true }, () => {});
    let error = code && !finalText ? (errText.trim().split("\n").slice(-3).join("\n") || `종료 코드 ${code}`) : "";
    if (provider === "gemini") {
      // agy는 실패해도 0으로 끝날 수 있다 — 결과 줄의 상태를 본다. 남은 대화 기록(찾아 넣은 문서 내용)은 지운다
      if (gst.failText && !finalText) error = gst.failText;
      else if (error) error = agy.error(error);
      agy.cleanup(gst.conversation);
    }
    emit({ type: "done", code, seconds: Math.round((Date.now() - started) / 100) / 10, text: finalText, error });
  });
  child.on("error", (e) => emit({ type: "done", code: -1, text: "", error: String(e.message || e) }));
  return { ok: true, child };
}

module.exports = { setProxyResolver, SYSTEM_PROMPT, runTask, cancelRuns, setLaunch, setToolsDir, models, modelLabel, status, signIn, signInCode, signInCancel, signOut, reset, installTool };
