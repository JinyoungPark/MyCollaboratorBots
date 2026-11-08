// 앱 이름·버전·배포 위치 한곳에 (버전 번호는 package.json 하나만 고친다 — scripts/bump-version.js)
// 새 버전 알림: 배포하는 GitHub 저장소의 최신 릴리스 번호만 확인한다 (보내는 정보 없음).
// API(시간당 60번 제한 — 회사망은 여러 사람이 같은 주소로 나간다) 대신 /releases/latest가 넘겨 주는 주소(…/tag/v0.1.2)를 본다.
const pkg = require("../package.json");

const APP_NAME = "MyCollaboratorBots";
const REPO = "JinyoungPark/MyCollaboratorBots";
const RELEASES = `https://github.com/${REPO}/releases`;
const ASSET_PREFIX = "MyCollaboratorBots";
const VERSION = pkg.version;

// "0.10.0" > "0.9.3"처럼 숫자로 비교
function newerVersion(a, b) {
  const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

// Electron 네트워크라 회사 프록시·인증서를 그대로 쓴다. 넘겨 주는 주소만 읽고 그 페이지는 받지 않는다
let cache = null;
async function checkUpdate(force, canUpdate) {
  if (!force && cache && Date.now() - cache.at < 6 * 3600 * 1000) return cache.v;
  let v;
  try {
    const { net } = require("electron");
    const to = await new Promise((resolve, reject) => {
      const req = net.request({ url: process.env.MCB_UPDATE_URL || `${RELEASES}/latest`, method: "HEAD", redirect: "manual" });
      const timer = setTimeout(() => { req.abort(); reject(new Error("응답 없음")); }, 15000);
      req.on("redirect", (_code, _method, url) => { clearTimeout(timer); resolve(url); req.abort(); });
      req.on("response", (res) => { clearTimeout(timer); res.resume(); reject(new Error(res.statusCode === 404 ? "아직 배포한 버전이 없습니다" : `HTTP ${res.statusCode}`)); });
      req.on("error", (e) => { clearTimeout(timer); reject(e); });
      req.end();
    });
    const m = /\/releases\/tag\/v?(\d+(?:\.\d+)+)$/.exec(to);
    if (!m) throw new Error("최신 버전을 알아내지 못했습니다");
    v = { current: VERSION, latest: m[1], newer: newerVersion(m[1], VERSION), url: new URL(to, RELEASES).href, canUpdate: !!canUpdate };
  } catch (e) {
    v = { current: VERSION, error: String(e.message || e) };
  }
  cache = { at: v.error ? Date.now() - 5.5 * 3600 * 1000 : Date.now(), v };     // 실패는 30분 뒤 다시
  return v;
}

module.exports = { APP_NAME, REPO, RELEASES, ASSET_PREFIX, VERSION, newerVersion, checkUpdate };
