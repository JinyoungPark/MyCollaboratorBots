// 문제 기록: 앱이 겪은 오류를 앱 데이터 폴더의 logs/app.log에 남긴다 (1MB 넘으면 app.old.log로 넘기고 새로).
// 문서 내용은 적지 않는다. 진단 정보에는 사용자 폴더를 ~로 줄여 보여 준다
const fs = require("fs");
const os = require("os");
const path = require("path");

const MAX_BYTES = 1024 * 1024;
let file = null;

function init(dataDir) {
  const dir = path.join(dataDir, "logs");
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 기록 못 함 */ }
  file = path.join(dir, "app.log");
}

const text = (x) => (x instanceof Error ? x.stack || x.message : typeof x === "string" ? x : JSON.stringify(x));

function write(level, where, ...args) {
  if (!file) return;
  const line = `${new Date().toISOString()} ${level} [${where}] ${args.map(text).join(" ").replace(/\n/g, "\n    ")}\n`;
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file.replace(/\.log$/, ".old.log"));
    fs.appendFileSync(file, line);
  } catch { /* 기록 못 함 */ }
}
const error = (where, ...args) => write("ERROR", where, ...args);
const info = (where, ...args) => write("INFO", where, ...args);

// 최근 기록 n줄 (사용자 폴더는 ~로)
function tail(n = 60) {
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    return lines.slice(-n).join("\n").split(os.homedir()).join("~");
  } catch { return ""; }
}
const errorCount = () => { try { return (fs.readFileSync(file, "utf8").match(/ ERROR \[/g) || []).length; } catch { return 0; } };

module.exports = { init, error, info, tail, errorCount, file: () => file };
