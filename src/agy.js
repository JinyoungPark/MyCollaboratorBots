// Gemini 연결: Google의 Antigravity CLI(agy)로 개인 Google 계정(무료·Google AI Pro·Ultra)에 연결한다.
// (Gemini CLI의 개인 계정 Google 로그인은 2026년 6월에 끝나 "This client is no longer supported…"로 거절된다)
//   설치 — Google 공식 배포 목록(manifest)에서 이 PC용 파일 주소와 SHA-512를 받아 앱 폴더(tools/agy)에 내려받고 해시를 확인한다.
//          agy는 Google 이용약관을 따르는 프로그램이라 앱 zip에 넣지 않는다. 설치한 뒤에는 agy가 스스로 새 버전으로 바꾼다
//   로그인 — agy의 편집기 연결 모드(ACP)로 Google 로그인을 부탁하면 agy가 브라우저를 열고, 허용하면 저절로 끝난다 (터미널·코드 없음).
//          이 앱은 로그인 정보를 읽거나 저장하지 않는다. 로그인 정보는 agy가 자기 위치에 둔다
//   묻기 — 질문마다 빈 작업 폴더에 플러그인(.agents/plugins/mds)을 만들어 내 문서 MCP 서버 · 지시(rules) · 도구 문지기(hook)를 둔다.
//          문지기는 내 문서 도구(웹 루틴이면 웹 검색·웹 읽기)만 허용하고 명령 실행·파일 읽기·쓰기·브라우저 조작 등 나머지는 모두 막는다
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");

const isWin = process.platform === "win32";
const PLUGIN = "mds";                                     // 플러그인 이름 — agy는 그 안의 MCP 서버 이름 앞에 "mds_"를 붙인다
const MANIFEST_BASE = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";   // 공식 설치 스크립트(antigravity.google/cli/install.sh)와 같은 곳
const WEB_TOOLS = ["search_web", "read_url_content"];
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const agyHome = () => path.join(os.homedir(), ".gemini", "antigravity-cli");

function platform() {
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  return isWin ? `windows_${arch}` : process.platform === "darwin" ? `darwin_${arch}` : `linux_${arch}`;
}

const appAgy = (toolsDir) => toolsDir && path.join(toolsDir, "agy", isWin ? "agy.exe" : "agy");

// 앱이 받아 둔 agy → 공식 설치 스크립트로 깐 agy 순
function find(toolsDir) {
  if (process.env.MCB_AGY) return exists(process.env.MCB_AGY) ? process.env.MCB_AGY : null;      // 시험용
  const cands = [appAgy(toolsDir), isWin ? path.join(process.env.LOCALAPPDATA || "", "agy", "bin", "agy.exe") : path.join(os.homedir(), ".local", "bin", "agy")];
  return cands.find((p) => p && exists(p)) || null;
}

// 받은 파일을 제자리로: 윈도우에서는 백신(Defender)이 막 받은 실행 파일을 검사하느라 잠시 잠가 두어 이름 바꾸기가 EPERM·EBUSY로
// 거절될 수 있다 → 잠깐씩 기다리며 다시 해 보고, 끝내 안 되면 복사한다
async function place(src, dest) {
  for (let i = 0; i < 20; i++) {
    try { fs.rmSync(dest, { force: true }); fs.renameSync(src, dest); return; } catch (e) {
      if (!/EPERM|EBUSY|EACCES/.test(e.code || "")) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  try { fs.copyFileSync(src, dest); } catch (e) {
    throw new Error("받은 프로그램을 설치 폴더로 옮기지 못했습니다. 백신 프로그램이 agy.exe를 막고 있을 수 있습니다 (허용 목록에 넣은 뒤 다시 시도). (" + (e.code || e.message) + ")");
  }
}

// "fetch failed"만으로는 원인을 알 수 없어 속 원인(인증서·DNS·연결 거절 등)을 덧붙인다
const why = (e) => [e.message || String(e), e.cause && (e.cause.code || e.cause.message)].filter(Boolean).join(": ");

async function install(toolsDir, emit, download, get = fetch) {
  if (!toolsDir) throw new Error("설치 위치가 정해지지 않았습니다.");
  emit({ phase: "install", text: "Gemini(Antigravity) 프로그램 확인 중…" });
  let m;
  try {
    const res = await get(`${process.env.MCB_AGY_MANIFEST_BASE || MANIFEST_BASE}/${platform()}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    m = await res.json();
  } catch (e) {
    throw new Error(`Google 배포 서버에 연결하지 못했습니다 (${why(e)}). 회사망이 막고 있을 수 있습니다.`);
  }
  if (!m || !m.url || !m.sha512) throw new Error("Google 배포 목록을 읽지 못했습니다.");
  const dest = appAgy(toolsDir), dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, /\.tar\.gz/.test(m.url) ? "agy.tar.gz" : "agy.download");
  try {
    await download(m.url, tmp, (pct) => emit({ phase: "install", text: `Gemini(Antigravity) 프로그램 내려받는 중… ${pct}%` }));
  } catch (e) {
    throw new Error(`Gemini(Antigravity) 프로그램을 내려받지 못했습니다 (${why(e)}). 회사망에서 storage.googleapis.com 접속이 막혀 있는지 확인하세요.`);
  }
  try {
    const hash = crypto.createHash("sha512").update(fs.readFileSync(tmp)).digest("hex");
    if (hash !== m.sha512) throw new Error("받은 파일이 Google이 알린 것과 다릅니다(해시 불일치). 회사망 보안 장비가 파일을 바꿨을 수 있습니다.");
    emit({ phase: "install", text: "Gemini(Antigravity) 프로그램 설치 중…" });
    if (tmp.endsWith(".tar.gz")) {
      await new Promise((resolve, reject) => execFile("tar", ["-xzf", tmp, "-C", dir, "antigravity"], (err) => (err ? reject(err) : resolve())));
      fs.renameSync(path.join(dir, "antigravity"), dest);
    } else await place(tmp, dest);
    if (!isWin) fs.chmodSync(dest, 0o755);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 백신이 잡고 있으면 다음에 지운다 */ }
  }
  if (!exists(dest)) throw new Error("설치한 프로그램이 사라졌습니다. 백신 프로그램이 막았을 수 있습니다 (agy.exe 허용 필요).");
}

// 로그인 상태와 쓸 수 있는 모델: `agy models` (로그인 안 됐으면 "Please sign in"). 자주 부르지 않게 1분 기억한다
let authCache = null;
function auth(cmd, env, force = false) {
  if (!cmd) return Promise.resolve({ loggedIn: false, models: [] });
  if (!force && authCache && Date.now() - authCache.at < 60000) return Promise.resolve(authCache.v);
  return new Promise((resolve) => {
    execFile(cmd, ["models"], { timeout: 30000, windowsHide: true, env: { ...process.env, NO_COLOR: "1", ...env } }, (err, stdout, stderr) => {
      const out = String(stdout || "") + String(stderr || "");
      const models = String(stdout || "").split("\n").map((l) => l.split("\t")).filter((p) => p.length >= 2 && p[0].trim())
        .map(([id, name]) => ({ id: id.trim(), name: name.trim() }));
      const loggedIn = !/sign in/i.test(out) && (models.length > 0 || !err);
      const v = { loggedIn, models, how: "google" };
      authCache = { at: Date.now(), v };
      resolve(v);
    });
  });
}
const forget = () => { authCache = null; };
const cachedModels = () => (authCache && authCache.v.models) || [];

// 로그인: agy의 편집기 연결 모드(ACP, `agy acp`)에 Google 로그인을 부탁한다. agy가 브라우저에 Google 로그인 화면을 열고,
// 사용자가 허용하면 이 PC(localhost)로 돌아와 스스로 끝낸다 — 코드 붙여 넣기도 터미널도 없다.
// (`agy -p`의 로그인은 조종 터미널(/dev/tty·CONIN$)에서 코드를 읽어, 창 없이 도는 앱에서는 "no controlling terminal"로 거절된다)
function login(cmd, emit, job, env, workDir, waitMs = 10 * 60 * 1000) {
  fs.mkdirSync(workDir, { recursive: true });
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, ["acp"], { cwd: workDir, windowsHide: true, env: { ...process.env, NO_COLOR: "1", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    job.child = c;
    c.stdin.on("error", () => {});
    const send = (o) => { if (c.stdin.writable) c.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n"); };
    let buf = "", err = "", settled = false;
    const end = (e) => {
      if (settled) return;
      settled = true; clearTimeout(timer); forget();
      try { c.kill(); } catch { /* 이미 끝남 */ }
      if (job.cancelled) return reject(new Error("취소했습니다."));
      e ? reject(e) : resolve();
    };
    const timer = setTimeout(() => end(new Error("10분 동안 로그인이 끝나지 않아 멈췄습니다. 브라우저에서 Google 로그인과 ‘허용’까지 마쳤는데도 그렇다면, 회사 프록시·보안 프로그램이 이 PC 안 주소(localhost)로 돌아오는 연결을 막은 것일 수 있습니다.")), waitMs);
    c.stdout.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1 && m.result) {
          const methods = (m.result.authMethods || []).map((x) => x.id);
          if (methods.length && !methods.includes("oauth-personal")) return end(new Error("이 버전의 Antigravity는 Google 계정 로그인을 지원하지 않습니다: " + methods.join(", ")));
          send({ id: 2, method: "authenticate", params: { methodId: "oauth-personal" } });
          emit({ phase: "login", text: "브라우저에서 Google 계정으로 로그인하고 ‘허용’을 누르세요… (끝나면 저절로 연결됩니다)" });
        } else if (m.id === 2) {
          if (m.error) end(new Error(error(m.error.message || "로그인하지 못했습니다.")));
          else end();
        } else if (m.id === 1 && m.error) end(new Error(error(m.error.message || "Antigravity를 시작하지 못했습니다.")));
      }
    });
    c.stderr.on("data", (d) => { err = (err + d.toString("utf8")).slice(-2000); });
    c.on("error", (e) => end(new Error(String(e.message || e))));
    c.on("close", (code) => end(new Error("Antigravity가 로그인 중에 멈췄습니다" + (code ? ` (종료 코드 ${code})` : "") + (err.trim() ? "\n" + err.trim().split("\n").slice(-2).join("\n") : ""))));
    send({ id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
  });
}

// 질문마다 쓰는 플러그인: MCP 서버 · 지시 · 도구 문지기
//   runDir/.agents/plugins/mds/{plugin.json, mcp_config.json, rules/AGENTS.md, hooks.json, hook.cmd|hook.sh, allow.json}
function prepare(runDir, { servers, system, web, hookScript, nodeCmd }) {
  const pdir = path.join(runDir, ".agents", "plugins", PLUGIN);
  fs.mkdirSync(path.join(pdir, "rules"), { recursive: true });
  fs.writeFileSync(path.join(pdir, "plugin.json"), JSON.stringify({ name: PLUGIN }));
  fs.writeFileSync(path.join(pdir, "mcp_config.json"), JSON.stringify({ mcpServers: servers }, null, 2));
  fs.writeFileSync(path.join(pdir, "rules", "AGENTS.md"), system + "\n");
  const names = Object.keys(servers).map((n) => `${PLUGIN}_${n}`);
  // 문지기가 읽는 허용 목록. MCP 도구 설명 파일(agy가 도구를 쓰기 전에 읽음)만 파일 읽기를 허용한다
  fs.writeFileSync(path.join(pdir, "allow.json"), JSON.stringify({ servers: names, web: !!web, mcpDir: path.join(agyHome(), "mcp") }));
  // 훅 명령은 유닉스 sh -c, 윈도우 cmd /c로 플러그인 폴더에서 돈다 → 경로 따옴표 문제가 없게 작은 실행 파일을 두고 그 이름만 부른다
  const hook = isWin ? "hook.cmd" : "./hook.sh";
  // (윈도우: 경로에 한글이 있어도 읽히게 UTF-8 코드 페이지로 바꾼 뒤 실행)
  if (isWin) fs.writeFileSync(path.join(pdir, "hook.cmd"), `@chcp 65001 >nul\r\n@set ELECTRON_RUN_AS_NODE=1\r\n@"${nodeCmd}" "${hookScript}"\r\n`);
  else fs.writeFileSync(path.join(pdir, "hook.sh"), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${nodeCmd}" "${hookScript}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(pdir, "hooks.json"), JSON.stringify({ gate: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hook, timeout: 20 }] }] } }, null, 2));
  // 창 없이 돌 때는 허락을 물을 수 없어 규칙에 없는 도구는 거절된다 → 우리 도구만 허락 규칙에 넣는다 (한 번 쓰고 저장하지 않는 설정)
  const settings = { permissions: {
    allow: [...names.map((n) => `mcp(${n}/*)`), `read_file(${path.join(agyHome(), "mcp")}${path.sep})`, ...(web ? ["read_url(*)"] : [])],
    deny: ["command(*)", "write_file(*)", "execute_url(*)", ...(web ? [] : ["read_url(*)"])] } };
  return ["--settings", JSON.stringify(settings)];
}

// stream-json 한 줄 → 화면 이벤트. st: { streamed, finalText, model, failText, tools }
function parse(ev, st, emit, toolNames) {
  if (ev.event === "init") st.model = ev.init?.model || "";
  else if (ev.event === "step_update") {
    const u = ev.step_update || {};
    if (u.step_type === "agent_response" && u.text_delta) {
      st.streamed += u.text_delta;
      emit({ type: "delta", text: u.text_delta });
    } else if (u.step_type === "tool" && u.state === "ACTIVE") {
      const p = u.tool_info?.parameters || {};
      if (u.tool_name === "call_mcp_tool" && p.ServerName === `${PLUGIN}_mydocsearch` && toolNames.includes(p.ToolName)) emit({ type: "tool", name: p.ToolName, input: p.Arguments });
      if (st.streamed) { emit({ type: "reset" }); st.streamed = ""; }          // 도구를 부르기 전의 중간 말은 지운다
    }
  } else if (ev.event === "result") {
    const r = ev.result || {};
    st.finalText = r.response || st.streamed;
    if (r.status && r.status !== "SUCCESS") st.failText = error(r.error || r.status);
    emit({ type: "usage", tokens: r.usage, model: st.model, error: st.failText });
  }
}

// 오류를 알아듣는 말로 (원래 문구는 괄호에)
function error(msg) {
  const m = String(msg || "").trim();
  const orig = "\n(" + m.split("\n")[0].slice(0, 200) + ")";
  if (/sign in|not signed in|authentication (?:required|failed)|unauthenticated|invalid_grant|re-?auth/i.test(m)) return "Gemini 로그인이 필요합니다. 설정 → AI 연결에서 ‘Google로 로그인’을 다시 하세요." + orig;
  if (/quota|rate limit|RESOURCE_EXHAUSTED|\b429\b|usage limit/i.test(m)) return "Gemini 사용 한도에 도달했습니다 (무료 계정은 주간 사용량이 더 적음). 잠시 뒤 다시 하거나, 모델을 Flash로 바꾸거나, Claude·ChatGPT로 바꿔 물어보세요." + orig;
  if (/not eligible|ineligible|not supported|UNSUPPORTED_LOCATION|not available in your (?:country|location)/i.test(m)) return "Google이 이 계정(또는 접속 위치)에서는 쓸 수 없다고 답했습니다. 개인 Google 계정인지, 회사 VPN·프록시를 거치고 있지 않은지 확인하세요." + orig;
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|connection refused|no such host|proxy|x509|certificate/i.test(m)) return "Google 서버에 연결하지 못했습니다 (회사 방화벽·프록시가 막았을 수 있음). 회사망 밖에서 해 보거나 IT 담당에게 문의하세요." + orig;
  return m;
}

// 답이 끝나면 agy가 남긴 대화 기록(찾아 넣은 문서 내용 포함)을 지운다
function cleanup(conversationId) {
  if (!conversationId || !/^[\w-]+$/.test(conversationId)) return;
  const h = agyHome();
  fs.rm(path.join(h, "brain", conversationId), { recursive: true, force: true }, () => {});
  fs.rm(path.join(h, "conversations", conversationId + ".db"), { force: true }, () => {});
}

module.exports = { find, install, auth, forget, cachedModels, login, prepare, parse, error, cleanup, WEB_TOOLS, PLUGIN };
