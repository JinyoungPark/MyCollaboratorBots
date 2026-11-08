// agy(Gemini) 도구 문지기: 도구를 쓰기 직전마다 agy가 이 스크립트를 부른다 (플러그인 폴더에서, 표준 입력으로 도구 이름·인자).
// 허용 목록(allow.json) 밖의 도구는 모두 막는다 — 문서에 숨은 지시가 있어도 명령 실행·파일 읽기·쓰기·브라우저 조작으로 번지지 않게
const fs = require("fs");
const path = require("path");

let input = "";
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  let allow = {}, call = {};
  try { allow = JSON.parse(fs.readFileSync(path.join(process.cwd(), "allow.json"), "utf8")); } catch { /* 없으면 모두 막음 */ }
  try { call = JSON.parse(input).toolCall || {}; } catch { /* 모양이 다르면 막음 */ }
  const name = call.name || "", args = call.args || {};
  const servers = allow.servers || [];
  const inside = (p, dir) => { const r = path.relative(dir, path.resolve(String(p || ""))); return !!dir && !!r && !r.startsWith("..") && !path.isAbsolute(r); };
  const ok =
    (name === "call_mcp_tool" && servers.includes(args.ServerName)) ||
    // MCP 도구 설명 파일 (agy가 도구를 쓰기 전에 읽는다) — 우리 서버 것만
    ((name === "read_file" || name === "view_file") && servers.some((s) => inside(args.Path || args.AbsolutePath, path.join(allow.mcpDir || "", s)))) ||
    (allow.web && (name === "search_web" || name === "read_url_content")) ||
    name === "finish";
  process.stdout.write(JSON.stringify(ok ? { decision: "allow" } : { decision: "deny", reason: "이 앱의 봇은 내 문서 검색 도구만 쓸 수 있습니다 (명령 실행·파일 읽기·쓰기 안 됨)." }));
});
