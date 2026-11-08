// 내 문서 검색(MyDocSearch)과 잇기. 이 앱은 문서를 직접 색인하지 않고, 설치된 MyDocSearch를 빌려 쓴다.
//   - 문서 찾기·읽기: MyDocSearch가 앱 데이터 폴더에 남긴 mcp-launch.json(문서 검색 MCP 서버를 띄우는 방법)으로 봇마다 붙인다.
//     MyDocSearch가 꺼져 있어도 된다.
//   - 앱 작업(문서 저장·모음 담기·루틴 실행·OneDrive 보내기)·근거 문서 열기: 켜져 있는 MyDocSearch의 창구(control.json — 이 PC 안에서만, 열쇠 필요)로 보낸다.
//     조작은 MyDocSearch 설정 → AI·보안의 '외부 AI가 앱을 조작하도록 허용'이 켜져 있어야 MyDocSearch가 받는다 (이 앱의 봇 권한과 둘 다 필요).
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

function dataDir() {
  if (process.env.MCB_MDS_DATA) return process.env.MCB_MDS_DATA;                    // 시험용
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "MyDocSearch");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "MyDocSearch");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "MyDocSearch");
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

// 문서 검색 MCP 서버를 띄우는 방법 { command, args, env } — 실행 파일이 사라졌으면(앱을 옮김·지움) 없음
function launch() {
  const l = readJson(path.join(dataDir(), "mcp-launch.json"));
  if (!l || !l.command || !Array.isArray(l.args) || !fs.existsSync(l.command)) return null;
  return { command: l.command, args: l.args, env: l.env || {} };
}
// 켜져 있는 MyDocSearch의 창구
function control() {
  const c = readJson(path.join(dataDir(), "control.json"));
  return c && c.port && c.token && (!c.pid || alive(c.pid)) ? c : null;
}

function status() {
  const l = launch(), c = control();
  return { installed: !!l, running: !!c, where: l ? l.command : "", dataDir: dataDir() };
}

// 켜져 있는 MyDocSearch에 도구 하나를 맡긴다 → 결과 글
function call(name, args, client) {
  const c = control();
  if (!c) return Promise.reject(new Error("내 문서 검색(MyDocSearch)이 켜져 있지 않습니다. MyDocSearch를 연 뒤 다시 하세요."));
  const body = JSON.stringify({ name, args: args || {}, client: client || "MyCollaboratorBots" });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: c.port, path: "/tool", method: "POST", timeout: 10 * 60 * 1000,
      headers: { "content-type": "application/json", "x-mds-token": c.token, "content-length": Buffer.byteLength(body) } }, (res) => {
      let t = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { t += d; });
      res.on("end", () => {
        let m;
        try { m = JSON.parse(t); } catch { return reject(new Error(`내 문서 검색의 답을 읽지 못했습니다 (HTTP ${res.statusCode})`)); }
        if (m.error) reject(new Error(m.error)); else resolve(String(m.text ?? ""));
      });
    });
    req.on("timeout", () => req.destroy(new Error("내 문서 검색이 답하지 않습니다")));
    req.on("error", (e) => reject(new Error(`내 문서 검색에 연결하지 못했습니다 (${e.code || e.message})`)));
    req.end(body);
  });
}

module.exports = { dataDir, launch, control, status, call };
