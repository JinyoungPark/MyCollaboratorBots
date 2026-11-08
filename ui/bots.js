// 봇 팀 화면 (src/bots.js): 왼쪽 팀(대화방) 목록 · 오른쪽 대화. 팀장 봇이 일을 나눠 팀원에게 맡기고 결과를 모아 답한다.
//   봇 관리(이름·역할·AI·모델·앱 작업 권한) · 팀 만들기(팀장·팀원·예약 작업) · 허용/거절 카드 · 답을 문서로 저장
// index.html의 $, api, esc, toast, md, openSettings 를 함께 쓴다.

const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
const PROV_LABEL = { claude: "Claude", codex: "ChatGPT(Codex)", gemini: "Gemini" };
const when = (t) => (t ? new Date(t * 1000).toLocaleString("ko-KR", { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }) : "");
const bt = { bots: [], rooms: [], actions: {}, docs: {}, room: null, msgs: [] };
const PERM_LABEL = { off: "보기만", ask: "물어보고 바꿈", auto: "바로 바꿈" };
const PERM_HELP = {
  off: "문서를 찾고 읽고 답만 합니다. 앱은 바꾸지 않습니다.",
  ask: "문서 저장·모음 담기·루틴 실행·OneDrive 보내기를 하려 하면 대화방에 허용/거절 카드가 뜹니다. 예약 작업 중에도 내가 허용할 때까지 기다립니다. (내 문서 검색이 켜져 있고, 그 설정의 ‘외부 AI가 앱을 조작하도록 허용’도 켜져 있어야 합니다)",
  auto: "확인 없이 바로 합니다 (예약 작업 중에도). 믿을 수 있는 일만 맡기세요. 지우기·이름 바꾸기·설정 바꾸기는 어느 권한으로도 못 합니다.",
};
const BOT_MODEL = { claude: "sonnet", codex: "", gemini: "flash" };
// 처음 쓸 때 만들 예시 팀
const SAMPLE = [
  { emoji: "🧭", name: "팀장", role: "요청을 이해하고 팀원에게 일을 나눠 맡긴 뒤, 결과를 모아 한눈에 보이게 정리합니다.", perm: "ask" },
  { emoji: "🔎", name: "조사", role: "관련 문서를 여러 표현(동의어·영문·약어)으로 넓게 찾아, 사실·숫자·날짜를 근거와 함께 뽑습니다.", perm: "off" },
  { emoji: "📝", name: "정리", role: "찾은 내용을 보고서 형식(요약 · 본문 · 할 일)으로 짧고 분명하게 씁니다.", perm: "off" },
  { emoji: "🧐", name: "검토", role: "문서끼리 다른 숫자·날짜·조건, 근거 없는 주장, 빠진 내용을 찾아 짚습니다.", perm: "off" },
];
const STEP = { plan: "계획", task: "맡은 일", review: "검토", sum: "최종 결과" };
const STATE_IC = { working: "⏳", "": "✅", error: "⚠️", stopped: "⏹" };
// 메시지를 쓴 봇 (팀장이 이번 일에만 만든 임시 팀원은 data.temp)
const whoOf = (m) => m.data.temp || botOf(m.bot_id) || { emoji: "🤖", name: "봇" };
const stepLabel = (m) => m.data.step === "task" ? `${m.data.round > 1 ? m.data.round + "차 " : ""}맡은 일` : m.data.step === "review" ? `${m.data.round}차 결과 검토` : STEP[m.data.step] || "";
const dur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`; };
const ACT_STATE = { pending: ["❓", "허용을 기다림"], running: ["⏳", "하는 중"], done: ["✅", "했습니다"], failed: ["⚠️", "실패"], denied: ["🚫", "거절함"], blocked: ["🔒", "권한 없음 (보기만)"] };

async function renderBots(keepRoom) {
  const r = await api("/api/bots");
  Object.assign(bt, r);
  if (!keepRoom || !bt.rooms.some((x) => x.id === bt.room)) bt.room = (bt.rooms.find((x) => x.id === bt.room) || bt.rooms[0] || {}).id || null;
  const box = $("botBody");
  renderDocsChip();
  if (!bt.bots.length) {
    box.innerHTML = `<div class="bot-empty"><h2>🤖 MyCollaboratorBots</h2>
      <p>일을 던지면 <b>팀장 봇</b>이 알아서 나눠 맡기고(필요하면 임시 팀원도 만들어), 결과를 검토해 부족하면 다시 맡긴 뒤 최종 결과를 냅니다.
      나는 오른쪽 <b>진행 상황</b>에서 지켜보다가, 결과를 <b>승인</b>하거나 <b>수정 요청</b>만 하면 됩니다.
      봇은 내 문서를 찾고 읽어 근거와 함께 답하고, 허용한 봇만 문서 저장·모음 담기 같은 앱 작업을 합니다.</p>
      <div class="bot-sample">${SAMPLE.map((b) => `<span>${b.emoji} <b>${esc(b.name)}</b> ${esc(b.role)}</span>`).join("")}</div>
      <div class="rt-bar"><button class="primary" id="botSample">예시 팀 만들기 (팀장·조사·정리·검토)</button><button class="ghost" id="botNew0">봇 직접 만들기</button></div>
      <p class="help">AI는 설정 → AI 연결에 로그인한 Claude·ChatGPT·Gemini를 씁니다. 봇마다 다른 AI·모델을 고를 수 있습니다.</p>${docsNote()}</div>`;
    $("botSample").onclick = makeSample;
    $("botNew0").onclick = () => botDialog({});
    return;
  }
  box.innerHTML = `<div class="bot-wrap">
    <aside class="bot-side">
      <div class="bot-side-h"><b>팀</b><button class="nav-add" id="roomNew" title="새 팀">＋</button></div>
      <div id="roomList">${bt.rooms.map(roomItem).join("") || `<p class="help">팀이 없습니다. ＋로 만드세요.</p>`}</div>
      <div class="bot-side-h"><b>봇</b><button class="nav-add" id="botNew" title="새 봇">＋</button></div>
      <div id="botList">${bt.bots.map((b) => `<button class="bot-it" data-bot="${b.id}">${esc(b.emoji)} ${esc(b.name)}<small>${esc(PROV_LABEL[b.provider] || b.provider)} · ${PERM_LABEL[b.perm]}</small></button>`).join("")}</div>
    </aside>
    <section class="bot-chat" id="botChat"></section></div>`;
  $("roomNew").onclick = () => roomDialog({});
  $("botNew").onclick = () => botDialog({});
  box.querySelectorAll("[data-room]").forEach((el) => el.onclick = () => { bt.room = +el.dataset.room; renderBots(true); });
  box.querySelectorAll("[data-bot]").forEach((el) => el.onclick = () => botDialog(bt.bots.find((b) => b.id === +el.dataset.bot)));
  await renderRoom();
}
const botOf = (id) => bt.bots.find((b) => b.id === id);
function roomItem(r) {
  const team = [r.lead, ...r.members].map(botOf).filter(Boolean);
  return `<button class="room-it ${r.id === bt.room ? "on" : ""}" data-room="${r.id}"><span class="nm">${esc(r.name)}${r.busy ? ` <span class="rt-chip run">일하는 중</span>` : ""}</span>
    <small>${team.map((b) => esc(b.emoji)).join(" ")}${r.sched_prompt && r.schedule.every !== "manual" ? ` · ⏰ ${esc(r.when)}` : ""}</small></button>`;
}

async function renderRoom() {
  const chat = $("botChat");
  if (!chat) return;
  const r = bt.rooms.find((x) => x.id === bt.room);
  if (!r) { chat.innerHTML = `<div class="bot-empty"><p>팀을 만들면 여기서 대화합니다.</p><button class="primary" id="roomNew2">새 팀 만들기</button></div>`; $("roomNew2").onclick = () => roomDialog({}); return; }
  const { messages, room } = await api("/api/bots/room", { id: r.id });
  bt.msgs = messages;
  const lead = botOf(r.lead);
  const scrolled = $("botMsgs") && $("botMsgs").scrollHeight - $("botMsgs").scrollTop - $("botMsgs").clientHeight < 40;
  const draft = $("botInput") ? $("botInput").value : "";
  chat.innerHTML = `<div class="bot-chat-h"><div class="grow"><b>${esc(r.name)}</b>
      <small>팀장 ${lead ? `${esc(lead.emoji)} ${esc(lead.name)}` : "-"} · 팀원 ${r.members.map(botOf).filter(Boolean).map((b) => `${esc(b.emoji)} ${esc(b.name)}`).join(", ") || "없음"}${r.sched_prompt && r.schedule.every !== "manual" ? ` · ⏰ ${esc(r.when)}${r.next_run ? ` (다음 ${when(r.next_run)})` : ""}` : ""}</small></div>
      <button class="ghost" id="roomEdit">팀 설정</button><button class="ghost" id="roomClear" title="대화 기록 지우기">비우기</button></div>
    <div class="bot-body"><div class="bot-conv">
    <div class="bot-msgs" id="botMsgs">${messages.map(msgHtml).join("") || `<p class="help bot-hint">일을 던지면 팀장이 알아서 나눠 맡기고 진행합니다.<br>예: “이번 달 들어온 견적서를 비교해서 표로 정리하고, 문서로 저장해 줘”</p>`}</div>
    <div class="bot-compose"><textarea id="botInput" rows="2" placeholder="팀에게 맡길 일 (Enter 보내기 · Shift+Enter 줄바꿈)${room && room.busy ? " — 일하는 중에 보내면 끝난 뒤 이어서 합니다" : ""}"></textarea>
      <button class="primary" id="botSend">보내기</button></div></div>
    <aside class="bot-mon" id="botMon">${monitorHtml(messages, room)}</aside></div>`;
  $("botInput").value = draft;
  const list = $("botMsgs");
  if (scrolled !== false) list.scrollTop = list.scrollHeight;
  $("roomEdit").onclick = () => roomDialog(r);
  $("roomClear").onclick = async () => { if (!confirm("이 팀의 대화 기록을 모두 지울까요?")) return; const x = await api("/api/bots/clear", { id: r.id }); if (!x.ok) alert(x.message); renderRoom(); };
  const send = async () => {
    const text = $("botInput").value.trim();
    if (!text) return;
    const x = await api("/api/bots/send", { id: r.id, text });
    if (!x.ok) return alert(x.message);
    $("botInput").value = "";
    renderBots(true);
  };
  $("botSend").onclick = send;
  if ($("botStop")) $("botStop").onclick = () => { if (confirm("지금 하는 일을 멈출까요? (기다리는 일도 함께 취소)")) api("/api/bots/stop", { id: r.id }); };
  // 결과 판단: 승인 · 수정 요청
  chat.querySelectorAll("[data-approve]").forEach((b) => b.onclick = async () => {
    const x = await api("/api/bots/decide", { msg: +b.dataset.approve, verdict: "approve" });
    if (!x.ok) alert(x.message); else toast("승인했습니다.");
  });
  chat.querySelectorAll("[data-revise]").forEach((b) => b.onclick = async () => {
    const note = prompt("무엇을 고칠까요? 팀장이 이 의견대로 다시 진행합니다.");
    if (!note || !note.trim()) return;
    const x = await api("/api/bots/decide", { msg: +b.dataset.revise, verdict: "revise", note });
    if (!x.ok) alert(x.message); else renderBots(true);
  });
  chat.querySelectorAll("[data-goto]").forEach((el) => el.onclick = () => {
    const t = list.querySelector(`[data-mid="${el.dataset.goto}"]`);
    if (t) { t.scrollIntoView({ behavior: "smooth", block: "center" }); t.classList.add("flash"); setTimeout(() => t.classList.remove("flash"), 1200); }
  });
  $("botInput").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } };
  chat.querySelectorAll("[data-allow]").forEach((b) => b.onclick = async () => {
    b.disabled = true;
    const x = await api("/api/bots/act", { msg: +b.dataset.allow, allow: b.dataset.v === "1" });
    if (x && x.ok === false && x.message) alert(x.message);
  });
  list.querySelectorAll("[data-save]").forEach((b) => b.onclick = () => saveAsDoc(+b.dataset.save));
  // 근거 링크는 내 문서 검색(MyDocSearch)의 뷰어에서 그 위치로 연다
  list.querySelectorAll("a.doc").forEach((a) => a.onclick = async (e) => {
    e.preventDefault();
    const x = await api("/api/docs/open", { id: +a.dataset.doc, chunk: a.dataset.chunk ? +a.dataset.chunk : null });
    if (!x.ok) alert(x.message); else toast("내 문서 검색에서 열었습니다.");
  });
}

function msgHtml(m) {
  if (m.who === "user") return `<div class="bmsg me"><div class="bub">${esc(m.text).replace(/\n/g, "<br>")}</div></div>`;
  if (m.who === "system") return `<div class="bmsg sys"><div class="bub">${m.data.trigger === "일정" ? "⏰ 예약 작업: " : ""}${esc(m.text)}</div></div>`;
  const b = whoOf(m);
  if (m.kind === "action") {
    const [ic, st] = ACT_STATE[m.status] || ["", m.status];
    return `<div class="bmsg act ${m.status}" data-mid="${m.id}"><div class="bub"><div class="who">${esc(b.emoji)} ${esc(b.name)} · 앱 작업</div>
      <div>${ic} ${esc(m.text)} <span class="rt-chip">${st}</span></div>
      ${m.status === "pending" ? `<div class="btns"><button class="primary" data-allow="${m.id}" data-v="1">허용</button><button class="ghost" data-allow="${m.id}" data-v="">거절</button></div>` : ""}
      ${m.data.result ? `<small>${esc(String(m.data.result).slice(0, 400))}</small>` : ""}</div></div>`;
  }
  const working = m.status === "working";
  const meta = [m.data.model, m.data.tools ? `도구 ${m.data.tools}번` : "", m.data.seconds ? `${Math.round(m.data.seconds)}초` : ""].filter(Boolean).join(" · ");
  return `<div class="bmsg bot ${m.data.step || ""} ${m.status}${m.data.final ? " final" : ""}" data-mid="${m.id}"><div class="bub">
    <div class="who">${esc(b.emoji)} ${esc(b.name)}${m.data.temp ? ` <span class="rt-chip" title="${esc(m.data.temp.role)}">임시 팀원</span>` : ""}${m.data.step ? ` · ${stepLabel(m)}` : ""}${working ? ` <span class="rt-chip run">${m.data.tools ? `문서 찾는 중 (${m.data.tools})` : "생각하는 중"}</span>` : ""}</div>
    ${m.data.task ? `<div class="task">📌 ${esc(m.data.from || "")}: ${esc(m.data.task)}</div>` : ""}
    <div class="md">${m.text ? md(m.text) : working ? "…" : ""}</div>
    ${!working && m.text && m.status !== "error" && m.status !== "stopped" ? `<div class="foot"><small>${esc(meta)}</small><button class="link" data-save="${m.id}">문서로 저장</button></div>` : ""}
    ${m.data.final && m.status === "" ? reviewBar(m) : ""}</div></div>`;
}
// 최종 결과의 판단 줄
function reviewBar(m) {
  if (m.data.review === "approved") return `<div class="review done">✅ 승인함 <small>${when(m.data.decided / 1000)}</small></div>`;
  if (m.data.review === "revise") return `<div class="review done">✍️ 수정 요청함: ${esc(m.data.note || "")}</div>`;
  return `<div class="review"><span>판단해 주세요</span><button class="primary" data-approve="${m.id}">✅ 승인</button><button class="ghost" data-revise="${m.id}">✍️ 수정 요청</button></div>`;
}

// ---------- 진행 상황 (오른쪽): 가장 최근 일의 단계 · 작업마다 상태 · 시간 · 지금 보는 것 ----------
function monitorHtml(messages, room) {
  const jobId = Math.max(0, ...messages.filter((m) => m.data.job).map((m) => m.data.job));
  const busy = !!(room && room.busy);
  if (!jobId) return `<div class="mon-h"><b>진행 상황</b></div><p class="help">일을 던지면 팀장이 나눈 작업과 진행 과정이 여기에 보입니다.</p>`;
  const ask = messages.find((m) => m.id === jobId);
  const steps = messages.filter((m) => m.data.job === jobId && m.kind === "msg");
  const acts = messages.filter((m) => m.data.job === jobId && m.kind === "action");
  const fin = steps.find((m) => m.data.final);
  const working = steps.some((m) => m.status === "working");
  const state = working ? ["run", "진행 중"] : fin && fin.data.review === "wait" ? ["wait", "판단 기다림"] : fin && fin.data.review === "approved" ? ["ok", "승인함"]
    : fin && fin.data.review === "revise" ? ["ok", "수정 요청함"] : steps.some((m) => m.status === "stopped") ? ["stop", "멈춤"] : steps.some((m) => m.status === "error") ? ["err", "문제 있음"] : ["ok", "끝"];
  const t0 = ask ? ask.ts * 1000 : (steps[0] || {}).data?.started || Date.now();
  const tEnd = working ? null : Math.max(...steps.map((m) => m.data.ended || 0)) || null;
  const pending = acts.filter((a) => a.status === "pending").length;
  const item = (m) => {
    const b = whoOf(m), w = m.status === "working";
    const time = m.data.started ? (w ? `<span data-since="${m.data.started}">${dur(Date.now() - m.data.started)}</span>` : m.data.ended ? dur(m.data.ended - m.data.started) : "") : "";
    return `<div class="mon-it ${w ? "run" : m.status || "ok"} ${m.data.step === "task" ? "task" : "lead"}" data-goto="${m.id}" title="대화에서 보기">
      <div class="mon-top"><span>${STATE_IC[m.status] ?? "✅"}</span><b>${esc(b.emoji)} ${esc(b.name)}</b><span class="mon-step">${esc(stepLabel(m))}</span><span class="grow"></span><small>${time}</small></div>
      ${m.data.task ? `<div class="mon-task">${esc(m.data.task)}</div>` : ""}
      ${w ? `<div class="mon-now">${m.data.lastTool ? `🔎 ${esc(m.data.lastTool)}` : "생각하는 중…"}${m.data.tools ? ` · 도구 ${m.data.tools}번` : ""}</div>`
        : m.data.assigned ? `<div class="mon-now">→ ${m.data.assigned}개 작업을 맡김</div>` : m.data.tools ? `<div class="mon-now">도구 ${m.data.tools}번${m.data.model ? ` · ${esc(m.data.model)}` : ""}</div>` : ""}</div>`;
  };
  return `<div class="mon-h"><b>진행 상황</b><span class="mon-state ${state[0]}">${state[1]}</span></div>
    <div class="mon-ask">${esc((ask ? ask.text : "").slice(0, 160))}</div>
    <div class="mon-meta">⏱ ${tEnd ? dur(tEnd - t0) : `<span data-since="${t0}">${dur(Date.now() - t0)}</span>`} · 작업 ${steps.filter((m) => m.data.step === "task").length}개${pending ? ` · <b class="warn">허용 기다림 ${pending}건</b>` : ""}</div>
    <div class="mon-list">${steps.map(item).join("")}</div>
    ${busy ? `<button class="ghost mon-stop" id="botStop">⏹ 멈추기</button>` : ""}
    ${fin && fin.data.review === "wait" ? `<div class="mon-judge"><button class="primary" data-approve="${fin.id}">✅ 승인</button><button class="ghost" data-revise="${fin.id}">✍️ 수정 요청</button></div>` : ""}`;
}
// 일하는 동안 걸린 시간을 1초마다
setInterval(() => document.querySelectorAll("#botMon [data-since]").forEach((el) => { el.textContent = dur(Date.now() - +el.dataset.since); }), 1000);

async function saveAsDoc(id) {
  const m = bt.msgs.find((x) => x.id === id);
  if (!m) return;
  const r = bt.rooms.find((x) => x.id === bt.room);
  const title = prompt("저장할 문서 이름", `${r ? r.name : "봇 답"} ${new Date().toLocaleDateString("ko-KR")}`);
  if (title === null) return;
  const x = await api("/api/export-docx", { markdown: m.text, title, format: "docx" });
  if (!x.ok) return alert(x.message || "저장하지 못했습니다.");
  toast(`저장했습니다: ${x.path.split(/[\\/]/).pop()} (문서/MyCollaboratorBots)`, () => api("/api/show-file", { path: x.path }));
}

async function makeSample() {
  const ids = [];
  for (const b of SAMPLE) {
    const x = await api("/api/bots/save", { ...b, provider: "claude", model: BOT_MODEL.claude });
    if (!x.ok) return alert(x.message);
    ids.push(x.id);
  }
  const x = await api("/api/bots/room/save", { name: "문서 팀", lead: ids[0], members: ids.slice(1), schedule: { every: "manual" } });
  if (!x.ok) return alert(x.message);
  bt.room = x.id;
  toast("예시 팀을 만들었습니다. 봇을 누르면 AI·모델·권한을 바꿀 수 있습니다.");
  renderBots(true);
}

// ---------- 봇 만들기·고치기 ----------
async function botDialog(b) {
  const isNew = !b.id;
  b = { emoji: "🤖", provider: "claude", model: BOT_MODEL.claude, perm: "off", ...b };
  let dlg = $("botDlg");
  if (!dlg) { dlg = document.createElement("dialog"); dlg.id = "botDlg"; dlg.className = "ask-dlg"; document.body.appendChild(dlg); }
  dlg.innerHTML = `<form method="dialog"><div class="dlg-head">${isNew ? "새 봇" : "봇 고치기"}</div><div class="dlg-body">
    <div class="fld-row"><label class="fld" style="max-width:80px">아이콘<input id="bEmoji" value="${esc(b.emoji)}" maxlength="4"></label>
      <label class="fld">이름<input id="bName" value="${esc(b.name || "")}" placeholder="예: 조사"></label></div>
    <label class="fld">역할 (이 봇에게 주는 지시)<textarea id="bRole" rows="4" placeholder="예: 관련 문서를 넓게 찾아 사실·숫자를 근거와 함께 뽑습니다.">${esc(b.role || "")}</textarea></label>
    <div class="fld-row"><label class="fld">AI<select id="bProv">${["claude", "codex", "gemini"].map((p) => `<option value="${p}" ${b.provider === p ? "selected" : ""}>${PROV_LABEL[p]}</option>`).join("")}</select></label>
      <label class="fld">모델<select id="bModel"></select></label></div>
    <label class="fld">앱 작업 권한<select id="bPerm">${Object.entries(PERM_LABEL).map(([k, l]) => `<option value="${k}" ${b.perm === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    <p class="help" id="bPermHelp"></p>
    </div><div class="dlg-foot">${isNew ? "" : `<button class="ghost" value="del" type="submit">지우기</button>`}<span class="grow"></span><button class="ghost" value="cancel" type="submit">취소</button><button class="primary" value="ok" type="submit">${isNew ? "만들기" : "저장"}</button></div></form>`;
  const ph = () => { $("bPermHelp").textContent = PERM_HELP[$("bPerm").value]; };
  $("bPerm").onchange = ph; ph();
  const loadModels = async (keep) => {
    const prov = $("bProv").value;
    const { models = [] } = await api("/api/ai/models", { provider: prov });
    const want = keep ?? BOT_MODEL[prov] ?? "";
    $("bModel").innerHTML = models.map((m) => `<option value="${esc(m.id)}" ${m.id === want ? "selected" : ""}>${esc(m.name)}</option>`).join("") || `<option value="">기본 모델</option>`;
    if (![...$("bModel").options].some((o) => o.selected)) $("bModel").value = "";
  };
  $("bProv").onchange = () => loadModels(null);
  await loadModels(b.model);
  dlg.returnValue = "";
  dlg.onclose = async () => {
    const v = dlg.returnValue;
    if (v === "del") {
      if (!confirm(`“${b.name}” 봇을 지울까요?`)) return;
      const x = await api("/api/bots/remove", { id: b.id });
      if (!x.ok) return alert(x.message);
      return renderBots(true);
    }
    if (v !== "ok") return;
    const x = await api("/api/bots/save", { id: b.id, emoji: $("bEmoji").value.trim() || "🤖", name: $("bName").value, role: $("bRole").value, provider: $("bProv").value, model: $("bModel").value, perm: $("bPerm").value });
    if (!x.ok) { alert(x.message); return botDialog({ ...b, name: $("bName").value, role: $("bRole").value }); }
    renderBots(true);
  };
  dlg.showModal();
}

// ---------- 팀 만들기·고치기 ----------
function roomDialog(r) {
  const isNew = !r.id;
  if (!bt.bots.length) return alert("봇을 먼저 만드세요.");
  r = { schedule: { every: "manual" }, members: [], lead: bt.bots[0].id, ...r };
  const s = r.schedule || {};
  let dlg = $("roomDlg");
  if (!dlg) { dlg = document.createElement("dialog"); dlg.id = "roomDlg"; dlg.className = "ask-dlg routine-dlg"; document.body.appendChild(dlg); }
  dlg.innerHTML = `<form method="dialog"><div class="dlg-head">${isNew ? "새 팀" : "팀 설정"}</div><div class="dlg-body">
    <label class="fld">팀 이름<input id="rName" value="${esc(r.name || "")}" placeholder="예: 견적 분석 팀"></label>
    <label class="fld">팀장 (일을 나누고 결과를 모아 답함)<select id="rLead">${bt.bots.map((b) => `<option value="${b.id}" ${b.id === r.lead ? "selected" : ""}>${esc(b.emoji)} ${esc(b.name)}</option>`).join("")}</select></label>
    <div class="fld">팀원 <small>(없어도 됩니다 — 팀장이 필요하면 임시 팀원을 만들어 맡깁니다)</small><div class="bot-members" id="rMembers">${bt.bots.map((b) => `<label><input type="checkbox" data-m="${b.id}" ${r.members.includes(b.id) ? "checked" : ""}> ${esc(b.emoji)} ${esc(b.name)}</label>`).join("")}</div></div>
    <h4 class="rt-h2">예약 작업 (선택)</h4>
    <div class="fld-row">
      <label class="fld">언제<select id="rEvery">${[["manual", "없음"], ["hourly", "매시간"], ["daily", "매일"], ["weekly", "매주"]].map(([v, l]) => `<option value="${v}" ${s.every === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="fld" id="rTimeWrap">시각<input type="time" id="rTime" value="${esc(s.time || "09:00")}"></label>
    </div>
    <div class="fld" id="rDaysWrap">요일 <span class="days">${DAYS.map((d, i) => `<label><input type="checkbox" data-day="${i}" ${(s.days || [1]).includes(i) ? "checked" : ""}>${d}</label>`).join("")}</span></div>
    <label class="fld" id="rPromptWrap">그때 팀에게 맡길 일<textarea id="rPrompt" rows="3" placeholder="예: 어제 이후 들어온 문서를 요약하고 할 일을 뽑아 주세요">${esc(r.sched_prompt || "")}</textarea></label>
    <p class="help">예약 작업은 이 앱이 켜져 있을 때 돕니다. ‘물어보고 바꿈’ 봇의 앱 작업은 내가 허용할 때까지 기다립니다.</p>
    </div><div class="dlg-foot">${isNew ? "" : `<button class="ghost" value="del" type="submit">팀 지우기</button>`}<span class="grow"></span><button class="ghost" value="cancel" type="submit">취소</button><button class="primary" value="ok" type="submit">${isNew ? "만들기" : "저장"}</button></div></form>`;
  const sync = () => {
    const e = $("rEvery").value;
    $("rTimeWrap").hidden = !["daily", "weekly", "hourly"].includes(e);
    $("rDaysWrap").hidden = e !== "weekly";
    $("rPromptWrap").hidden = e === "manual";
    const lead = +$("rLead").value;
    dlg.querySelectorAll("[data-m]").forEach((c) => { c.disabled = +c.dataset.m === lead; if (c.disabled) c.checked = false; });
  };
  $("rEvery").onchange = sync; $("rLead").onchange = sync; sync();
  dlg.returnValue = "";
  dlg.onclose = async () => {
    const v = dlg.returnValue;
    if (v === "del") {
      if (!confirm(`“${r.name}” 팀과 대화 기록을 지울까요? (봇은 그대로)`)) return;
      const x = await api("/api/bots/room/remove", { id: r.id });
      if (!x.ok) return alert(x.message);
      return renderBots();
    }
    if (v !== "ok") return;
    const every = $("rEvery").value;
    const schedule = { every, time: $("rTime").value, ...(every === "weekly" ? { days: [...dlg.querySelectorAll("[data-day]:checked")].map((c) => +c.dataset.day) } : {}) };
    const x = await api("/api/bots/room/save", { id: r.id, name: $("rName").value, lead: +$("rLead").value,
      members: [...dlg.querySelectorAll("[data-m]:checked")].map((c) => +c.dataset.m), schedule, sched_prompt: every === "manual" ? "" : $("rPrompt").value });
    if (!x.ok) return alert(x.message);
    bt.room = x.id;
    renderBots(true);
  };
  dlg.showModal();
}

// 내 문서 검색 연결 상태 (위 오른쪽 표시 · 처음 화면 안내)
function renderDocsChip() {
  const d = bt.docs || {}, el = $("docsChip");
  if (!el) return;
  el.className = "docs-chip " + (d.running ? "ok" : d.installed ? "half" : "no");
  el.textContent = d.running ? "📚 내 문서 검색 켜짐" : d.installed ? "📚 내 문서 검색 (꺼짐)" : "📚 내 문서 검색 없음";
  el.title = d.running ? "봇이 문서를 찾고 읽고, 허용한 봇은 앱 작업도 합니다."
    : d.installed ? "봇이 문서를 찾고 읽을 수 있습니다. 앱 작업·근거 문서 열기는 내 문서 검색을 켜야 됩니다."
    : "내 문서 검색(MyDocSearch)을 설치하면 봇이 내 PC 문서를 근거로 답합니다.";
}
function docsNote() {
  const d = bt.docs || {};
  if (d.installed) return "";
  return `<p class="help">📚 <b>내 문서 검색(MyDocSearch)</b>이 이 PC에 없어 봇은 일반 지식으로만 답합니다. 설치하고 한 번 켜 두면 봇이 내 문서를 찾고 읽어 근거와 함께 답합니다.</p>`;
}

// 봇이 일하는 동안 화면 고치기 (src/bots.js가 bot-event로 알림)
let botTimer = null;
window.mcb.onBot((ev) => {
  if (ev.type !== "bot") return;
  clearTimeout(botTimer);
  botTimer = setTimeout(() => (ev.room === bt.room ? renderBotsLight() : renderBots(true)), 150);
});
// 대화만 다시 그린다 (팀 목록의 '일하는 중' 표시도)
async function renderBotsLight() {
  const r = await api("/api/bots");
  Object.assign(bt, r);
  renderDocsChip();
  if ($("roomList")) {
    $("roomList").innerHTML = bt.rooms.map(roomItem).join("");
    $("roomList").querySelectorAll("[data-room]").forEach((el) => el.onclick = () => { bt.room = +el.dataset.room; renderBots(true); });
  }
  await renderRoom();
}
