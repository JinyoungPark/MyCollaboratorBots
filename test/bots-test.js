// 시험: 앱을 띄워 화면으로 봇 팀을 돌린다 — 실제 AI 대신 가짜 runTask, 실제 MyDocSearch 대신 가짜 창구(control.json)
//   예시 팀 만들기 · 팀장이 나눠 맡김 → 팀원 동시에 → 팀장이 모아 답 · 앱 작업 권한(물어보고: 허용 카드 / 바로: 바로 함 / 보기만: 막음)
//   근거 링크 → MyDocSearch에서 열기 · 답을 문서로 저장 · 예약 작업 · 멈추기 · 설정(AI 연결·내 문서 검색·정보) · 버전 표시
// 사용: npm test  (electron test/bots-test.js)
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcb-ui-"));
process.env.MCB_DATA = path.join(tmp, "data");
process.env.MCB_SAVE_DIR = path.join(tmp, "saved");
process.env.MCB_MDS_DATA = path.join(tmp, "mds");
process.env.MCB_UPDATE_URL = "http://127.0.0.1:1/releases/latest";       // 새 버전 확인은 실패로 (밖에 나가지 않게)
const { app } = require("electron");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, info = "") => { checks.push(!!ok); console.log(ok ? "PASS" : "FAIL", name, String(info).slice(0, 220).replace(/\n/g, " ⏎ ")); };

// 가짜 MyDocSearch: 문서 검색 MCP 서버 위치 + 켜져 있는 앱의 창구
fs.mkdirSync(process.env.MCB_MDS_DATA, { recursive: true });
fs.writeFileSync(path.join(process.env.MCB_MDS_DATA, "mcp-launch.json"), JSON.stringify({ command: process.execPath, args: ["mcp-server.js"], env: {} }));
const seen = [];
const server = http.createServer((req, res) => {
  let b = "";
  req.on("data", (d) => { b += d; });
  req.on("end", () => {
    const m = JSON.parse(b); seen.push(m);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ text: m.name === "save_document" ? `저장했습니다: ${m.args.title}.md` : `${m.name} 했습니다` }));
  });
});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(path.join(process.env.MCB_MDS_DATA, "control.json"), JSON.stringify({ port: server.address().port, token: "t0ken", pid: process.pid })));

// 가짜 AI: 누가(시스템 지시의 봇 이름) 무엇을(계획·맡은 일·모으기) 하는지에 따라 답한다
const ai = require("../src/ai.js");
const calls = [];
let hold = null;                                   // 멈추기 시험: 끝나지 않는 실행
ai.runTask = (provider, prompt, opts) => new Promise((resolve) => {
  const who = (opts.system.match(/봇 “([^”]+)”/) || [])[1];
  calls.push({ who, provider, model: opts.model, prompt, t: Date.now() });
  const done = (text) => setTimeout(() => resolve({ ok: true, text, tools: [{ name: "search_documents" }], model: "가짜 " + provider, seconds: 0.3 }), 300);
  if (/멈춤 시험/.test(prompt)) { hold = () => resolve({ ok: false, text: "", error: "취소", tools: [] }); return; }
  if (who === "팀장" && /팀원들의 결과/.test(prompt)) {
    return done("## 최종 정리\n- 견적 A가 더 쌉니다 [견적A.pdf · 1쪽](doc:1#c1)\n\n```앱작업\n[{\"도구\": \"save_document\", \"인자\": {\"title\": \"견적 비교\", \"markdown\": \"# 견적 비교\", \"format\": \"md\"}}]\n```");
  }
  if (who === "팀장") {
    if (/요청: 인사/.test(prompt)) return done("안녕하세요. 바로 답합니다.");
    return done("조사와 검토에게 나눠 맡깁니다.\n\n```팀작업\n[{\"봇\": \"조사\", \"일\": \"견적서를 찾아 금액을 뽑기\"}, {\"봇\": \"검토\", \"일\": \"견적서끼리 다른 조건 찾기\"}, {\"봇\": \"없는봇\", \"일\": \"무시\"}]\n```");
  }
  if (who === "조사") return done("견적 A 100만 원, B 120만 원.\n\n```앱작업\n{\"도구\": \"create_collection\", \"인자\": {\"name\": \"견적 모음\"}}\n```");
  if (who === "검토") return done("납기 조건이 다릅니다.\n\n```앱작업\n{\"도구\": \"create_collection\", \"인자\": {\"name\": \"몰래 모음\"}}\n```");
  return done("?");
});
ai.cancelRuns = () => { if (hold) { hold(); hold = null; } };
ai.status = async () => ({ claude: { installed: true, loggedIn: true }, codex: { installed: true, loggedIn: false }, gemini: { installed: false, loggedIn: false } });
ai.models = async (p) => ({ models: p === "claude" ? [{ id: "", name: "기본" }, { id: "sonnet", name: "Sonnet" }] : [{ id: "", name: "기본" }] });

app.on("browser-window-created", (_e, win) => {
  win.webContents.once("did-finish-load", async () => {
    if (!win.webContents.getURL().endsWith("index.html")) return;
    const js = (code) => win.webContents.executeJavaScript(code);
    const api = (u, b) => js(`window.mcb.call(${JSON.stringify(u)}, ${JSON.stringify(b || {})})`);
    const msgs = async (room) => (await api("/api/bots/room", { id: room })).messages;
    const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await wait(150); } return false; };
    try {
      await wait(1000);
      check("처음: 예시 팀 만들기 안내", /예시 팀 만들기/.test(await js(`$("botBody").innerText`)));
      check("위: 내 문서 검색 켜짐 표시", /켜짐/.test(await js(`$("docsChip").textContent`)));
      await js(`$("botSample").click(); 0`);
      await until(async () => (await api("/api/bots")).rooms.length === 1);
      let st = await api("/api/bots");
      const room = st.rooms[0];
      const id = Object.fromEntries(st.bots.map((b) => [b.name, b.id]));
      check("예시 팀: 봇 4개 · 팀장 + 팀원 3", st.bots.length === 4 && room.lead === id["팀장"] && room.members.length === 3 && st.bots.every((b) => b.provider === "claude" && b.model === "sonnet"), JSON.stringify(room));
      check("예시 팀: 팀장은 물어보고, 팀원은 보기만", st.bots.find((b) => b.name === "팀장").perm === "ask" && st.bots.find((b) => b.name === "조사").perm === "off");
      await until(async () => /문서 팀/.test(await js(`$("botChat") ? $("botChat").innerText : ""`)));
      const josa = st.bots.find((b) => b.name === "조사");
      await api("/api/bots/save", { ...josa, perm: "auto", provider: "codex", model: "" });

      // 1) 바로 답
      await api("/api/bots/send", { id: room.id, text: "인사해 줘" });
      await until(async () => (await msgs(room.id)).some((m) => m.who === "bot" && m.status === "" && /바로 답합니다/.test(m.text)));
      let m = await msgs(room.id);
      check("간단한 일: 팀장이 바로 답함 (팀원 안 부름)", m.filter((x) => x.who === "bot").length === 1 && calls.length === 1, m.map((x) => x.who + ":" + x.text).join(" | "));

      // 2) 화면에서 보내기 → 나눠 맡김
      calls.length = 0;
      check("화면: 보내기 버튼", await until(async () => js(`!!$("botSend")`)));
      await js(`$("botInput").value = "견적서 비교해서 정리하고 문서로 남겨 줘"; $("botSend").click(); 0`);
      const ok = await until(async () => (await msgs(room.id)).some((x) => x.data.step === "sum" && x.status === ""), 12000);
      m = await msgs(room.id);
      const plan = m.filter((x) => x.data.step === "plan").pop(), tasks = m.filter((x) => x.data.step === "task"), sum = m.find((x) => x.data.step === "sum");
      check("팀장 계획: 블록은 지우고 계획만 보임", ok && plan && /나눠 맡깁니다/.test(plan.text) && !/팀작업/.test(plan.text), plan && plan.text);
      check("팀원 2명에게 맡김 (없는 봇은 무시)", tasks.length === 2 && tasks.map((t) => t.bot_id).sort().join() === [id["조사"], id["검토"]].sort().join());
      const tc = calls.filter((c) => c.who === "조사" || c.who === "검토");
      check("팀원은 동시에 일함", tc.length === 2 && Math.abs(tc[0].t - tc[1].t) < 250);
      check("봇마다 자기 AI·모델로 (조사는 Codex)", calls.find((c) => c.who === "조사").provider === "codex" && calls.find((c) => c.who === "검토").model === "sonnet");
      check("팀장이 팀원 결과를 받아 모음", /견적 A 100만 원/.test(calls[calls.length - 1].prompt) && sum && /최종 정리/.test(sum.text) && !/앱작업/.test(sum.text));
      const acts = m.filter((x) => x.kind === "action");
      const a = (bot) => acts.find((x) => x.bot_id === id[bot]);
      check("권한 바로: 조사의 모음 만들기를 MyDocSearch에 맡김", a("조사") && a("조사").status === "done" && seen.some((s) => s.name === "create_collection" && s.args.name === "견적 모음" && s.client === "MyCollaboratorBots · 조사"));
      check("권한 보기만: 검토의 모음 만들기는 막음", a("검토") && a("검토").status === "blocked" && !seen.some((s) => s.args && s.args.name === "몰래 모음"));
      check("권한 물어보고: 팀장의 문서 저장은 허용 카드", a("팀장") && a("팀장").status === "pending" && /문서 저장: “견적 비교”/.test(a("팀장").text));
      await until(async () => /허용/.test(await js(`$("botMsgs").innerText`)));
      const html = await js(`$("botMsgs").innerText`);
      check("화면: 단계 표시 · 근거 링크 · 허용/거절", /계획/.test(html) && /맡은 일/.test(html) && /최종 답/.test(html) && /거절/.test(html) && await js(`!!$("botMsgs").querySelector('a.doc[data-doc="1"]')`));
      if (process.env.MCB_SNAP) { win.setSize(1280, 860); await wait(600); fs.writeFileSync(path.join(process.env.MCB_SNAP, "bots.png"), (await win.webContents.capturePage()).toPNG()); }
      await js(`$("botMsgs").querySelector('[data-allow][data-v="1"]').click(); 0`);
      await until(async () => (await msgs(room.id)).find((x) => x.id === a("팀장").id).status === "done");
      check("허용하면 MyDocSearch에 문서 저장", seen.some((s) => s.name === "save_document" && s.args.title === "견적 비교"));
      check("한 번 처리한 작업은 다시 못 함", (await api("/api/bots/act", { msg: a("팀장").id, allow: true })).ok === false);

      // 근거 링크 → MyDocSearch 뷰어
      await js(`$("botMsgs").querySelector('a.doc[data-doc="1"]').click(); 0`);
      check("근거 링크: MyDocSearch에서 열기", await until(async () => seen.some((s) => s.name === "show_document" && s.args.id === 1 && s.args.chunk === 1)));

      // 3) 답을 문서로 저장 (이 앱의 저장 폴더)
      await js(`window.prompt = () => "봇 답 저장"; $("botMsgs").querySelectorAll("[data-save]")[0].click(); 0`);
      const docx = path.join(process.env.MCB_SAVE_DIR, "봇 답 저장.docx");
      check("문서로 저장: 워드 파일", await until(async () => fs.existsSync(docx) && fs.statSync(docx).size > 1000), docx);

      // 4) 예약 작업
      const sv = await api("/api/bots/room/save", { ...room, schedule: { every: "daily", time: "07:30" }, sched_prompt: "인사 예약" });
      st = await api("/api/bots");
      const r2 = st.rooms.find((x) => x.id === sv.id);
      check("예약 작업: 다음 실행 시각 · 표시", r2.next_run > Date.now() / 1000 && /매일 07:30/.test(r2.when), r2.when);
      require("../src/bots.js").send(room.id, "인사 예약", "일정");
      await until(async () => (await msgs(room.id)).slice(-1)[0].status === "" && /바로 답합니다/.test((await msgs(room.id)).slice(-1)[0].text));
      m = await msgs(room.id);
      check("예약 작업: 일정으로 보냄 → 팀이 답함", m.some((x) => x.who === "system" && x.data.trigger === "일정") && /예약 작업의 요청: 인사 예약/.test(calls[calls.length - 1].prompt));

      // 5) 멈추기
      await api("/api/bots/send", { id: room.id, text: "멈춤 시험" });
      await until(async () => (await api("/api/bots")).rooms[0].busy);
      await wait(400);
      check("일하는 중: 멈추기 버튼", await js(`!!$("botStop")`));
      await js(`$("botStop").click(); 0`);
      await until(async () => !(await api("/api/bots")).rooms[0].busy);
      m = await msgs(room.id);
      check("멈추기: 멈췄습니다", m.slice(-1)[0].status === "stopped", m.slice(-1)[0].text);

      // 6) 팀에 든 봇은 지우지 못함
      const rm = await api("/api/bots/remove", { id: id["조사"] });
      check("팀에 든 봇은 지우지 못함", !rm.ok && /팀에 들어 있습니다/.test(rm.message));

      // 7) 설정: AI 연결 · 내 문서 검색 · 정보
      await js(`openSettings("ai"); 0`);
      await until(async () => /연결됨/.test(await js(`$("aiRows").innerText`)));
      const rows = await js(`$("aiRows").innerText`);
      check("설정 → AI 연결: Claude 연결됨 · ChatGPT·Google 로그인 버튼", /Claude · 연결됨/.test(rows) && /ChatGPT로 로그인/.test(rows) && /Google로 로그인/.test(rows), rows.slice(0, 200));
      await js(`$("aiRows").querySelector('[data-disconnect="claude"]') && (window.confirm = () => true, $("aiRows").querySelector('[data-disconnect="claude"]').click()); 0`);
      check("연결 끊기 → 다시 연결 버튼", await until(async () => js(`!!$("aiRows").querySelector('[data-reconnect="claude"]')`)));
      await api("/api/ai/reconnect", { target: "claude" });
      await js(`setSection("docs"); 0`);
      check("설정 → 내 문서 검색: 켜져 있음", await until(async () => /켜져 있음/.test(await js(`$("docsInfo").innerText`))));
      await js(`setSection("about"); 0`);
      await until(async () => /버전/.test(await js(`$("aboutKv").innerText`)));
      const ver = require("../package.json").version;
      check("설정 → 정보: 버전", (await js(`$("aboutKv").innerText`)).includes(ver));
      check("새 버전 확인 실패도 알려 줌 · 위에 버전", await until(async () => /확인하지 못했습니다/.test(await js(`$("updState").innerText`))) && (await js(`$("verLabel").textContent`)) === "v" + ver);
      const diag = await api("/api/diag");
      check("진단 정보: 버전·봇 수 (대화 내용 없음)", diag.text.includes(ver) && /봇 4개/.test(diag.text) && !/견적/.test(diag.text), diag.text.split("\n")[1]);
    } catch (e) {
      check("시험 중 오류", false, e.stack || e);
    }
    const fail = checks.filter((x) => !x).length;
    console.log(`\n${checks.length - fail}/${checks.length} 통과`);
    app.exit(fail ? 1 : 0);
  });
});

require("../src/main.js");
