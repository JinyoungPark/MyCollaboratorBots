// 버전 올리기: package.json의 버전을 올리고, CHANGELOG.md의 '## 다음 버전'을 '## x.y.z (오늘 날짜)'로 바꾼다.
// 사용: npm run version:patch | version:minor | version:major  (또는 node scripts/bump-version.js 1.2.3)
// 그 뒤: git commit -am "x.y.z" && git tag vx.y.z && git push --follow-tags → GitHub Actions가 릴리스를 만든다 (.github/workflows/build.yml)
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const pkgFile = path.join(root, "package.json"), logFile = path.join(root, "CHANGELOG.md");

function bump(v, how) {
  if (/^\d+\.\d+\.\d+$/.test(how)) return how;
  const [a, b, c] = v.split(".").map(Number);
  if (how === "major") return `${a + 1}.0.0`;
  if (how === "minor") return `${a}.${b + 1}.0`;
  if (how === "patch") return `${a}.${b}.${c + 1}`;
  throw new Error("patch | minor | major | x.y.z 중 하나를 주세요");
}

function run(how, today = new Date()) {
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  const next = bump(pkg.version, how);
  const log = fs.readFileSync(logFile, "utf8");
  if (!/^## 다음 버전\s*$/m.test(log)) throw new Error("CHANGELOG.md에 '## 다음 버전' 항목이 없습니다. 바뀐 점을 먼저 적으세요.");
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  fs.writeFileSync(logFile, log.replace(/^## 다음 버전\s*$/m, `## 다음 버전\n\n## ${next} (${date})`));
  pkg.version = next;
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
  return next;
}

if (require.main === module) {
  try {
    const v = run(process.argv[2] || "patch");
    console.log(`버전 ${v}\n다음: git commit -am "${v}" && git tag v${v} && git push --follow-tags`);
    process.exit(0);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { bump, run };
