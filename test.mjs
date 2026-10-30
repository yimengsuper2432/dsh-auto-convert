// 自检：不支持格式能转、超大图能压、小图和普通文件别乱碰。
// 跑法：node test.mjs
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __test } from "./lib/index.js";

const { sniff, rewrite, loadJimp } = __test;
const Jimp = loadJimp();
const dir = path.join(os.tmpdir(), "dsh-auto-convert-test-" + process.pid);
await fsp.mkdir(dir, { recursive: true });

let failed = 0;
function check(label, ok, detail) {
  if (ok) console.log("  ok   " + label);
  else {
    failed++;
    console.log("  FAIL " + label + (detail ? " :: " + detail : ""));
  }
}

async function make(name, w, h, color) {
  const img = await Jimp.create(w, h, color);
  const p = path.join(dir, name);
  await new Promise((res, rej) => img.write(p, (e) => (e ? rej(e) : res())));
  return p;
}

const bmp = await make("big.bmp", 3000, 2000, 0x3388ffcc);
const tif = await make("small.tif", 200, 150, 0xff8844cc);
const png = await make("tiny.png", 64, 64, 0x2255ffcc);
const txt = path.join(dir, "note.txt");
await fsp.writeFile(txt, "not an image", "utf8");

console.log("sniff");
check("bmp", sniff(bmp) === "bmp", sniff(bmp));
check("tiff", sniff(tif) === "tiff", sniff(tif));
check("png", sniff(png) === "png", sniff(png));
check("txt", sniff(txt) === null, String(sniff(txt)));

console.log("unsupported -> supported (3000x2000 bmp)");
{
  const r = await rewrite({ path: bmp });
  check("converted", r.info.length === 1, JSON.stringify(r.info));
  const out = r.info[0]?.to;
  check("changed arg", r.args.path === out && out !== bmp);
  const img = await Jimp.read(out);
  check("longest side <= 2048", Math.max(img.bitmap.width, img.bitmap.height) <= 2048, img.bitmap.width + "x" + img.bitmap.height);
  check("smaller on disk", fs.statSync(out).size < fs.statSync(bmp).size, fs.statSync(out).size + " vs " + fs.statSync(bmp).size);
}

console.log("unsupported tiff keeps size");
{
  const r = await rewrite({ source_paths: [tif], prompt: "x" });
  check("converted nested array", r.info.length === 1);
  const img = await Jimp.read(r.args.source_paths[0]);
  check("dims preserved", img.bitmap.width === 200 && img.bitmap.height === 150, img.bitmap.width + "x" + img.bitmap.height);
  check("prompt untouched", r.args.prompt === "x");
}

console.log("supported + small: not touched");
{
  const r = await rewrite({ path: png });
  check("no conversion", r.info.length === 0 && r.args.path === png);
}

console.log("non-image: not touched");
{
  const r = await rewrite({ path: txt, other: "just text" });
  check("ignored", r.info.length === 0 && r.args.path === txt);
}

console.log("retry pass squeezes harder");
{
  const r = await rewrite({ path: bmp }, { maxSide: 1280, force: true });
  check("converted", r.info.length === 1);
  const img = await Jimp.read(r.info[0].to);
  check("longest side <= 1280", Math.max(img.bitmap.width, img.bitmap.height) <= 1280, img.bitmap.width + "x" + img.bitmap.height);
}

console.log("source files untouched");
{
  check("bmp intact", sniff(bmp) === "bmp", String(sniff(bmp)));
  check("png intact", sniff(png) === "png", String(sniff(png)));
}

console.log("apply() 挂上钩子并按需重试");
{
  const { apply } = await import("./lib/index.js");
  let handler = null;
  apply({ on: (ev, fn) => { if (ev === "tools/execute") handler = fn; } });
  check("registered tools/execute", typeof handler === "function");

  // 正常读：只跑一次，参数被换成能读的那张
  let calls = 0;
  const exec = { name: "read_image", argument: { path: bmp }, arguments: { path: bmp }, signal: undefined };
  const ok = await handler(exec, async () => { calls++; return { content: [] }; });
  check("single dispatch", calls === 1, "calls=" + calls);
  check("args swapped", exec.arguments.path !== bmp);
  check("result passthrough", ok && ok.content.length === 0);

  // 读崩了：再压一轮重试
  let calls2 = 0;
  const exec2 = { name: "read_image", argument: { path: bmp }, arguments: { path: bmp }, signal: undefined };
  const failed = await handler(exec2, async () => {
    calls2++;
    return calls2 === 1 ? { isError: true, content: [{ type: "text", text: "too big" }] } : { isError: false, content: [] };
  });
  check("retried once", calls2 === 2, "calls=" + calls2);
  check("retry recovered", failed.isError === false);

  // 非图片工具的报错不许重跑
  let calls3 = 0;
  const exec3 = { name: "pwsh", argument: { command: "x" }, arguments: { command: "x" }, signal: undefined };
  await handler(exec3, async () => { calls3++; return { isError: true, content: [] }; });
  check("non-read tool not retried", calls3 === 1, "calls=" + calls3);
}

await fsp.rm(dir, { recursive: true, force: true });
console.log(failed ? "FAILED " + failed : "all good");
process.exit(failed ? 1 : 0);
