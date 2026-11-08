// 봇 팀: 여러 AI 봇을 팀으로 굴리는 대화방. 봇마다 이름·역할 지시·AI(Claude·ChatGPT(Codex)·Gemini)·모델·앱 작업 권한을 정한다.
//   팀(대화방)에 말하면 팀장 봇이 일을 나눠 팀원에게 맡기고(한 번에 최대 4개, 동시에), 결과를 모아 답한다.
//   내 문서 검색(MyDocSearch)이 설치돼 있으면 봇은 그 검색·읽기 도구만 쓴다 (ai.runTask, MDS_TOOLS=basic). 없으면 문서 도구 없이 답한다.
//   앱을 바꾸는 일(문서 저장·모음 담기·루틴 실행·OneDrive 보내기)은 봇이 답 끝에 ```앱작업``` 블록으로 요청하고, 봇의 권한에 따라:
//   off — 하지 않음, ask — 대화방에 허용/거절 카드, auto — 바로 한다. 실제로는 켜져 있는 MyDocSearch가 한다 (src/docsearch.js).
//   예약 작업: 팀마다 일정과 지시를 두면 그때 팀에 그 지시를 보낸다. 대화방은 한 번에 하나씩 돈다.
// (MyDocSearch의 MyDocBot을 따로 떼어 낸 것)

const now = () => Date.now() / 1000;
let ctx = null;          // { db, ai, docs, schedule, workDir, isOff, emit, notify }
const queue = [];
let running = null;      // { room, stop }

const PROVIDERS = ["claude", "codex", "gemini"];
const PERMS = ["off", "ask", "auto"];
// 봇이 요청할 수 있는 앱 작업 (MyDocSearch src/control.js의 도구). 지우기·이름 바꾸기·설정은 없다
const ACTIONS = {
  save_document: "문서 저장",
  create_collection: "모음 만들기",
  add_to_collection: "모음에 담기",
  run_routine: "루틴 실행",
  share_file: "OneDrive로 보내기",
};
const MAX_TASKS = 4;

function init(c) {
  ctx = c;
  // 앱이 꺼지는 바람에 끝나지 못한 일은 멈춤으로
  ctx.db.prepare("UPDATE bot_msgs SET status='stopped' WHERE status='working'").run();
}

// ---------- 봇 · 팀 ----------
const bot = (id) => ctx.db.prepare("SELECT * FROM bots WHERE id=?").get(id);
function bots() { return ctx.db.prepare("SELECT * FROM bots ORDER BY id").all(); }
function saveBot(b) {
  const name = String(b.name || "").trim().slice(0, 30);
  if (!name) throw new Error("봇 이름을 적으세요.");
  const dup = ctx.db.prepare("SELECT id FROM bots WHERE name=? AND id<>?").get(name, Number(b.id) || 0);
  if (dup) throw new Error(`“${name}” 봇이 이미 있습니다.`);
  const v = [name, String(b.role || "").slice(0, 4000), PROVIDERS.includes(b.provider) ? b.provider : "claude", String(b.model || "").slice(0, 60),
    PERMS.includes(b.perm) ? b.perm : "off", String(b.emoji || "🤖").slice(0, 4)];
  if (b.id) { ctx.db.prepare("UPDATE bots SET name=?, role=?, provider=?, model=?, perm=?, emoji=? WHERE id=?").run(...v, Number(b.id)); return Number(b.id); }
  return Number(ctx.db.prepare("INSERT INTO bots (name, role, provider, model, perm, emoji, created) VALUES (?, ?, ?, ?, ?, ?, ?)").run(...v, now()).lastInsertRowid);
}
function removeBot(id) {
  for (const r of rooms()) if (r.lead === Number(id) || r.members.includes(Number(id))) throw new Error(`“${r.name}” 팀에 들어 있습니다. 팀에서 먼저 빼세요.`);
  ctx.db.prepare("DELETE FROM bots WHERE id=?").run(Number(id));
}

const parseRoom = (r) => r && { ...r, members: JSON.parse(r.members || "[]"), schedule: JSON.parse(r.schedule || "{}") };
const room = (id) => parseRoom(ctx.db.prepare("SELECT * FROM bot_rooms WHERE id=?").get(id));
function rooms() {
  return ctx.db.prepare("SELECT * FROM bot_rooms ORDER BY id").all().map(parseRoom).map((r) => ({
    ...r, when: ctx.schedule.scheduleLabel(r.schedule), busy: !!(running && running.room === r.id) || queue.some((q) => q.room === r.id),
    last: ctx.db.prepare("SELECT ts, text FROM bot_msgs WHERE room_id=? AND kind='msg' ORDER BY id DESC LIMIT 1").get(r.id) || null,
  }));
}
function saveRoom(r) {
  const name = String(r.name || "").trim().slice(0, 40);
  if (!name) throw new Error("팀 이름을 적으세요.");
  const lead = Number(r.lead);
  if (!bot(lead)) throw new Error("팀장 봇을 고르세요.");
  const members = [...new Set((r.members || []).map(Number))].filter((id) => id !== lead && bot(id));
  const sched = r.schedule && typeof r.schedule === "object" ? r.schedule : { every: "manual" };
  const next = ["hourly", "daily", "weekly"].includes(sched.every) && String(r.sched_prompt || "").trim() ? ctx.schedule.nextRun(sched) : null;
  const v = [name, lead, JSON.stringify(members), JSON.stringify(sched), String(r.sched_prompt || "").slice(0, 4000), next];
  if (r.id) { ctx.db.prepare("UPDATE bot_rooms SET name=?, lead=?, members=?, schedule=?, sched_prompt=?, next_run=? WHERE id=?").run(...v, Number(r.id)); return Number(r.id); }
  return Number(ctx.db.prepare("INSERT INTO bot_rooms (name, lead, members, schedule, sched_prompt, next_run, created) VALUES (?, ?, ?, ?, ?, ?, ?)").run(...v, now()).lastInsertRowid);
}
function removeRoom(id) {
  if (running && running.room === Number(id)) throw new Error("일하는 중인 팀입니다. 멈춘 뒤 지우세요.");
  ctx.db.prepare("DELETE FROM bot_msgs WHERE room_id=?").run(Number(id));
  ctx.db.prepare("DELETE FROM bot_rooms WHERE id=?").run(Number(id));
}

// ---------- 대화 ----------
const parseMsg = (m) => ({ ...m, data: JSON.parse(m.data || "{}") });
function messages(roomId, limit = 200) {
  return ctx.db.prepare("SELECT * FROM (SELECT * FROM bot_msgs WHERE room_id=? ORDER BY id DESC LIMIT ?) ORDER BY id").all(Number(roomId), limit).map(parseMsg);
}
function addMsg(roomId, m) {
  const id = Number(ctx.db.prepare("INSERT INTO bot_msgs (room_id, ts, who, bot_id, kind, text, data, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(roomId, now(), m.who, m.bot_id || null, m.kind || "msg", m.text || "", JSON.stringify(m.data || {}), m.status || "").lastInsertRowid);
  changed(roomId);
  return id;
}
function setMsg(id, m) {
  const old = ctx.db.prepare("SELECT * FROM bot_msgs WHERE id=?").get(id);
  if (!old) return;
  ctx.db.prepare("UPDATE bot_msgs SET text=?, data=?, status=? WHERE id=?").run(m.text ?? old.text, m.data ? JSON.stringify(m.data) : old.data, m.status ?? old.status, id);
  changed(old.room_id);
}
const changed = (roomId) => { if (ctx.emit) ctx.emit({ type: "bot", room: roomId }); };
function clear(roomId) {
  if (running && running.room === Number(roomId)) throw new Error("일하는 중에는 비울 수 없습니다.");
  ctx.db.prepare("DELETE FROM bot_msgs WHERE room_id=?").run(Number(roomId));
  changed(Number(roomId));
}

// 사용자가 팀에 말함 (trigger: "사용자" | "일정")
function send(roomId, text, trigger = "사용자") {
  const r = room(roomId);
  if (!r) return { ok: false, message: "팀을 찾지 못했습니다." };
  text = String(text || "").trim();
  if (!text) return { ok: false, message: "할 말을 적으세요." };
  addMsg(r.id, { who: trigger === "일정" ? "system" : "user", text, data: { trigger } });
  queue.push({ room: r.id, text, trigger });
  pump();
  return { ok: true };
}
function stop(roomId) {
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].room === Number(roomId)) queue.splice(i, 1);
  if (running && running.room === Number(roomId)) { running.stopped = true; ctx.ai.cancelRuns(); }
  return { ok: true };
}
const busy = () => !!running || queue.length > 0;

async function pump() {
  if (running || !queue.length) return;
  const job = queue.shift();
  running = { room: job.room, stopped: false };
  try { await work(job); }
  catch (e) { addMsg(job.room, { who: "system", text: "⚠️ " + String(e && e.message || e) }); }
  finally { running = null; changed(job.room); setImmediate(pump); }
}

// 최근 대화 (봇에게 넘길 맥락)
function history(roomId, beforeId) {
  const rows = ctx.db.prepare("SELECT who, bot_id, text FROM bot_msgs WHERE room_id=? AND id<? AND kind='msg' AND status<>'working' ORDER BY id DESC LIMIT 10")
    .all(roomId, beforeId).reverse();
  const names = Object.fromEntries(bots().map((b) => [b.id, b.name]));
  return rows.map((m) => `${m.who === "user" ? "사용자" : m.who === "system" ? "예약 작업" : names[m.bot_id] || "봇"}: ${m.text.slice(0, 1500)}`).join("\n");
}

const NO_DOCS_RULE = "내 문서 검색(MyDocSearch)이 이 PC에 없어 사용자의 문서는 찾을 수 없습니다. 알고 있는 지식으로 답하고, 문서가 필요하면 그렇다고 말하세요.";
const DOCS_RULE = "내 문서 검색 도구(search_documents·read_document)로 사용자의 PC 문서를 찾아 읽고 답하세요. 근거는 문장 바로 뒤에 [파일명 · 쪽](doc:문서ID#c조각번호)로 밝히고, 문서에 없는 내용은 지어내지 마세요.";
function actionRule(b) {
  if (!ctx.docs.launch()) return "";
  if (b.perm === "off") return "앱을 바꾸는 작업(문서 저장·모음 담기 등)은 할 수 없습니다. 필요하면 사용자에게 직접 하라고 말하세요.";
  return "앱 작업이 필요하면 답 맨 끝에 다음 형식의 블록을 덧붙이세요 (여러 개는 배열로). " +
    (b.perm === "ask" ? "사용자가 허용해야 실행됩니다.\n" : "바로 실행됩니다.\n") +
    "```앱작업\n[{\"도구\": \"save_document\", \"인자\": {\"title\": \"제목\", \"markdown\": \"# 본문\", \"format\": \"docx\"}}]\n```\n" +
    "쓸 수 있는 도구: save_document(title, markdown, format: docx|md, collection) · create_collection(name, ids) · add_to_collection(collection, ids) · " +
    "run_routine(routine) · share_file(id). 지우기·이름 바꾸기·설정 바꾸기는 없습니다.";
}
function system(b, extra = "") {
  return [`당신은 사용자의 AI 봇 팀에 속한 봇 “${b.name}”입니다.`, b.role ? `역할: ${b.role}` : "", ctx.docs.launch() ? DOCS_RULE : NO_DOCS_RULE, actionRule(b), extra].filter(Boolean).join("\n\n");
}

const run = async (b, prompt, sys, onEvent) => {
  if (ctx.isOff && ctx.isOff(b.provider)) return { ok: false, text: "", tools: [], error: `${b.name} 봇의 AI 연결을 끊어 두었습니다. 설정 → AI 연결에서 다시 연결하세요.` };
  ctx.ai.setLaunch(ctx.docs.launch());          // MyDocSearch를 새로 깔았거나 옮겼어도 바로 따라간다
  return ctx.ai.runTask(b.provider, prompt, { workDir: ctx.workDir(), model: b.model, system: sys, onEvent, timeoutMs: 15 * 60 * 1000 });
};

// 답에서 블록 꺼내기: ```팀작업 [...]``` · ```앱작업 [...]```
function takeBlock(text, tag) {
  const re = new RegExp("```\\s*" + tag + "\\s*\\n([\\s\\S]*?)```", "g");
  let items = [];
  const rest = String(text || "").replace(re, (_m, body) => {
    try { const v = JSON.parse(body.trim()); items = items.concat(Array.isArray(v) ? v : [v]); } catch { /* 형식이 틀림 — 무시 */ }
    return "";
  }).trim();
  return { rest, items };
}

async function work(job) {
  const r = room(job.room);
  if (!r) return;
  const lead = bot(r.lead);
  if (!lead) throw new Error("팀장 봇이 없습니다. 팀 설정을 확인하세요.");
  const team = r.members.map(bot).filter(Boolean);
  const userMsgId = ctx.db.prepare("SELECT MAX(id) AS id FROM bot_msgs WHERE room_id=?").get(r.id).id;
  const past = history(r.id, userMsgId);
  const scheduled = job.trigger === "일정";
  const roster = team.map((b) => `- ${b.name}: ${b.role || "(역할 없음)"}`).join("\n");

  // 1) 팀장: 직접 답하거나 일을 나눈다
  const planId = addMsg(r.id, { who: "bot", bot_id: lead.id, text: "", status: "working", data: { step: "plan" } });
  const planSys = system(lead, team.length ? "당신은 이 팀의 팀장입니다. 팀원:\n" + roster + "\n\n" +
    "팀원에게 맡기면 좋은 일이면 나눠 맡기세요. 그때는 짧게 계획을 말하고 답 끝에 다음 블록을 붙이세요 (팀원 이름은 위 목록 그대로, 최대 " + MAX_TASKS + "개):\n" +
    "```팀작업\n[{\"봇\": \"팀원 이름\", \"일\": \"맡길 일 (그 팀원이 혼자 할 수 있게 구체적으로)\"}]\n```\n" +
    "간단한 일이면 나누지 말고 바로 답하세요." : "팀원이 없으니 직접 답하세요.");
  const planPrompt = `${past ? `지금까지의 대화:\n${past}\n\n` : ""}${scheduled ? "예약 작업" : "사용자"}의 요청: ${job.text}`;
  const plan = await run(lead, planPrompt, planSys, progress(planId));
  if (running.stopped) return setMsg(planId, { status: "stopped", text: "멈췄습니다." });
  if (!plan.ok) return setMsg(planId, { status: "error", text: "⚠️ " + (plan.error || "답을 받지 못했습니다.") });
  const { rest: planText, items: tasks } = takeBlock(plan.text, "팀작업");
  const byName = (n) => team.find((b) => b.name === String(n || "").trim()) || team.find((b) => String(n || "").includes(b.name));
  const assigned = tasks.map((t) => ({ b: byName(t.봇 || t.bot), task: String(t.일 || t.task || "").trim() })).filter((t) => t.b && t.task).slice(0, MAX_TASKS);

  if (!assigned.length) {
    await finish(planId, lead, plan, planText, scheduled);
    return;
  }
  setMsg(planId, { status: "", text: planText || "팀원에게 나눠 맡깁니다.", data: { step: "plan", model: plan.model, tools: plan.tools.length } });

  // 2) 팀원들이 동시에
  const results = await Promise.all(assigned.map(async ({ b, task }) => {
    const id = addMsg(r.id, { who: "bot", bot_id: b.id, kind: "msg", text: "", status: "working", data: { step: "task", task, from: lead.name } });
    const res = await run(b, `팀장 “${lead.name}”이 맡긴 일: ${task}\n\n(사용자의 원래 요청: ${job.text})`, system(b), progress(id));
    if (running.stopped) { setMsg(id, { status: "stopped", text: "멈췄습니다." }); return null; }
    if (!res.ok) { setMsg(id, { status: "error", text: "⚠️ " + (res.error || "답을 받지 못했습니다.") }); return { b, task, text: `(실패: ${res.error || "답 없음"})` }; }
    const text = await finish(id, b, res, null, scheduled, { step: "task", task, from: lead.name });
    return { b, task, text };
  }));
  if (running.stopped) return;

  // 3) 팀장이 모아서 답
  const sumId = addMsg(r.id, { who: "bot", bot_id: lead.id, text: "", status: "working", data: { step: "sum" } });
  const report = results.filter(Boolean).map((x) => `## ${x.b.name} — ${x.task}\n${x.text.slice(0, 12000)}`).join("\n\n");
  const sum = await run(lead, `${scheduled ? "예약 작업" : "사용자"}의 요청: ${job.text}\n\n팀원들의 결과:\n\n${report}\n\n` +
    "팀원 결과를 바탕으로 사용자에게 줄 최종 답을 쓰세요. 팀원이 밝힌 근거 링크는 그대로 살리고, 서로 다른 내용은 짚어 주세요.",
    system(lead, "당신은 이 팀의 팀장입니다. 이번에는 팀원 결과를 모아 최종 답을 씁니다 (더 나눠 맡기지 마세요)."), progress(sumId));
  if (running.stopped) return setMsg(sumId, { status: "stopped", text: "멈췄습니다." });
  if (!sum.ok) return setMsg(sumId, { status: "error", text: "⚠️ " + (sum.error || "답을 받지 못했습니다.") });
  await finish(sumId, lead, sum, null, scheduled, { step: "sum" });
  if (scheduled && ctx.notify) ctx.notify(`MyCollaboratorBots · ${r.name}`, "예약 작업을 마쳤습니다.");
}

// 진행 표시: 쓰는 중인 글과 부른 도구
function progress(id) {
  let text = "", tools = 0, last = 0;
  return (ev) => {
    if (ev.type === "delta") text += ev.text;
    else if (ev.type === "reset") text = "";
    else if (ev.type === "tool") tools++;
    else return;
    if (Date.now() - last < 400) return;
    last = Date.now();
    setMsg(id, { text: text.slice(-4000), data: { tools } });
  };
}

// 봇의 답을 대화방에 남기고, 앱작업 블록을 권한대로 처리한다. 앱작업을 뺀 글을 돌려준다
async function finish(id, b, res, text, scheduled, data = {}) {
  const { rest, items } = takeBlock(text ?? res.text, "앱작업");
  setMsg(id, { status: "", text: rest || "(빈 답)", data: { ...data, model: res.model, tools: res.tools.length, seconds: res.seconds } });
  const roomId = ctx.db.prepare("SELECT room_id FROM bot_msgs WHERE id=?").get(id).room_id;
  for (const it of items) {
    const tool = String(it.도구 || it.tool || ""), args = it.인자 || it.args || {};
    if (!ACTIONS[tool]) continue;
    const card = { who: "bot", bot_id: b.id, kind: "action", text: describe(tool, args), data: { tool, args } };
    if (b.perm === "off") addMsg(roomId, { ...card, status: "blocked" });
    else if (b.perm === "auto") {
      const aid = addMsg(roomId, { ...card, status: "running" });
      await act(aid);
    } else addMsg(roomId, { ...card, status: "pending" });
  }
  return rest;
}
function describe(tool, a) {
  const what = ACTIONS[tool];
  if (tool === "save_document") return `${what}: “${a.title || "새 문서"}” (${a.format === "md" ? "마크다운" : "워드"}${a.collection ? ` · 모음 ${a.collection}` : ""})`;
  if (tool === "create_collection") return `${what}: “${a.name || ""}”${(a.ids || []).length ? ` · 문서 ${(a.ids || []).length}개` : ""}`;
  if (tool === "add_to_collection") return `${what}: “${a.collection || ""}”에 문서 ${(a.ids || []).length}개`;
  if (tool === "run_routine") return `${what}: “${a.routine || ""}”`;
  if (tool === "share_file") return `${what}: 문서 ID ${a.id || ""}`;
  return what;
}

// 앱 작업 실행 (허용 카드에서 허용 · 권한이 auto) — 켜져 있는 MyDocSearch에 맡긴다. MyDocSearch의 '외부 AI가 앱을 조작하도록 허용'도 켜져 있어야 한다
async function act(msgId) {
  const m = ctx.db.prepare("SELECT * FROM bot_msgs WHERE id=? AND kind='action'").get(Number(msgId));
  if (!m) return { ok: false, message: "작업을 찾지 못했습니다." };
  if (!["pending", "running"].includes(m.status)) return { ok: false, message: "이미 처리한 작업입니다." };
  const { tool, args } = JSON.parse(m.data || "{}");
  if (!ACTIONS[tool]) return { ok: false, message: "할 수 없는 작업입니다." };
  const b = bot(m.bot_id);
  setMsg(m.id, { status: "running" });
  try {
    const out = await ctx.docs.call(tool, args, `MyCollaboratorBots · ${b ? b.name : "봇"}`);
    setMsg(m.id, { status: "done", data: { tool, args, result: out } });
    return { ok: true, message: out };
  } catch (e) {
    setMsg(m.id, { status: "failed", data: { tool, args, result: String(e && e.message || e) } });
    return { ok: false, message: String(e && e.message || e) };
  }
}
function deny(msgId) {
  const m = ctx.db.prepare("SELECT * FROM bot_msgs WHERE id=? AND kind='action' AND status='pending'").get(Number(msgId));
  if (!m) return { ok: false };
  setMsg(m.id, { status: "denied" });
  return { ok: true };
}

// ---------- 예약 작업 ----------
function due() {
  const t = now();
  for (const r of ctx.db.prepare("SELECT id, schedule, sched_prompt FROM bot_rooms WHERE next_run IS NOT NULL AND next_run <= ?").all(t)) {
    ctx.db.prepare("UPDATE bot_rooms SET next_run=? WHERE id=?").run(ctx.schedule.nextRun(JSON.parse(r.schedule || "{}")), r.id);
    if (r.sched_prompt.trim()) send(r.id, r.sched_prompt, "일정");
  }
}
function startLoop() { due(); setInterval(due, 30 * 1000).unref(); }

module.exports = { init, bots, saveBot, removeBot, rooms, saveRoom, removeRoom, messages, send, stop, clear, act, deny, due, startLoop, busy, takeBlock, ACTIONS };
