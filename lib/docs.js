/**
 * dsh-auto-convert —— 文档转 Markdown。
 *
 * 读图工具吃不下 docx/xlsx/pptx/pdf，`read` 读它们只会得到一堆二进制。
 * 这里在把路径交出去之前先转成 Markdown：docx 的标题/列表/表格、xlsx 的
 * 工作表、pptx 的每页文字都会按结构落下来。
 *
 * 全部自己实现，不引第三方包：zip 用 node:zlib 解（OOXML 就是个 zip），
 * XML 用正则取需要的节点，PDF 只捞文字层（没有 ToUnicode 的字体可能乱码，
 * 这种情况会给出警告）。
 */
import fs from "node:fs";
import zlib from "node:zlib";

/** 单份文档最多输出多少字符，超了截断并留说明。 */
const MAX_MD = 400_000;
/** xlsx 一张表最多取多少行。 */
const MAX_ROWS = 500;

/* ------------------------------------------------------------------ zip */

/** 读 OOXML 的 zip 容器：只解目录表和需要的成员，不整包解压。 */
export function readZip(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  const floor = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    if (localOff + 30 <= buf.length && name) entries.set(name, { method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: () => [...entries.keys()],
    has: (n) => entries.has(n),
    raw(name) {
      const e = entries.get(name);
      if (!e) return null;
      const nl = buf.readUInt16LE(e.localOff + 26);
      const el = buf.readUInt16LE(e.localOff + 28);
      const start = e.localOff + 30 + nl + el;
      const raw = buf.subarray(start, start + e.compSize);
      try {
        if (e.method === 0) return raw;
        if (e.method === 8) return zlib.inflateRawSync(raw);
      } catch { /* 坏成员当作没有 */ }
      return null;
    },
    text(name) {
      const b = this.raw(name);
      return b ? b.toString("utf8") : null;
    },
  };
}

/* ------------------------------------------------------------------ xml */

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** XML 实体反转义（含数字实体）。 */
export function unescapeXml(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    return NAMED[e] ?? m;
  });
}

/** 取某个标签（可带属性）第一次出现的属性值。 */
function attrOf(frag, tag, attr) {
  const m = new RegExp(`<${tag}\\b[^>]*\\b${attr}="([^"]*)"`, "i").exec(frag);
  return m ? m[1] : "";
}

/** 把管道表格的一行补齐、转义。 */
function pipeRow(cells) {
  const out = cells.map((c) => String(c).replace(/\r?\n/g, "<br>").replace(/\|/g, "\\|").trim());
  return "| " + out.join(" | ") + " |";
}

/** 二维数组 → Markdown 表格（首行当表头）。 */
export function tableToMd(rows) {
  const clean = rows.map((r) => r.map((c) => (c == null ? "" : c)));
  const width = Math.max(0, ...clean.map((r) => r.length));
  if (!width) return [];
  const grid = clean.map((r) => {
    const row = r.slice();
    while (row.length < width) row.push("");
    return row;
  });
  const head = grid[0];
  const body = grid.slice(1);
  return [pipeRow(head), "| " + head.map(() => "---").join(" | ") + " |", ...body.map(pipeRow)];
}

/* ----------------------------------------------------------------- docx */

/** 段落文本：w:t 拼接，w:tab/w:br 还原成制表与换行。 */
function docxParaText(frag) {
  const withBreaks = frag
    .replace(/<w:tab\b[^>]*\/?>/gi, "\t")
    .replace(/<w:(?:br|cr)\b[^>]*\/?>/gi, "\n");
  let out = "";
  for (const m of withBreaks.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gi)) out += unescapeXml(m[1]);
  return out;
}

/** 样式名 → 标题级别（Heading1 / 标题 1 / 1 都认）。 */
function headingLevel(style) {
  const s = String(style).trim().replace(/\s+/g, " ");
  const m = /^heading\s*([1-6])$/i.exec(s) || /^标题\s*([1-6])$/.exec(s) || /^([1-6])$/.exec(s);
  return m ? Number(m[1]) : 0;
}

/** 段落样式是「列表」：Word 的 List Bullet / List Paragraph、中文的「列表段落」。 */
function isListStyle(style) {
  return /^list/i.test(String(style).trim()) || /^列表/.test(String(style).trim());
}

/** docx 表格 → 二维文本。 */
function docxTable(frag) {
  const rows = [];
  for (const tr of frag.matchAll(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/gi)) {
    const cells = [];
    for (const tc of tr[1].matchAll(/<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/gi)) {
      const paras = [];
      for (const p of tc[1].matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/gi)) {
        const t = docxParaText(p[1]).trim();
        if (t) paras.push(t);
      }
      cells.push(paras.join("\n"));
    }
    if (cells.some((c) => c.trim())) rows.push(cells);
  }
  return rows;
}

/** docx → Markdown 文本。 */
export function docxToMd(file) {
  const zip = readZip(file);
  const xml = zip && zip.text("word/document.xml");
  if (!xml) return null;
  const blocks = [];
  const re = /<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/gi;
  let list = [];
  const flush = () => {
    if (list.length) { blocks.push(list.join("\n")); list = []; }
  };
  for (const m of xml.matchAll(re)) {
    const frag = m[0];
    if (/^<w:tbl/i.test(frag)) {
      flush();
      const rows = docxTable(frag);
      if (rows.length) blocks.push(tableToMd(rows).join("\n"));
      continue;
    }
    const text = docxParaText(frag);
    if (!text.trim()) { flush(); continue; }
    const level = headingLevel(attrOf(frag, "w:pStyle", "w:val"));
    const style = attrOf(frag, "w:pStyle", "w:val");
    if (level) { flush(); blocks.push("#".repeat(level) + " " + text.trim()); }
    else if (/<w:numPr[\s>]/.test(frag) || isListStyle(style)) list.push("- " + text.trim().replace(/\n/g, " "));
    else { flush(); blocks.push(text.trim()); }
  }
  flush();
  return blocks.join("\n\n");
}

/* ----------------------------------------------------------------- xlsx */

/** sharedStrings.xml → 字符串数组。 */
function xlsxShared(zip) {
  const xml = zip.text("xl/sharedStrings.xml");
  if (!xml) return [];
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/gi)].map((m) =>
    [...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gi)].map((t) => unescapeXml(t[1])).join("")
  );
}

/** "AB12" → 列号 27。 */
function colIndex(ref) {
  const letters = /^([A-Z]+)/i.exec(ref || "");
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 工作表清单：按 workbook 里的顺序，拿 rels 换成真实路径。 */
function xlsxSheets(zip) {
  const wb = zip.text("xl/workbook.xml");
  const rels = zip.text("xl/_rels/workbook.xml.rels");
  const rel = new Map();
  if (rels) {
    // 属性顺序各家不一样（openpyxl 把 Target 写在 Id 前面），逐个标签各取各的
    for (const m of rels.matchAll(/<Relationship\b[^>]*\/?>/gi)) {
      const id = attrOf(m[0], "Relationship", "Id");
      const target = attrOf(m[0], "Relationship", "Target");
      if (id && target) rel.set(id, target.replace(/^\/?(?:xl\/)?/, "").replace(/^\.\//, ""));
    }
  }
  const out = [];
  if (wb) {
    for (const m of wb.matchAll(/<sheet\b[^>]*\/?>/gi)) {
      const name = unescapeXml(attrOf(m[0], "sheet", "name")) || `Sheet${out.length + 1}`;
      const rid = attrOf(m[0], "sheet", "r:id") || attrOf(m[0], "sheet", "id");
      const target = rel.get(rid);
      if (target) out.push({ name, path: /^xl\//.test(target) ? target : "xl/" + target });
    }
  }
  if (!out.length) {
    for (const n of zip.names().filter((x) => /^xl\/worksheets\/sheet\d+\.xml$/.test(x)).sort()) {
      out.push({ name: n.replace(/^.*sheet(\d+)\.xml$/, "Sheet$1"), path: n });
    }
  }
  return out;
}

/** 一张工作表 → 二维文本。 */
function xlsxGrid(xml, shared) {
  const rows = [];
  for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    const cells = [];
    for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gi)) {
      const attrs = c[1] || "";
      const inner = c[2] || "";
      const t = (/\bt="([^"]*)"/.exec(attrs) || [])[1] || "";
      const ref = (/\br="([^"]*)"/.exec(attrs) || [])[1] || "";
      let v = "";
      if (t === "s") {
        const idx = Number((/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1]);
        v = Number.isFinite(idx) ? shared[idx] ?? "" : "";
      } else if (t === "inlineStr") {
        v = [...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gi)].map((m) => unescapeXml(m[1])).join("");
      } else {
        const raw = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
        v = raw === undefined ? unescapeXml(inner.replace(/<[^>]+>/g, "")) : unescapeXml(raw);
      }
      const at = colIndex(ref);
      cells[at >= 0 ? at : cells.length] = v;
    }
    while (cells.length && String(cells[cells.length - 1] ?? "").trim() === "") cells.pop();
    if (cells.some((x) => String(x ?? "").trim())) rows.push(cells);
  }
  return rows;
}

/** xlsx → Markdown 文本。 */
export function xlsxToMd(file) {
  const zip = readZip(file);
  if (!zip) return null;
  const shared = xlsxShared(zip);
  const blocks = [];
  for (const sheet of xlsxSheets(zip)) {
    const xml = zip.text(sheet.path);
    if (!xml) continue;
    let rows = xlsxGrid(xml, shared);
    if (!rows.length) continue;
    let note = "";
    if (rows.length > MAX_ROWS) { rows = rows.slice(0, MAX_ROWS); note = `（只列出前 ${MAX_ROWS} 行）`; }
    blocks.push(`## ${sheet.name}${note}\n\n` + tableToMd(rows).join("\n"));
  }
  return blocks.length ? blocks.join("\n\n") : null;
}

/* ----------------------------------------------------------------- pptx */

/** pptx → Markdown 文本，一页一个二级标题。 */
export function pptxToMd(file) {
  const zip = readZip(file);
  if (!zip) return null;
  const order = [];
  const pres = zip.text("ppt/presentation.xml");
  const rels = zip.text("ppt/_rels/presentation.xml.rels");
  if (pres && rels) {
    const rel = new Map();
    for (const m of rels.matchAll(/<Relationship\b[^>]*\/?>/gi)) {
      const id = attrOf(m[0], "Relationship", "Id");
      const target = attrOf(m[0], "Relationship", "Target");
      if (id && target) rel.set(id, target.replace(/^\.\//, "").replace(/^\/?ppt\//, ""));
    }
    for (const m of pres.matchAll(/<p:sldId\b[^>]*?r:id="([^"]+)"/gi)) {
      const t = rel.get(m[1]);
      if (t) order.push(t.startsWith("ppt/") ? t : "ppt/" + t);
    }
  }
  const slides = order.length
    ? order
    : zip.names().filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort((a, b) => Number(a.replace(/\D+/g, "")) - Number(b.replace(/\D+/g, "")));
  const blocks = [];
  slides.forEach((path, i) => {
    const xml = zip.text(path);
    if (!xml) return;
    const lines = [];
    for (const p of xml.matchAll(/<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/gi)) {
      let text = "";
      for (const t of p[1].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gi)) text += unescapeXml(t[1]);
      if (text.trim()) lines.push(text.trim());
    }
    for (const tbl of xml.matchAll(/<a:tbl(?:\s[^>]*)?>[\s\S]*?<\/a:tbl>/gi)) {
      const rows = [];
      for (const tr of tbl[0].matchAll(/<a:tr(?:\s[^>]*)?>([\s\S]*?)<\/a:tr>/gi)) {
        const cells = [];
        for (const tc of tr[1].matchAll(/<a:tc(?:\s[^>]*)?>([\s\S]*?)<\/a:tc>/gi)) {
          cells.push([...tc[1].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gi)].map((m) => unescapeXml(m[1])).join(" ").trim());
        }
        if (cells.some((c) => c)) rows.push(cells);
      }
      if (rows.length) lines.push(tableToMd(rows).join("\n"));
    }
    if (lines.length) blocks.push(`## 第 ${i + 1} 页\n\n` + lines.join("\n\n"));
  });
  return blocks.length ? blocks.join("\n\n") : null;
}

/* ------------------------------------------------------------------ pdf */

/** PDF 字符串字面量里的转义。 */
function pdfString(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (m, e) => {
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" }[e] ?? e;
  });
}

/** 内容流里的文字操作：Tj / TJ / ' / " 与换行操作。 */
function pdfContentText(data, cmap) {
  let out = "";
  const text = (tok) => {
    const t = tok.trim();
    if (t[0] === "(") return pdfString(t.slice(1, t.lastIndexOf(")")));
    if (t[0] === "<") return decodeHex(t.replace(/[^0-9a-fA-F]/g, ""), cmap);
    return "";
  };
    for (const m of data.matchAll(/BT([\s\S]*?)ET/g)) {
    const seg = m[1];
    for (const t of seg.matchAll(/\((?:\\.|[^\\()])*\)\s*(?:Tj|')|<[0-9a-fA-F\s]*>\s*Tj|\[[^\]]*\]\s*TJ|T\*|Td|TD/g)) {
      const s = t[0];
      if (s[0] === "[") {
        for (const p of s.matchAll(/\((?:\\.|[^\\()])*\)|<[0-9a-fA-F\s]*>/g)) out += text(p[0]);
      } else if (s[0] === "(" || s[0] === "<") out += text(s.replace(/\s*(?:Tj|')$/, ""));
      else out += "\n";
    }
    out += "\n";
  }
  return out;
}

/** 十六进制串按 ToUnicode 映射还原；没有映射就当 UTF-16BE。 */
function decodeHex(hex, cmap) {
  if (!hex) return "";
  let out = "";
  const map = cmap && cmap.map;
  if (map && map.size) {
    const step = cmap.step || 4;
    for (let i = 0; i + step <= hex.length; i += step) {
      const code = parseInt(hex.slice(i, i + step), 16);
      out += map.get(code) ?? (code < 0x20 ? "" : String.fromCharCode(code));
    }
    return out;
  }
  for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return out;
}

/** ToUnicode CMap → { map, step }（step 是源码位的十六进制位数）。 */
export function parseCMap(text) {
  const map = new Map();
  const u16 = (h) => {
    let out = "";
    for (let i = 0; i + 4 <= h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    if (!out && h.length) out = String.fromCharCode(parseInt(h, 16));
    return out;
  };
  let step = 0;
  const cs = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(text);
  if (cs) {
    const m = /<([0-9a-fA-F]+)>/.exec(cs[1]);
    if (m) step = m[1].length;
  }
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(p[1], 16), u16(p[2]));
      if (!step) step = p[1].length;
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
      const a = parseInt(p[1], 16);
      const b = parseInt(p[2], 16);
      if (!step) step = p[1].length;
      if (a > b || b - a > 65535) continue;
      if (p[3]) {
        const base = parseInt(p[3], 16);
        for (let i = 0; a + i <= b; i++) {
          const cp = base + i;
          if (cp <= 0x10ffff) map.set(a + i, String.fromCodePoint(cp));
        }
      } else if (p[4]) {
        const items = [...p[4].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => u16(x[1]));
        for (let i = 0; a + i <= b && i < items.length; i++) map.set(a + i, items[i]);
      }
    }
  }
  return { map, step: step || 4 };
}

/** pdf → 只捞文字层。返回 { md, warn } 或 null。 */
export function pdfToMd(file) {
  const buf = fs.readFileSync(file);
  const latin = buf.toString("latin1");
  const streams = [];
  for (const m of latin.matchAll(/(\d+)\s+(\d+)\s+obj([\s\S]*?)endobj/g)) {
    const obj = m[3];
    const at = obj.indexOf("stream");
    if (at < 0) continue;
    const dict = obj.slice(0, at);
    if (!/\/FlateDecode/.test(dict)) continue;
    let start = at + 6;
    if (obj[start] === "\r") start++;
    if (obj[start] === "\n") start++;
    const end = obj.indexOf("endstream", start);
    if (end < 0) continue;
    const bodyStart = m.index + m[0].indexOf("obj") + 3;
    try {
      streams.push(zlib.inflateSync(buf.subarray(bodyStart + start, bodyStart + end)).toString("latin1"));
    } catch { /* 解不开就跳过 */ }
  }
  if (!streams.length) return null;
  const cmap = { map: new Map(), step: 4 };
  for (const s of streams) {
    if (!s.includes("begincmap")) continue;
    const parsed = parseCMap(s);
    for (const [k, v] of parsed.map) cmap.map.set(k, v);
    if (parsed.step) cmap.step = parsed.step;
  }
  const pieces = [];
  for (const s of streams) {
    if (s.includes("begincmap")) continue;
    const text = pdfContentText(s, cmap);
    if (text.trim()) pieces.push(text);
  }
  if (!pieces.length) return null;
  const text = pieces.join("\n\n").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  return {
    md: text,
    warn: cjk === 0 && letters === 0 ? "PDF 文字层可能缺少 ToUnicode 映射，提取结果可能不可读" : "",
  };
}

/* --------------------------------------------------------- html / csv */

/** HTML → Markdown（标题、段落、列表、表格、粗斜体、链接）。 */
export function htmlToMd(html) {
  let s = String(html).replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (m, lv, body) => `\n\n${"#".repeat(Number(lv))} ${stripTags(body).trim()}\n\n`);
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (m, body) => `\n- ${stripTags(body).trim()}`);
  s = s.replace(/<\/(?:p|div|tr|ul|ol|table|blockquote)>/gi, "\n\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi, (m, body) => ` ${stripTags(body).trim()} |`);
  s = s.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, body) => `[${stripTags(body).trim()}](${href})`);
  s = s.replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, "**$1**");
  s = s.replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, "*$1*");
  s = stripTags(s);
  return s.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function stripTags(s) {
  return unescapeXml(String(s).replace(/<[^>]+>/g, ""));
}

/** CSV/TSV → Markdown 表格（够用的引号处理）。 */
export function csvToMd(text, delim = ",") {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delim) { row.push(cell); cell = ""; continue; }
    if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    if (ch === "\r") continue;
    cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const grid = rows.filter((r) => r.some((c) => c.trim()));
  return grid.length ? tableToMd(grid).join("\n") : "";
}

/* ------------------------------------------------------------- 调度 */

/** 按字节认文档类型——改过后缀也认得出。 */
export function sniffDoc(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(8);
    const n = fs.readSync(fd, head, 0, 8, 0);
    if (n < 4) return null;
    const ascii = head.toString("latin1", 0, n);
    if (ascii.startsWith("%PDF")) return "pdf";
    if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
      return "zip";
    }
    if (ascii.startsWith("<")) return "html";
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** zip 里看到哪种 OOXML 目录就是哪种文档。 */
function zipKind(file) {
  const zip = readZip(file);
  if (!zip) return null;
  if (zip.has("word/document.xml")) return "docx";
  if (zip.has("xl/workbook.xml")) return "xlsx";
  if (zip.has("ppt/presentation.xml")) return "pptx";
  return null;
}

/** 文档 → { kind, md, warn }；转不了返回 null（调用方原样放行）。 */
export function documentToMd(file, hint) {
  const kind = hint === "zip" ? zipKind(file) : hint;
  try {
    if (kind === "docx") { const md = docxToMd(file); return md ? { kind, md } : null; }
    if (kind === "xlsx") { const md = xlsxToMd(file); return md ? { kind, md } : null; }
    if (kind === "pptx") { const md = pptxToMd(file); return md ? { kind, md } : null; }
    if (kind === "pdf") {
      const r = pdfToMd(file);
      return r && r.md ? { kind, md: r.md, warn: r.warn } : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** 截断到 MAX_MD，别让一份几十页的文档把上下文顶爆。 */
export function clampMd(md) {
  if (md.length <= MAX_MD) return md;
  return md.slice(0, MAX_MD) + `\n\n<!-- 文档过长，已截断，仅保留前 ${MAX_MD} 字符 -->\n`;
}