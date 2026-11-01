/**
 * dsh-auto-convert —— 工具动手之前，先把图/文档弄成它能读的样子。
 *
 * 两条线，都挂在宿主 tools/execute 环绕钩子上，read、read_image、vision_* 和
 * run_code 里的子调用走同一条路，一处修好全覆盖：
 *
 *   图片：长边 > 2048 或 > 8MB 就降采样；读图工具不吃的 BMP/TIFF 转 PNG；
 *         后端还说太大，同一轮再降到 1280 重试一次。
 *   文档：docx/xlsx/pptx/pdf/csv/tsv/html 就地转成 Markdown，把路径换掉，
 *         于是「拖进来一个 docx，这一轮就能读」而不是让模型看二进制。
 *
 * 上传那一关也顺手兜一层：宿主只比对「上传时标的类型」和「真实字节」，对不
 * 上就直接拒（.png 名字装 WebP 就是这么被打回的）。这里在附件入库前改标成
 * 真实格式，BMP／TIFF 就地转 PNG，解不开的原样放行让宿主报它自己的错。
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { sniffDoc, documentToMd, clampMd, csvToMd, htmlToMd, parseCMap } from "./docs.js";

export const name = "auto-convert";
export const inject = ["tools"];

/** 读图工具一次能吃下的上限。 */
const MAX_SIDE = 2048;
const MAX_BYTES = 8 * 1024 * 1024;
/** 报错重试时压得更狠一档。 */
const RETRY_SIDE = 1280;
/** 只看不改的工具：它们错了才值得再压一档重试。 */
const READ_TOOL = /^(read_image|vision_)/;
/** 读图工具能读的格式；不在这里面的就是「不支持的图」，得转一手。 */
const SUPPORTED = new Set(["png", "jpeg", "gif", "webp"]);
/** jimp 能解码、读图工具却不吃的格式：统一转成 PNG 交出去。 */
const CONVERTIBLE = new Set(["bmp", "tiff"]);
/** 宿主认的图片类型；上传时标的类型跟真实字节对不上就被它打回。 */
const MIME = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
/** 能转成 Markdown 的文档扩展名。 */
const DOC_EXT = {
  docx: "docx", xlsx: "xlsx", pptx: "pptx", pdf: "pdf",
  csv: "csv", tsv: "tsv", htm: "html", html: "html",
};
const TMP = path.join(os.tmpdir(), "dsh-auto-convert");
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 聊天里上传的图是按内容存的附件对象，读图工具只认 sha256:... 这种 id。 */
const STORE = path.join(os.homedir(), ".dsh", "attachments", "v1", "objects");
/** 同目录下 files/<xx>/<sha>/<name> 是不许改写的原始文件（docx 之类就在这儿）。 */
const FILE_STORE = path.join(os.homedir(), ".dsh", "attachments", "v1", "files");
const ID = /^sha256:([0-9a-f]{64})$/i;

/** 按文件头认格式——比扩展名可靠，改过名的图也认得出。 */
export function sniffHead(head) {
  if (!head || head.length < 12) return null;
  const ascii = (a, b) => head.toString("latin1", a, b);
  if (head[0] === 0x89 && ascii(1, 4) === "PNG") return "png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  if (ascii(0, 4) === "GIF8") return "gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (ascii(0, 2) === "BM") return "bmp";
  if (ascii(0, 4) === "II*\u0000" || ascii(0, 4) === "MM\u0000*") return "tiff";
  return null;
}

export function sniff(file) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(16);
    if (fs.readSync(fd, head, 0, 16, 0) < 12) return null;
    return sniffHead(head);
  } finally {
    fs.closeSync(fd);
  }
}

/** jimp 装在 profile 的 node_modules 里，顺着 DSH 家目录找一遍。 */
let jimp;
export function loadJimp() {
  if (jimp) return jimp;
  const roots = [];
  try {
    const profiles = path.join(os.homedir(), ".dsh", "profiles");
    for (const d of fs.readdirSync(profiles)) roots.push(path.join(profiles, d));
  } catch {}
  roots.push(HERE);
  const errors = [];
  for (const r of roots) {
    try {
      jimp = createRequire(path.join(r, "package.json"))("jimp");
      return jimp;
    } catch (e) {
      errors.push(path.basename(r) + ": " + e.message);
    }
  }
  throw new Error("dsh-auto-convert: 找不到 jimp，无法降采样（" + errors.join("; ") + "）");
}

/** sha256:... → 本地对象文件；不是附件 id、或文件已经不在，返回 null。 */
export function attachmentFile(id, root = STORE) {
  const m = ID.exec(String(id ?? "").trim());
  if (!m) return null;
  const hex = m[1].toLowerCase();
  const file = path.join(root, hex.slice(0, 2), hex);
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/** 同名原始文件（拖进来的 docx 存在 files/<xx>/<sha>/<name>）。 */
export function attachmentNamed(id, name, root = FILE_STORE) {
  const m = ID.exec(String(id ?? "").trim());
  if (!m || !name) return null;
  const hex = m[1].toLowerCase();
  const file = path.join(root, hex.slice(0, 2), hex, path.basename(String(name)));
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/**
 * 图片：真的要动手时才解码。返回 null 表示这张图不需要改。
 * 产物按「源文件 + mtime + 目标长边」缓存，同一张图只压一次。
 */
export async function convert(file, opts) {
  const Jimp = loadJimp();
  const bytes = fs.statSync(file).size;
  const img = await Jimp.read(file);
  const { width, height } = img.bitmap;
  const longest = Math.max(width, height);
  const maxSide = opts.maxSide ?? MAX_SIDE;
  const kind = opts.kind ?? sniff(file);
  const reencode = !SUPPORTED.has(kind); // 读图工具压根不吃这格式，哪怕不大也得换
  const shrink = longest > maxSide;
  if (!opts.force && !shrink && !reencode && bytes <= MAX_BYTES) return null;
  if (shrink) {
    const s = maxSide / longest;
    img.resize(Math.max(1, Math.round(width * s)), Math.max(1, Math.round(height * s)), Jimp.RESIZE_BICUBIC);
  }
  const ext = reencode || img.hasAlpha() ? "png" : "jpg";
  if (ext === "jpg") img.quality(88);
  const key = createHash("sha1").update(file + "|" + fs.statSync(file).mtimeMs + "|" + maxSide + "|" + ext).digest("hex").slice(0, 16);
  const out = path.join(TMP, key + "." + ext);
  if (!fs.existsSync(out)) {
    await fsp.mkdir(TMP, { recursive: true });
    await new Promise((resolve, reject) => img.write(out, (e) => (e ? reject(e) : resolve())));
  }
  // 只是超了体积、压完反而更大：那就不换；转格式的没法挑，本来就读不了
  if (!shrink && !reencode && fs.statSync(out).size >= bytes) return null;
  return out;
}

/** 文档类型：先看字节，再看扩展名。认不出返回 null。 */
export function docKind(file) {
  let sniffed = null;
  try {
    sniffed = sniffDoc(file);
  } catch {
    sniffed = null;
  }
  if (sniffed === "zip" || sniffed === "pdf") return sniffed;
  const ext = path.extname(file).slice(1).toLowerCase();
  if (DOC_EXT[ext]) return DOC_EXT[ext];
  if (sniffed === "html") return "html";
  return null;
}

/**
 * 文档 → Markdown 副本；不需要转或转不出内容时返回 null。
 * 返回 { out, kind }，kind 是解开 zip 之后的真实类型（docx/xlsx/pptx）。
 * 产物按「源文件 + mtime + 体积」缓存，同一份文档只转一次。
 */
export async function convertDocument(file, opts = {}) {
  const hint = opts.kind ?? docKind(file);
  if (!hint) return null;
  const st = fs.statSync(file);
  const key = createHash("sha1").update(file + "|" + st.mtimeMs + "|" + st.size + "|md").digest("hex").slice(0, 16);
  const out = path.join(TMP, "docs", key + ".md");
  let kind = hint;
  if (fs.existsSync(out)) {
    // 缓存命中：类型从产物头部注释里认回来，别把 "zip" 当成 docx 报出去
    try {
      const head = fs.readFileSync(out, "utf8").slice(0, 200);
      const m = /（([a-z]+)）/.exec(head);
      if (m) kind = m[1];
    } catch { /* 读不出来就用 hint */ }
    return { out, kind };
  }
  let md = null;
  if (hint === "csv" || hint === "tsv") {
    const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    md = csvToMd(text, hint === "tsv" ? "\t" : ",");
  } else if (hint === "html") {
    md = htmlToMd(fs.readFileSync(file, "utf8"));
  } else {
    const r = documentToMd(file, hint);
    md = r ? r.md : null;
    if (r) kind = r.kind;
  }
  if (!md || !md.trim()) return null;
  const header = `<!-- 源文件：${path.basename(file)}（${kind}）· dsh-auto-convert 转换 -->\n\n`;
  await fsp.mkdir(path.dirname(out), { recursive: true });
  await fsp.writeFile(out, header + clampMd(md), "utf8");
  return { out, kind };
}

/** 单个字符串参数：是本地图片或文档就考虑换掉它。 */
async function maybePrepare(str, opts, info) {
  if (typeof str !== "string" || !path.isAbsolute(str)) return str;
  let st;
  try {
    st = fs.statSync(str);
  } catch {
    return str;
  }
  if (!st.isFile() || st.size === 0) return str;

  // 1) 图片
  let kind = null;
  try {
    kind = sniff(str);
  } catch {
    kind = null;
  }
  if (kind && (SUPPORTED.has(kind) || CONVERTIBLE.has(kind))) {
    let out;
    try {
      out = await convert(str, { ...opts, kind });
    } catch {
      return str; // 解码不了就原样交回去，让工具自己报它原本的错
    }
    if (out && out !== str) {
      info.push({ from: str, to: out, kind, bytes: st.size, outBytes: fs.statSync(out).size });
      return out;
    }
    return str;
  }

  // 2) 文档（读图工具不吃 Markdown，交给它原本的报错）
  if (opts.imageTool) return str;
  const dk = docKind(str);
  if (!dk) return str;
  let out;
  try {
    out = await convertDocument(str, { ...opts, kind: dk });
  } catch {
    return str;
  }
  if (!out) return str;
  info.push({ from: str, to: out.out, kind: out.kind, doc: true, bytes: st.size, outBytes: fs.statSync(out.out).size });
  return out.out;
}

async function walk(value, opts, info, depth) {
  if (depth > 5 || info.length >= 8) return value;
  if (typeof value === "string") return maybePrepare(value, opts, info);
  if (Array.isArray(value)) {
    const out = [];
    for (const v of value) out.push(await walk(v, opts, info, depth + 1));
    return out;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = await walk(v, opts, info, depth + 1);
    return out;
  }
  return value;
}

/** 附件 id 落成文件：图上先找对象、再找同名原件。 */
function attachmentPathFor(id, name, opts) {
  const plain = attachmentFile(id, opts.attachmentsRoot);
  if (plain) {
    try {
      if (sniff(plain)) return plain;
    } catch { /* 当它不是图 */ }
  }
  return attachmentNamed(id, name, opts.filesRoot) ?? plain;
}

/** 把参数里所有本地图片/文档路径过一遍；附件 id 先落地成文件再当路径处理。 */
export async function rewrite(args, opts = {}) {
  const info = [];
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const ids = [].concat(args.attachmentIds ?? [], args.attachmentId ?? []);
    if (ids.length) {
      const paths = [];
      const names = [].concat(args.attachmentNames ?? [], args.name ?? []);
      for (let i = 0; i < ids.length; i++) {
        const file = attachmentPathFor(ids[i], names[i], opts);
        if (file) paths.push(await maybePrepare(file, opts, info));
      }
      if (paths.length) {
        const next = { ...args, paths: [...(Array.isArray(args.paths) ? args.paths : []), ...paths] };
        delete next.attachmentIds;
        delete next.attachmentId;
        delete next.attachmentNames;
        return { args: await walk(next, opts, info, 0), info };
      }
    }
  }
  const next = await walk(args, opts, info, 0);
  return { args: info.length ? next : args, info };
}

/**
 * 上传入库前把一张图弄成宿主吃得下的样子。
 * 名字骗人的只改标签（字节不动）；BMP／TIFF 转 PNG；解不开的原样交回去。
 */
export async function fixUpload(input) {
  const data = input?.data;
  if (!(data instanceof Uint8Array)) return input;
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const kind = sniffHead(buf);
  if (!kind || input.mediaType === MIME[kind]) return input; // 对得上就不用动
  if (SUPPORTED.has(kind)) return { ...input, mediaType: MIME[kind] }; // 改个标签就完事
  if (!CONVERTIBLE.has(kind)) return input; // 连 jimp 都解不开，别装懂
  const Jimp = loadJimp();
  const png = await (await Jimp.read(buf)).getBufferAsync(Jimp.MIME_PNG);
  return { ...input, mediaType: MIME.png, data: png };
}

/** 把附件服务的入库口包一层；服务还没挂上就等 ready 再试一次。 */
let guarded = false;
function guardUploads(ctx) {
  if (guarded) return;
  let store;
  try {
    store = typeof ctx.get === "function" ? ctx.get("attachments") : undefined;
  } catch {
    return;
  }
  if (!store) return;
  let patched = 0;
  for (const method of ["saveImages", "saveImage"]) {
    const orig = store[method];
    if (typeof orig !== "function") continue;
    try {
      store[method] = async function (arg) {
        const fixed = await Promise.all([].concat(arg).map((i) => fixUpload(i).catch(() => i)));
        return orig.call(this, Array.isArray(arg) ? fixed : fixed[0]);
      };
      if (store[method] !== orig) patched++;
    } catch {} // 服务对象不可写就算了，读图那边照旧
  }
  guarded = patched > 0;
}

export function apply(ctx) {
  guardUploads(ctx);
  ctx.on("ready", () => guardUploads(ctx));
  ctx.on("tools/execute", async (exec, next) => {
    const original = exec.arguments;
    const imageTool = READ_TOOL.test(exec.name);
    let first = { args: original, info: [] };
    try {
      first = await rewrite(original, { maxSide: MAX_SIDE, imageTool });
    } catch {}
    if (first.info.length) exec.arguments = first.args;
    const result = await next();
    // 只对「压过图、还是读不出来」的情况在同一轮补一档更狠的；文档不重试
    const retryable = imageTool && first.info.some((i) => !i.doc) && result && result.isError;
    if (!retryable) return result;
    // 还是读不出来：压到 RETRY_SIDE 再来一次，同一轮里解决
    let retry = { args: original, info: [] };
    try {
      retry = await rewrite(original, { maxSide: RETRY_SIDE, force: true, imageTool });
    } catch {}
    if (!retry.info.length) return result;
    exec.arguments = retry.args;
    return await next();
  });
}

// ponytail: 产物留在系统临时目录不主动清理，靠 OS 回收；真占了盘再加按天清扫。
// ponytail: 超大 GIF 会被压成单帧静态图（jimp 只读第一帧），真要保留动画得上 ffmpeg。
// ponytail: 老 .doc/.xls/.ppt 是 OLE2 二进制，纯 Node 解不干净，交给工具自己报错。
export const __test = {
  sniff, sniffHead, rewrite, loadJimp, convert, attachmentFile, attachmentNamed,
  fixUpload, apply, docKind, convertDocument, parseCMap, csvToMd, htmlToMd,
};