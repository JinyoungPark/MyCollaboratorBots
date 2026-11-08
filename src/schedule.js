// 예약 작업 일정 { every: manual|hourly|daily|weekly, time: "09:00", days: [0~6] } — MyDocSearch 루틴과 같은 형식
function nextRun(sched, from = Date.now()) {
  const s = sched || {};
  const [hh, mm] = String(s.time || "09:00").split(":").map(Number);
  if (s.every === "hourly") { const d = new Date(from); d.setMinutes(mm || 0, 0, 0); if (+d <= from) d.setHours(d.getHours() + 1); return +d / 1000; }
  if (s.every === "daily" || s.every === "weekly") {
    const days = s.every === "weekly" ? (s.days && s.days.length ? s.days : [5]) : [0, 1, 2, 3, 4, 5, 6];
    for (let i = 0; i < 8; i++) {
      const d = new Date(from); d.setDate(d.getDate() + i); d.setHours(hh || 0, mm || 0, 0, 0);
      if (+d > from && days.includes(d.getDay())) return +d / 1000;
    }
  }
  return null;                                     // 직접 실행
}
const DAY = ["일", "월", "화", "수", "목", "금", "토"];
function scheduleLabel(sched) {
  const s = sched || {};
  if (s.every === "hourly") return `매시간 ${String(String(s.time || "00:00").split(":")[1] || "00").padStart(2, "0")}분`;
  if (s.every === "daily") return `매일 ${s.time || "09:00"}`;
  if (s.every === "weekly") return `매주 ${(s.days && s.days.length ? s.days : [5]).map((d) => DAY[d]).join("·")} ${s.time || "09:00"}`;
  return "직접 실행";
}

module.exports = { nextRun, scheduleLabel };
