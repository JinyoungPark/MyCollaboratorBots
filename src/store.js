// 저장: 앱 데이터 폴더의 bots.db(봇·팀·대화 — SQLite)와 config.json(연결 끊기·화면 크기 등 설정)
// 데이터 형식이 바뀌면 SCHEMA_VERSION을 올리고 MIGRATIONS에 바꾸는 법을 더한다 (켤 때 차례로 적용, PRAGMA user_version에 기록)
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

let dir = null;
function init(dataDir) { dir = dataDir; fs.mkdirSync(dir, { recursive: true }); }

const MIGRATIONS = [
  // 1: 처음 (MyDocSearch의 MyDocBot 표와 같은 모양)
  `CREATE TABLE IF NOT EXISTS bots (id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT 'claude',
      model TEXT NOT NULL DEFAULT '', perm TEXT NOT NULL DEFAULT 'off', emoji TEXT NOT NULL DEFAULT '🤖', created REAL);
    CREATE TABLE IF NOT EXISTS bot_rooms (id INTEGER PRIMARY KEY, name TEXT NOT NULL, lead INTEGER, members TEXT NOT NULL DEFAULT '[]',
      schedule TEXT NOT NULL DEFAULT '{}', sched_prompt TEXT NOT NULL DEFAULT '', next_run REAL, created REAL);
    CREATE TABLE IF NOT EXISTS bot_msgs (id INTEGER PRIMARY KEY, room_id INTEGER, ts REAL, who TEXT, bot_id INTEGER, kind TEXT NOT NULL DEFAULT 'msg',
      text TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS bot_msgs_r ON bot_msgs(room_id, id);`,
];
const SCHEMA_VERSION = MIGRATIONS.length;

function connect() {
  const db = new DatabaseSync(path.join(dir, "bots.db"), { timeout: 30000 });
  db.exec("PRAGMA journal_mode=WAL");
  const have = db.prepare("PRAGMA user_version").get().user_version;
  if (have > SCHEMA_VERSION) throw new Error(`데이터가 더 새 버전(${have})의 것입니다. 앱을 최신 버전으로 업데이트하세요.`);
  for (let v = have; v < SCHEMA_VERSION; v++) {
    db.exec("BEGIN");
    try { db.exec(MIGRATIONS[v]); db.exec(`PRAGMA user_version=${v + 1}`); db.exec("COMMIT"); }
    catch (e) { db.exec("ROLLBACK"); throw e; }
  }
  return db;
}

const cfgFile = () => path.join(dir, "config.json");
function loadConfig() {
  try { return { ai_off: {}, ...JSON.parse(fs.readFileSync(cfgFile(), "utf8")) }; } catch { return { ai_off: {} }; }
}
function saveConfig(cfg) {
  const tmp = cfgFile() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, cfgFile());
}

module.exports = { init, connect, loadConfig, saveConfig, SCHEMA_VERSION };
