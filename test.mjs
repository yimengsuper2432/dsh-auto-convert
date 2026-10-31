import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { sniff, sniffHead, rewrite, loadJimp, convert, attachmentFile, fixUpload, apply } from "./lib/index.js";

const Jimp = loadJimp();
const dir = path.join(os.tmpdir(), "dac-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const at = (n) => path.join(dir, n);
const write = (file, img) => new Promise((res, rej) => img.write(file, (e) => (e ? rej(e) : res())));

// 3000x2000 纯色 PNG：字节很小但长边超标，只有真解码才看得出来
const bigPng = at("big.png");
await write(bigPng, new Jimp(3000, 2000, 0x3366ffff));
const smallPng = at("small.png");
await write(smallPng, new Jimp(200, 150, 0xff0000ff));
const bigJpg = at("big.jpg");
await write(bigJpg, new Jimp(2600, 1800, 0x00ff00ff));
// 不支持的格式：真 BMP，读图工具不吃，插件该转成 PNG；尺寸超标就顺带缩
const bmp = at("pic.bmp");
await write(bmp, new Jimp(3000, 2000, 0x0000ffff));
// 小尺寸 TIFF：没超标，只是格式不支持，应该只换格式不缩
const tiff = at("pic.tiff");
await write(tiff, new Jimp(800, 600, 0x123456ff));
const txt = at("note.txt");
fs.writeFileSync(txt, "hello");
const fakeGif = at("a.gif");
fs.writeFileSync(fakeGif, Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(20)]));
const fakeWebp = at("a.webp");
fs.writeFileSync(fakeWebp, Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(8)]));

const side = async (f) => {
  const img = await Jimp.read(f);
  return Math.max(img.bitmap.width, img.bitmap.height);
};

console.log("sniff");
assert.equal(sniff(bigPng), "png");
assert.equal(sniff(bigJpg), "jpeg");
assert.equal(sniff(fakeGif), "gif");
assert.equal(sniff(fakeWebp), "webp");
assert.equal(sniff(txt), null);
assert.equal(sniff(bmp), "bmp");
assert.equal(sniff(tiff), "tiff");

console.log("big png -> shrunk");
{
  const { args, info } = await rewrite({ path: bigPng });
  assert.equal(info.length, 1);
  assert.notEqual(args.path, bigPng);
  assert.ok(args.path.startsWith(os.tmpdir()), "产物落在临时目录");
  assert.ok((await side(args.path)) <= 2048, "长边 <= 2048");
  assert.ok(info[0].outBytes > 0);
  // 纯色图压到 2048 后字节未必更小，但长边降下来才是关键
}

console.log("big jpeg -> shrunk");
{
  const { args, info } = await rewrite({ path: bigJpg });
  assert.equal(info.length, 1);
  assert.ok((await side(args.path)) <= 2048);
}

console.log("small png: untouched");
{
  const { args, info } = await rewrite({ path: smallPng });
  assert.equal(info.length, 0);
  assert.equal(args.path, smallPng);
}

console.log("unsupported format -> png");
{
  const { args, info } = await rewrite({ path: bmp });
  assert.equal(info.length, 1);
  assert.equal(sniff(args.path), "png", "BMP 转成 PNG");
  assert.ok(args.path.endsWith(".png"));
  assert.ok((await side(args.path)) <= 2048, "转换时顺带降采样");
}
{
  const { args, info } = await rewrite({ path: tiff });
  assert.equal(info.length, 1, "TIFF 也要转");
  assert.equal(sniff(args.path), "png");
  assert.equal(await side(args.path), 800, "没超标就只换格式、不缩");
}

console.log("non-image: untouched");
{
  for (const f of [txt, at("nope.png")]) {
    const { args, info } = await rewrite({ path: f });
    assert.equal(info.length, 0, f);
    assert.equal(args.path, f);
  }
}

console.log("nested args rewritten, prompt untouched");
{
  const prompt = "参考 " + bigPng + " 的构图，画成水彩";
  const args = { prompt, source_paths: [smallPng, bigPng] };
  const r = await rewrite(args);
  assert.equal(r.args.prompt, prompt, "提示词里的句子不该被当路径");
  assert.equal(r.args.source_paths[0], smallPng);
  assert.notEqual(r.args.source_paths[1], bigPng);
  assert.equal(r.info.length, 1);
}

console.log("attachment id -> local file -> shrunk path");
{
  const hex = "ab".repeat(32);
  const store = path.join(dir, "store");
  fs.mkdirSync(path.join(store, hex.slice(0, 2)), { recursive: true });
  const obj = path.join(store, hex.slice(0, 2), hex);
  fs.copyFileSync(bigPng, obj);
  const id = "sha256:" + hex;

  assert.equal(attachmentFile(id, store), obj, "id 能落到对象文件");
  assert.equal(attachmentFile("sha256:" + "cd".repeat(32), store), null, "缺的对象不报错只返回 null");
  assert.equal(attachmentFile("nope", store), null);

  const r = await rewrite({ attachmentIds: [id], prompt: "看看她" }, { attachmentsRoot: store });
  assert.equal(r.info.length, 1);
  assert.equal(r.info[0].from, obj);
  assert.equal(r.args.attachmentIds, undefined, "id 换成路径后不再传 id");
  assert.equal(r.args.prompt, "看看她");
  assert.ok((await side(r.args.paths[0])) <= 2048, "附件也按长边压");

  const missing = await rewrite({ attachmentIds: ["sha256:" + "cd".repeat(32)] }, { attachmentsRoot: store });
  assert.deepEqual(missing.args, { attachmentIds: ["sha256:" + "cd".repeat(32)] }, "落不了地的 id 原样放行");
}

console.log("force squeezes to retry side");
{
  const out = await convert(bigPng, { maxSide: 1280, force: true });
  assert.ok(out);
  assert.ok((await side(out)) <= 1280, "重试档长边 <= 1280");
}

console.log("source files untouched");
{
  const files = [bigPng, smallPng, bigJpg, bmp];
  const before = files.map((f) => fs.statSync(f).size);
  await rewrite(files);
  assert.deepEqual(files.map((f) => fs.statSync(f).size), before, "原图一个字节都不动");
}

console.log("apply() 挂上钩子并按需重试");
{
  let handler;
  const ctx = { on: (ev, fn) => { if (ev === "tools/execute") handler = fn; } };
  const { apply } = await import("./lib/index.js");
  apply(ctx);
  assert.ok(handler, "注册了 tools/execute");

  {
    let calls = 0;
    const result = await handler({ name: "read_image", arguments: { path: bigPng } }, async () => {
      calls++;
      return { ok: true };
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 1, "成功时不重试");
  }

  {
    let calls = 0;
    const result = await handler({ name: "read_image", arguments: { path: bigPng } }, async () => {
      calls++;
      return calls === 1 ? { isError: true } : { ok: "retry recovered" };
    });
    assert.equal(calls, 2, "retried once");
    assert.equal(result.ok, "retry recovered");
  }

  {
    let calls = 0;
    await handler({ name: "pwsh", arguments: { path: bigPng } }, async () => {
      calls++;
      return { isError: true };
    });
    assert.equal(calls, 1, "non-read tool not retried");
  }
}

console.log("上传入库前把类型弄对");
{
  const pngBuf = fs.readFileSync(bigPng);
  const input = { data: pngBuf, mediaType: "image/webp", name: "card_788_trained.png" };
  const dirty = await fixUpload(input);
  assert.equal(dirty.mediaType, "image/png", "名字装错的按真实字节改标签");
  assert.equal(dirty.data, pngBuf, "只改标签，字节一个不动");

  const clean = { data: pngBuf, mediaType: "image/png" };
  assert.equal(await fixUpload(clean), clean, "对得上就原样返回");

  const toPng = await fixUpload({ data: fs.readFileSync(bmp), mediaType: "image/bmp" });
  assert.equal(toPng.mediaType, "image/png", "BMP 转 PNG");
  assert.equal(sniffHead(toPng.data), "png", "转出来真是 PNG");

  const junk = { data: Buffer.from("hello"), mediaType: "image/png" };
  assert.equal(await fixUpload(junk), junk, "不是图就不碰");
}

console.log("附件服务的入库口被包住");
{
  const store = {
    seen: null,
    async saveImages(inputs) {
      this.seen = inputs;
      return inputs.map((_, i) => "ref" + i);
    },
    async saveImage(input) {
      this.seen = input;
      return "ref";
    },
  };
  const ctx = { on: () => {}, get: (n) => (n === "attachments" ? store : undefined) };
  apply(ctx);
  const refs = await store.saveImages([{ data: fs.readFileSync(bigPng), mediaType: "image/webp" }]);
  assert.deepEqual(refs, ["ref0"]);
  assert.equal(store.seen[0].mediaType, "image/png", "批量入库前就改好了");
  await store.saveImage({ data: fs.readFileSync(bmp), mediaType: "image/bmp" });
  assert.equal(store.seen.mediaType, "image/png", "单张入库前也转好了");
}

fs.rmSync(dir, { recursive: true, force: true });
console.log("all good");
