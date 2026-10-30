/**
 * dsh-auto-convert —— 高分辨率图在读之前自动降采样，一轮对话内解决。
 *
 * 图片工具一次吃不下太大的图（长边 > 2048 或 > 8MB）就会报错，报错就得再来
 * 一轮。这里在读之前先换成本地降采样后的副本：工具拿到的是能读的小图，
 * 模型拿到的还是这一轮的答案。只认读图工具本来就能读的格式，别的原样放行。
 *
 * 挂的是宿主 tools/execute 环绕钩子：read_image、vision_* 和 run_code 里的
 * 子调用走的是同一条路，一处修好全覆盖。
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const name = "auto-convert";
export const inject = ["tools"];

/** 读图工具一次能吃下的上限。 */
const MAX_SIDE = 2048;
const MAX_BYTES = 8 * 1024 * 1024;
/** 报错重试时压得更狠一档。 */
const RETRY_SIDE = 1280;
/** 只看不改的工具：它们错了才值得再压一档重试。 */
const READ_TOOL = /^(read_image|vision_)/;
/** 读图工具能读的格式；认不出的格式一律不碰。 */
const SUPPORTED = new Set(["png", "jpeg", "gif", "webp"]);
const TMP = path.join(os.tmpdir(), "dsh-auto-convert");
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 聊天里上传的图是按内容存的附件对象，读图工具只认 sha256:... 这种 id。 */
const STORE = path.join(os.homedir(), ".dsh", "attachments", "v1", "objects");
const ID = /^sha256:([0-9a-f]{64})$/i;

/** 按文件头认格式——比扩展名可靠，改过名的图也认得出。 */
export function sniff(file) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(16);
    if (fs.readSync(fd, head, 0, 16, 0) < 12) return null;
    const ascii = (a, b) => head.toString("latin1", a, b);
    if (head[0] === 0x89 && ascii(1, 4) === "PNG") return "png";
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
    if (ascii(0, 4) === "GIF8") return "gif";
    if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
    return null;
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

/**
 * 真的要动手时才解码。返回 null 表示这张图不需要改。
 * 产物按「源文件 + mtime + 目标长边」缓存，同一张图只压一次。
 */
export async function convert(file, opts) {
  const Jimp = loadJimp();
  const bytes = fs.statSync(file).size;
  const img = await Jimp.read(file);
  const { width, height } = img.bitmap;
  const longest = Math.max(width, height);
  const maxSide = opts.maxSide ?? MAX_SIDE;
  const shrink = longest > maxSide;
  if (!opts.force && !shrink && bytes <= MAX_BYTES) return null;
  if (shrink) {
    const s = maxSide / longest;
    img.resize(Math.max(1, Math.round(width * s)), Math.max(1, Math.round(height * s)), Jimp.RESIZE_BICUBIC);
  }
  const ext = img.hasAlpha() ? "png" : "jpg";
  if (ext === "jpg") img.quality(88);
  const key = createHash("sha1").update(file + "|" + fs.statSync(file).mtimeMs + "|" + maxSide).digest("hex").slice(0, 16);
  const out = path.join(TMP, key + "." + ext);
  if (!fs.existsSync(out)) {
    await fsp.mkdir(TMP, { recursive: true });
    await new Promise((resolve, reject) => img.write(out, (e) => (e ? reject(e) : resolve())));
  }
  // 只是超了体积、压完反而更大：那就不换
  if (!shrink && fs.statSync(out).size >= bytes) return null;
  return out;
}

/** 单个字符串参数：是本地图片就考虑换掉它。 */
async function maybeConvert(str, opts, info) {
  if (typeof str !== "string" || !path.isAbsolute(str)) return str;
  let st;
  try {
    st = fs.statSync(str);
  } catch {
    return str;
  }
  if (!st.isFile() || st.size === 0) return str;
  let kind;
  try {
    kind = sniff(str);
  } catch {
    return str;
  }
  if (!kind || !SUPPORTED.has(kind)) return str; // 读图工具本来就不吃的格式，不碰
  let out;
  try {
    out = await convert(str, opts);
  } catch {
    return str; // 解码不了就原样交回去，让工具自己报它原本的错
  }
  if (!out || out === str) return str;
  info.push({ from: str, to: out, kind, bytes: st.size, outBytes: fs.statSync(out).size });
  return out;
}

async function walk(value, opts, info, depth) {
  if (depth > 5 || info.length >= 8) return value;
  if (typeof value === "string") return maybeConvert(value, opts, info);
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

/** 把参数里所有本地图片路径过一遍；附件 id 先落地成文件再当路径处理。 */
export async function rewrite(args, opts = {}) {
  const info = [];
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const ids = [].concat(args.attachmentIds ?? [], args.attachmentId ?? []);
    if (ids.length) {
      const paths = [];
      for (const id of ids) {
        const file = attachmentFile(id, opts.attachmentsRoot);
        if (file) paths.push(await maybeConvert(file, opts, info));
      }
      if (paths.length) {
        const next = { ...args, paths: [...(Array.isArray(args.paths) ? args.paths : []), ...paths] };
        delete next.attachmentIds;
        delete next.attachmentId;
        return { args: await walk(next, opts, info, 0), info };
      }
    }
  }
  const next = await walk(args, opts, info, 0);
  return { args: info.length ? next : args, info };
}

export function apply(ctx) {
  ctx.on("tools/execute", async (exec, next) => {
    const original = exec.arguments;
    let first = { args: original, info: [] };
    try {
      first = await rewrite(original, { maxSide: MAX_SIDE });
    } catch {}
    if (first.info.length) exec.arguments = first.args;
    const result = await next();
    const retryable = READ_TOOL.test(exec.name) && first.info.length > 0 && result && result.isError;
    if (!retryable) return result;
    // 还是读不出来：压到 RETRY_SIDE 再来一次，同一轮里解决
    let retry = { args: original, info: [] };
    try {
      retry = await rewrite(original, { maxSide: RETRY_SIDE, force: true });
    } catch {}
    if (!retry.info.length) return result;
    exec.arguments = retry.args;
    return await next();
  });
}

// ponytail: 产物留在系统临时目录不主动清理，靠 OS 回收；真占了盘再加按天清扫。
// ponytail: 超大 GIF 会被压成单帧静态图（jimp 只读第一帧），真要保留动画得上 ffmpeg。
export const __test = { sniff, rewrite, loadJimp, convert, attachmentFile };

