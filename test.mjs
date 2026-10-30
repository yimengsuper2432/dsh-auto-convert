import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { sniff, rewrite, loadJimp, convert } from "./lib/index.js";

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
// 不支持的格式：真 BMP，但读图工具本来就不吃，插件应该完全不碰
const bmp = at("pic.bmp");
await write(bmp, new Jimp(3000, 2000, 0x0000ffff));
const txt = at("note.txt");
fs.writeFileSync(txt, "hello");
const fakeGif = at("a.gif");
fs.writeFileSync(fakeGif, Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(20)]));
const fakeWebp = at("a.webp");
fs.writeFileSync(fakeWebp, Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(8)]));

const side = (f) => {
  const img = new Jimp(f);
  return Math.max(img.bitmap.width, img.bitmap.height);
};

console.log("sniff");
assert.equal(sniff(bigPng), "png");
assert.equal(sniff(bigJpg), "jpeg");
assert.equal(sniff(fakeGif), "gif");
assert.equal(sniff(fakeWebp), "webp");
assert.equal(sniff(txt), null);
assert.equal(sniff(bmp), null, "BMP 不再被识别——不做格式转换");

console.log("big png -> shrunk");
{
  const { args, info } = await rewrite({ path: bigPng });
  assert.equal(info.length, 1);
  assert.notEqual(args.path, bigPng);
  assert.ok(args.path.startsWith(os.tmpdir()), "产物落在临时目录");
  assert.ok(side(args.path) <= 2048, "长边 <= 2048");
  assert.ok(info[0].outBytes > 0);
  // 纯色图压到 2048 后字节未必更小，但长边降下来才是关键
}

console.log("big jpeg -> shrunk");
{
  const { args, info } = await rewrite({ path: bigJpg });
  assert.equal(info.length, 1);
  assert.ok(side(args.path) <= 2048);
}

console.log("small png: untouched");
{
  const { args, info } = await rewrite({ path: smallPng });
  assert.equal(info.length, 0);
  assert.equal(args.path, smallPng);
}

console.log("unsupported / non-image: untouched");
{
  for (const f of [bmp, txt, at("nope.png")]) {
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

console.log("force squeezes to retry side");
{
  const out = await convert(bigPng, { maxSide: 1280, force: true });
  assert.ok(out);
  assert.ok(side(out) <= 1280, "重试档长边 <= 1280");
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

fs.rmSync(dir, { recursive: true, force: true });
console.log("all good");
