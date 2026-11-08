// 시험: 화면 없이 도는 부분 — 버전 비교·버전 올리기 · 예약 일정 · 데이터 형식(변환) · 내 문서 검색 잇기 · 봇 팀 흐름(가짜 AI·가짜 MyDocSearch)
// 사용: npm run test:unit  (Node 22.5 이상 — node:sqlite)
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcb-unit-"));
const checks = [];
const check = (name, ok, info = "") => { checks.push(!!ok); console.log(ok ? "PASS" : "FAIL", name, String(info).slice(0, 200).replace(/\n/g, " ⏎ ")); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await wait(50); } return false; };

(async () => {
  // ---------- 버전 ----------
  const version = require("../src/version");
  check("버전 비교", version.newerVersion("0.10.0", "0.9.9") && !version.newerVersion("0.1.0", "0.1.0") && version.newerVersion("1.0", "0.9.9.9") && !version.newerVersion("0.1.0", "0.1.1"));
  check("버전은 package.json 하나에서", version.VERSION === require("../package.json").version && /^\d+\.\d+\.\d+$/.test(version.VERSION), version.VERSION);
  check("배포 위치", version.RELEASES === "https://github.com/JinyoungPark/MyCollaboratorBots/releases");
  const bv = require("../scripts/bump-version");
  check("버전 올리기", bv.bump("0.1.9", "patch") === "0.1.10" && bv.bump("0.1.9", "minor") === "0.2.0" && bv.bump("0.1.9", "major") === "1.0.0" && bv.bump("0.1.9", "2.3.4") === "2.3.4");
  let threw = false; try { bv.bump("0.1.0", "x"); } catch { threw = true; }
  check("버전 올리기: 이상한 값은 거절", threw);
  check("CHANGELOG에 지금 버전과 '다음 버전'", (() => { const t = fs.readFileSync(path.join(__dirname, "..", "CHANGELOG.md"), "utf8"); return /^## 다음 버전\s*$/m.test(t) && t.includes(`## ${version.VERSION} (`); })());

  // ---------- 예약 일정 ----------
  const sch = require("../src/schedule");
  const from = new Date(2026, 10, 9, 8, 0).getTime();                   // 2026-11-09 (월) 08:00
  check("매일: 오늘 09:00", sch.nextRun({ every: "daily", time: "09:00" }, from) * 1000 === new Date(2026, 10, 9, 9, 0).getTime());
  check("매주 금: 금요일", new Date(sch.nextRun({ every: "weekly", days: [5], time: "17:00" }, from) * 1000).getDay() === 5);
  check("매시간 30분", sch.nextRun({ every: "hourly", time: "00:30" }, from) * 1000 === new Date(2026, 10, 9, 8, 30).getTime());
  check("직접 실행: 다음 없음", sch.nextRun({ every: "manual" }, from) === null && sch.scheduleLabel({ every: "weekly", days: [1, 3], time: "10:00" }) === "매주 월·수 10:00");

  // ---------- 데이터 형식 ----------
  const store = require("../src/store");
  store.init(path.join(tmp, "data"));
  const db = store.connect();
  check("데이터 형식 버전 기록", db.prepare("PRAGMA user_version").get().user_version === store.SCHEMA_VERSION);
  db.close();
  const db2 = store.connect();                                         // 다시 열어도 그대로
  check("다시 열기", db2.prepare("PRAGMA user_version").get().user_version === store.SCHEMA_VERSION);
  store.saveConfig({ ai_off: { codex: true } });
  check("설정 저장·읽기", store.loadConfig().ai_off.codex === true);

  // ---------- 내 문서 검색 잇기 (가짜 MyDocSearch) ----------
  const mds = path.join(tmp, "mds");
  fs.mkdirSync(mds);
  process.env.MCB_MDS_DATA = mds;
  const docs = require("../src/docsearch");
  check("내 문서 검색 없음", !docs.status().installed && !docs.status().running && docs.launch() === null);
  fs.writeFileSync(path.join(mds, "mcp-launch.json"), JSON.stringify({ command: process.execPath, args: ["mcp-server.js"], env: { ELECTRON_RUN_AS_NODE: "1" } }));
  check("설치됨 (mcp-launch.json)", docs.status().installed && docs.launch().command === process.execPath);
  const seen = [];
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => { b += d; });
    req.on("end", () => {
      res.writeHead(req.headers["x-mds-token"] === "key123" ? 200 : 403, { "content-type": "application/json" });
      if (req.headers["x-mds-token"] !== "key123") return res.end(JSON.stringify({ error: "열쇠가 맞지 않습니다." }));
      const m = JSON.parse(b); seen.push(m);
      if (m.name === "run_routine") return res.end(JSON.stringify({ error: "이 앱의 설정에서 '외부 AI가 앱을 조작하도록 허용'이 꺼져 있습니다." }));
      res.end(JSON.stringify({ text: `${m.name} 했습니다` }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  fs.writeFileSync(path.join(mds, "control.json"), JSON.stringify({ port: server.address().port, token: "key123", pid: process.pid }));
  check("켜져 있음 (control.json)", docs.status().running);
  check("도구 맡기기", (await docs.call("list_collections", {}, "시험")) === "list_collections 했습니다" && seen[0].client === "시험");
  let err = ""; try { await docs.call("run_routine", {}); } catch (e) { err = e.message; }
  check("MyDocSearch가 거절하면 그 이유", /조작하도록 허용/.test(err), err);
  fs.writeFileSync(path.join(mds, "control.json"), JSON.stringify({ port: 1, token: "x", pid: 99999999 }));
  check("앱이 꺼졌으면(남은 control.json) 꺼짐으로", !docs.status().running);
  fs.writeFileSync(path.join(mds, "control.json"), JSON.stringify({ port: server.address().port, token: "key123", pid: process.pid }));

  // ---------- 봇 팀 (가짜 AI) ----------
  const calls = [];
  let launchSet = "";
  const ai = {
    setLaunch: (l) => { launchSet = l ? l.command : "없음"; },
    cancelRuns: () => {},
    runTask: (provider, prompt, opts) => new Promise((resolve) => {
      const who = (opts.system.match(/봇 “([^”]+)”/) || [])[1];
      calls.push({ who, provider, prompt, system: opts.system });
      const done = (text) => setTimeout(() => resolve({ ok: true, text, tools: [], model: "가짜", seconds: 0.1 }), 30);
      if (who === "팀장" && /팀원들의 결과/.test(prompt)) return done("최종\n```앱작업\n[{\"도구\": \"save_document\", \"인자\": {\"title\": \"t\", \"markdown\": \"m\"}}]\n```");
      if (who === "팀장") return done("나눕니다\n```팀작업\n[{\"봇\": \"조사\", \"일\": \"찾기\"}]\n```");
      if (who === "조사") return done("찾음\n```앱작업\n{\"도구\": \"delete_everything\", \"인자\": {}}\n```\n```앱작업\n{\"도구\": \"create_collection\", \"인자\": {\"name\": \"모음\"}}\n```");
      done("?");
    }),
  };
  const bots = require("../src/bots");
  const events = [];
  let off = false;
  bots.init({ db: db2, ai, docs, schedule: sch, workDir: () => tmp, isOff: (p) => off && p === "codex", emit: (ev) => events.push(ev), notify: () => {} });
  const lead = bots.saveBot({ name: "팀장", perm: "ask" }), josa = bots.saveBot({ name: "조사", perm: "auto", provider: "codex" });
  threw = false; try { bots.saveBot({ name: "팀장" }); } catch { threw = true; }
  check("같은 이름 봇은 안 됨", threw);
  const room = bots.saveRoom({ name: "팀", lead, members: [josa, lead] });
  check("팀장은 팀원 목록에서 빠짐", JSON.stringify(bots.rooms()[0].members) === JSON.stringify([josa]));
  bots.send(room, "견적 정리");
  await until(() => !bots.busy());
  const msgs = bots.messages(room);
  const acts = msgs.filter((m) => m.kind === "action");
  check("팀 흐름: 계획 → 맡은 일 → 최종", ["plan", "task", "sum"].every((s) => msgs.some((m) => m.data.step === s && m.status === "")), msgs.map((m) => m.data.step + ":" + m.status).join(","));
  check("봇에 문서 도구 지시 (MyDocSearch 있음)", calls.every((c) => /search_documents/.test(c.system)) && launchSet === process.execPath);
  check("없는 앱 작업은 무시", !acts.some((a) => a.data.tool === "delete_everything"));
  check("바로 바꿈: MyDocSearch에 맡김", acts.find((a) => a.bot_id === josa).status === "done" && seen.some((s) => s.name === "create_collection" && s.client === "MyCollaboratorBots · 조사"));
  const pend = acts.find((a) => a.bot_id === lead);
  check("물어보고 바꿈: 허용 카드", pend.status === "pending");
  await bots.act(pend.id);
  check("허용하면 함", bots.messages(room).find((m) => m.id === pend.id).status === "done" && seen.some((s) => s.name === "save_document"));
  check("화면에 바뀜 알림", events.some((e) => e.type === "bot" && e.room === room));

  off = true; calls.length = 0;
  bots.send(room, "다시");
  await until(() => !bots.busy());
  check("연결 끊은 AI의 봇은 일하지 않음", calls.every((c) => c.who !== "조사") && bots.messages(room).some((m) => m.bot_id === josa && m.status === "error" && /연결을 끊어/.test(m.text)));
  off = false;

  fs.rmSync(path.join(mds, "mcp-launch.json"));
  calls.length = 0;
  bots.saveRoom({ id: room, name: "팀", lead, members: [] });
  bots.send(room, "인사");
  await until(() => !bots.busy());
  check("MyDocSearch 없으면 문서 도구 없이 · 앱 작업 안내 없음", calls.length === 1 && /찾을 수 없습니다/.test(calls[0].system) && !/앱작업/.test(calls[0].system) && launchSet === "없음", calls[0] && calls[0].system.slice(0, 120));

  server.close();
  const fail = checks.filter((x) => !x).length;
  console.log(`\n${checks.length - fail}/${checks.length} 통과`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
