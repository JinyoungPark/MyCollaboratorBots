// AI가 쓴 마크다운 문서를 워드(.docx)로 만든다. 서식 파일이 워드면 그 파일의 스타일·쪽 설정·머리말·꼬리말을 그대로 쓰고
// 본문만 바꾼다 (그래서 회사 양식 모양이 유지된다). 없으면 기본 스타일(맑은 고딕)로 만든다.
// 근거 링크 [파일명 · 3쪽](doc:…)는 본문에 (파일명 · 3쪽)으로 남기고, 끝에 '참고 문서' 목록을 붙인다.

const fs = require("fs");
const { unzipSync, zipSync, strToU8 } = require("fflate");

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const FONT = "맑은 고딕";

// ---------- 마크다운 → 블록 ----------
function blocks(md) {
  const out = [], lines = md.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || /^\s*(-{3,}|\*{3,})\s*$/.test(l)) continue;
    if (/^```/.test(l)) { const buf = []; while (++i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i]); out.push({ t: "code", text: buf.join("\n") }); continue; }
    let m = l.match(/^(#{1,4})\s+(.*)$/);
    if (m) { out.push({ t: "h", level: m[1].length, text: m[2].trim() }); continue; }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      i--;
      const cells = (r) => r.trim().slice(1, -1).split("|").map((c) => c.trim());
      out.push({ t: "table", rows: rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).map(cells) });
      continue;
    }
    m = l.match(/^(\s*)[-*•]\s+(.*)$/);
    if (m) { out.push({ t: "li", level: Math.min(3, Math.floor(m[1].length / 2)), text: m[2] }); continue; }
    m = l.match(/^(\s*)(\d+[.)])\s+(.*)$/);
    if (m) { out.push({ t: "li", level: Math.min(3, Math.floor(m[1].length / 2)), num: m[2], text: m[3] }); continue; }
    m = l.match(/^>\s?(.*)$/);
    out.push({ t: "p", text: m ? m[1] : l.trim(), quote: !!m });
  }
  return out;
}

// 줄 안의 꾸밈: **굵게**, `코드`, [글](doc:…) 근거, [글](http…) 링크
function runs(text, cited) {
  const out = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((doc:(\d+)(?:#c\d+)?|https?:[^)\s]+)\)/g;
  let last = 0, m;
  const plain = (s, rpr = "") => { if (s) out.push(`<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ""}<w:t xml:space="preserve">${xml(s)}</w:t></w:r>`); };
  while ((m = re.exec(text))) {
    plain(text.slice(last, m.index));
    if (m[1]) plain(m[1], "<w:b/>");
    else if (m[2]) plain(m[2], `<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>`);
    else if (m[5]) { cited.set(+m[5], m[3].split(" · ")[0]); plain(` (${m[3]})`, `<w:color w:val="6B7A86"/><w:sz w:val="18"/>`); }
    else plain(m[3]);
    last = re.lastIndex;
  }
  plain(text.slice(last));
  return out.join("");
}

// ---------- 스타일 ----------
// 서식 파일의 스타일 이름(heading 1, Title …)으로 스타일 ID를 찾는다 (한글 워드는 ID가 '1'·'2'처럼 숫자인 경우가 많다)
function styleIds(stylesXml) {
  const ids = {};
  for (const m of stylesXml.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>[\s\S]*?<w:name w:val="([^"]+)"/g)) ids[m[2].toLowerCase()] = m[1];
  return ids;
}
const DEFAULT_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${FONT}" w:eastAsia="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}"/><w:sz w:val="21"/><w:lang w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="0E5A7A"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="60"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`;

// ---------- 본문 ----------
function body(md, ids, refs) {
  const cited = new Map();
  const st = (name) => ids[name] ? `<w:pStyle w:val="${ids[name]}"/>` : "";
  const P = (inner, ppr = "") => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ""}${inner}</w:p>`;
  const parts = [];
  let first = true;
  for (const b of blocks(md)) {
    if (b.t === "h") {
      // 맨 처음 '# 제목'은 문서 제목으로
      const style = first && b.level === 1 ? (st("title") || st("heading 1")) : st(`heading ${Math.min(3, b.level === 1 ? 1 : b.level - 1)}`);
      // 서식 파일에 제목 스타일이 없으면 굵고 큰 글씨로
      parts.push(style ? P(runs(b.text, cited), style)
        : P(`<w:r><w:rPr><w:b/><w:sz w:val="${b.level === 1 ? 32 : 26}"/></w:rPr><w:t xml:space="preserve">${xml(b.text.replace(/\*\*/g, ""))}</w:t></w:r>`, `<w:spacing w:before="200"/>`));
    } else if (b.t === "li") {
      const mark = b.num ? b.num + " " : "• ";
      parts.push(P(`<w:r><w:t xml:space="preserve">${xml(mark)}</w:t></w:r>` + runs(b.text, cited), `<w:ind w:left="${360 + b.level * 360}" w:hanging="240"/><w:spacing w:after="60"/>`));
    } else if (b.t === "table") {
      const w = Math.max(...b.rows.map((r) => r.length));
      const grid = `<w:tblGrid>${Array.from({ length: w }, () => `<w:gridCol w:w="${Math.floor(9000 / w)}"/>`).join("")}</w:tblGrid>`;
      const tcs = (r, head) => Array.from({ length: w }, (_, c) => `<w:tc><w:tcPr><w:tcW w:w="${Math.floor(9000 / w)}" w:type="dxa"/>${head ? `<w:shd w:val="clear" w:color="auto" w:fill="EEF3F6"/>` : ""}</w:tcPr>${P(head ? `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${xml((r[c] || "").replace(/\*\*/g, ""))}</w:t></w:r>` : runs(r[c] || "", cited), `<w:spacing w:after="0"/>`)}</w:tc>`).join("");
      const borders = `<w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders>`;
      parts.push(`<w:tbl><w:tblPr>${ids["table grid"] ? `<w:tblStyle w:val="${ids["table grid"]}"/>` : ""}<w:tblW w:w="9000" w:type="dxa"/>${borders}</w:tblPr>${grid}${b.rows.map((r, i) => `<w:tr>${tcs(r, i === 0)}</w:tr>`).join("")}</w:tbl>`, P(""));
    } else if (b.t === "code") {
      parts.push(...b.text.split("\n").map((l) => P(`<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${xml(l)}</w:t></w:r>`, `<w:spacing w:after="0"/>`)));
    } else {
      parts.push(P(runs(b.text, cited), b.quote ? `<w:ind w:left="360"/>` : ""));
    }
    first = false;
  }
  // 참고 문서 (본문에 쓴 근거)
  if (cited.size) {
    parts.push(P(`<w:r><w:rPr><w:b/></w:rPr><w:t>참고 문서</w:t></w:r>`, (st("heading 1") || "") + `<w:spacing w:before="360"/>`));
    for (const [id, name] of cited) {
      const r = refs(id);
      parts.push(P(`<w:r><w:t xml:space="preserve">• ${xml(r ? r.name : name)}</w:t></w:r>${r ? `<w:r><w:rPr><w:color w:val="6B7A86"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">  ${xml(r.where)}</w:t></w:r>` : ""}`, `<w:ind w:left="360" w:hanging="240"/><w:spacing w:after="40"/>`));
    }
  }
  return parts.join("");
}

const NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
const DEFAULT_SECT = `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1300" w:bottom="1440" w:left="1300" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`;

// markdown → .docx 바이트. templatePath: 서식으로 쓸 .docx (없으면 기본). refs(id) → { name, where } (참고 문서 목록용)
function build(markdown, { templatePath = null, refs = () => null, title = "" } = {}) {
  // AI가 끝에 붙인 '근거 문서' 목록은 빼고, 아래에서 '참고 문서'로 한 번만 만든다
  markdown = String(markdown).replace(/\n\s*(?:-{3,}\s*\n\s*)?(?:\*\*|#{1,4}\s*)?근거 문서(?:\*\*)?\s*\n[\s\S]*$/, "\n");
  if (templatePath) {
    const files = unzipSync(new Uint8Array(fs.readFileSync(templatePath)));
    const doc = files["word/document.xml"] ? Buffer.from(files["word/document.xml"]).toString("utf8") : "";
    const styles = files["word/styles.xml"] ? Buffer.from(files["word/styles.xml"]).toString("utf8") : "";
    if (doc) {
      const ids = styleIds(styles);
      // 본문 끝의 쪽 설정(머리말·꼬리말 연결 포함) — 문서 중간의 구역 나누기는 본문과 함께 버린다
      const at = doc.lastIndexOf("<w:sectPr"), end = doc.indexOf("</w:sectPr>", at);
      const sect = at >= 0 && end > at ? doc.slice(at, end + "</w:sectPr>".length) : DEFAULT_SECT;
      const head = doc.slice(0, doc.indexOf("<w:body>") + "<w:body>".length);
      files["word/document.xml"] = strToU8(head + body(markdown, ids, refs) + sect + "</w:body></w:document>");
      if (title && files["docProps/core.xml"]) {
        const core = Buffer.from(files["docProps/core.xml"]).toString("utf8").replace(/<dc:title>[^<]*<\/dc:title>/, `<dc:title>${xml(title)}</dc:title>`);
        files["docProps/core.xml"] = strToU8(core);
      }
      return Buffer.from(zipSync(files, { level: 6 }));
    }
  }
  const ids = styleIds(DEFAULT_STYLES);
  const files = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`),
    "word/_rels/document.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    "word/styles.xml": strToU8(DEFAULT_STYLES),
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body(markdown, ids, refs)}${DEFAULT_SECT}</w:body></w:document>`),
    "docProps/core.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(title)}</dc:title><dc:creator>MyCollaboratorBots (AI 초안)</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().slice(0, 19)}Z</dcterms:created></cp:coreProperties>`),
  };
  return Buffer.from(zipSync(files, { level: 6 }));
}

module.exports = { build, blocks };
