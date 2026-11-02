import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { sniff, sniffHead, rewrite, loadJimp, convert, attachmentFile, fixUpload, apply, docKind, convertDocument, workspaceRoot } from "./lib/index.js";

/** 最小 docx 夹具：标题、正文、两个列表项、一张两行表格（stored zip）。 */
const DOCX_B64 =
  "UEsDBBQAAAAAAAAAAACRzx8FKQEAACkBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDw/eG1sIHZlcnNpb249IjEuMCI/PjxUeXBlcyB4bWxucz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3BhY2thZ2UvMjAwNi9jb250ZW50LXR5cGVzIj48RGVmYXVsdCBFeHRlbnNpb249InhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3dvcmQvZG9jdW1lbnQueG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LndvcmRwcm9jZXNzaW5nbWwuZG9jdW1lbnQubWFpbit4bWwiLz48L1R5cGVzPlBLAwQUAAAAAAAAAAAAL/zHevUCAAD1AgAAEQAAAHdvcmQvZG9jdW1lbnQueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pgo8dzpkb2N1bWVudCB4bWxuczp3PSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvd29yZHByb2Nlc3NpbmdtbC8yMDA2L21haW4iPjx3OmJvZHk+Cjx3OnA+PHc6cFByPjx3OnBTdHlsZSB3OnZhbD0iSGVhZGluZzEiLz48L3c6cFByPjx3OnI+PHc6dD7lraPluqbmiqXlkYo8L3c6dD48L3c6cj48L3c6cD4KPHc6cD48dzpyPjx3OnQ+6L+Z5piv56ys5LiA5q615q2j5paH44CCPC93OnQ+PC93OnI+PC93OnA+Cjx3OnA+PHc6cFByPjx3Om51bVByPjx3Omlsdmwgdzp2YWw9IjAiLz48L3c6bnVtUHI+PC93OnBQcj48dzpyPjx3OnQ+6KaB54K55LiAPC93OnQ+PC93OnI+PC93OnA+Cjx3OnA+PHc6cFByPjx3Om51bVByPjx3Omlsdmwgdzp2YWw9IjAiLz48L3c6bnVtUHI+PC93OnBQcj48dzpyPjx3OnQ+6KaB54K55LqMPC93OnQ+PC93OnI+PC93OnA+Cjx3OnRibD48dzp0cj48dzp0Yz48dzpwPjx3OnI+PHc6dD7ln47luII8L3c6dD48L3c6cj48L3c6cD48L3c6dGM+PHc6dGM+PHc6cD48dzpyPjx3OnQ+6ZSA6YePPC93OnQ+PC93OnI+PC93OnA+PC93OnRjPjwvdzp0cj4KPHc6dHI+PHc6dGM+PHc6cD48dzpyPjx3OnQ+5YyX5LqsPC93OnQ+PC93OnI+PC93OnA+PC93OnRjPjx3OnRjPjx3OnA+PHc6cj48dzp0PjEyODwvdzp0PjwvdzpyPjwvdzpwPjwvdzp0Yz48L3c6dHI+PC93OnRibD4KPC93OmJvZHk+PC93OmRvY3VtZW50PlBLAQIUABQAAAAAAAAAAACRzx8FKQEAACkBAAATAAAAAAAAAAAAAAAAAAAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQAFAAAAAAAAAAAAC/8x3r1AgAA9QIAABEAAAAAAAAAAAAAAAAAWgEAAHdvcmQvZG9jdW1lbnQueG1sUEsFBgAAAAACAAIAgAAAAH4EAAAAAA==";

const Jimp = loadJimp();
const dir = path.join(os.tmpdir(), "dac-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const at = (n) => path.join(dir, n);
/** 产物目录：会话工作区下的 .dsh-convert。 */
const outDir = path.join(dir, ".dsh-convert");
const O = { outDir };
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

console.log("产物落在工作区的 .dsh-convert 里");
{
  const { args } = await rewrite({ path: bigPng }, O);
  assert.equal(path.dirname(args.path), outDir, "产物目录是 <工作区>/.dsh-convert");
  assert.ok(fs.existsSync(outDir));
}

console.log("big png -> shrunk, 名字带 _small");
{
  const { args, info } = await rewrite({ path: bigPng }, O);
  assert.equal(info.length, 1);
  assert.notEqual(args.path, bigPng);
  assert.equal(args.path, path.join(outDir, "big_small.jpg"), "降分辨率叫 源文件名_small（不透明就走 JPG）");
  assert.ok((await side(args.path)) <= 2048, "长边 <= 2048");
  assert.ok(info[0].outBytes > 0);
}

console.log("big jpeg -> shrunk");
{
  const { args, info } = await rewrite({ path: bigJpg }, O);
  assert.equal(info.length, 1);
  assert.equal(args.path, path.join(outDir, "big_small.jpg"), "无 alpha 走 JPG");
  assert.ok((await side(args.path)) <= 2048);
}

console.log("small png: untouched");
{
  const { args, info } = await rewrite({ path: smallPng }, O);
  assert.equal(info.length, 0);
  assert.equal(args.path, smallPng);
}

console.log("unsupported format -> png");
{
  const { args, info } = await rewrite({ path: bmp }, O);
  assert.equal(info.length, 1);
  assert.equal(sniff(args.path), "png", "BMP 转成 PNG");
  assert.equal(args.path, path.join(outDir, "pic_small.png"), "又转格式又缩，也叫 _small");
  assert.ok((await side(args.path)) <= 2048, "转换时顺带降采样");
}
{
  const { args, info } = await rewrite({ path: tiff }, O);
  assert.equal(info.length, 1, "TIFF 也要转");
  assert.equal(sniff(args.path), "png");
  assert.equal(args.path, path.join(outDir, "pic.png"), "只换格式就沿用原文件名");
  assert.equal(await side(args.path), 800, "没超标就只换格式、不缩");
}

console.log("non-image: untouched");
{
  for (const f of [txt, at("nope.png")]) {
    const { args, info } = await rewrite({ path: f }, O);
    assert.equal(info.length, 0, f);
    assert.equal(args.path, f);
  }
}

console.log("nested args rewritten, prompt untouched");
{
  const prompt = "参考 " + bigPng + " 的构图，画成水彩";
  const args = { prompt, source_paths: [smallPng, bigPng] };
  const r = await rewrite(args, O);
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

  const r = await rewrite({ attachmentIds: [id], prompt: "看看她" }, { ...O, attachmentsRoot: store });
  assert.equal(r.info.length, 1);
  assert.equal(r.info[0].from, obj);
  assert.equal(r.args.attachmentIds, undefined, "id 换成路径后不再传 id");
  assert.equal(r.args.prompt, "看看她");
  assert.equal(path.dirname(r.args.paths[0]), outDir);
  assert.ok((await side(r.args.paths[0])) <= 2048, "附件也按长边压");
  // 带了原文件名就用原文件名，不再拿 sha 当名字
  const named = await rewrite({ attachmentIds: [id], attachmentNames: ["snap.png"] }, { ...O, attachmentsRoot: store });
  assert.equal(named.args.paths[0], path.join(outDir, "snap_small.jpg"));

  const missing = await rewrite({ attachmentIds: ["sha256:" + "cd".repeat(32)] }, O);
  assert.deepEqual(missing.args, { attachmentIds: ["sha256:" + "cd".repeat(32)] }, "落不了地的 id 原样放行");
}

console.log("force squeezes to retry side");
{
  const out = await convert(bigPng, { maxSide: 1280, force: true, outDir });
  assert.ok(out);
  assert.equal(out, path.join(outDir, "big_small.jpg"), "重试覆盖同一份 _small 产物");
  assert.ok((await side(out)) <= 1280, "重试档长边 <= 1280");
}

console.log("source files untouched");
{
  const files = [bigPng, smallPng, bigJpg, bmp];
  const before = files.map((f) => fs.statSync(f).size);
  await rewrite(files, O);
  assert.deepEqual(files.map((f) => fs.statSync(f).size), before, "原图一个字节都不动");
}

console.log("workspaceRoot 认会话 cwd，其次问 registry");
{
  assert.equal(workspaceRoot({}, { agent: { session: { header: { cwd: dir } } } }), dir, "会话 cwd 优先");
  const reg = { list: () => [{ path: path.join(dir, "ws"), sessionIds: ["s1"] }] };
  const ctx = { get: (n) => (n === "workspaceRegistry" ? reg : undefined) };
  assert.equal(workspaceRoot(ctx, { agent: { id: "s1" } }), path.join(dir, "ws"), "按会话找所属工作区");
  const bare = workspaceRoot({}, { agent: { id: "zzz" } });
  assert.equal(bare, process.cwd(), "都认不出就退回进程 cwd");
}

console.log("apply() 挂上钩子并按需重试");
{
  let handler;
  const ctx = { on: (ev, fn) => { if (ev === "tools/execute") handler = fn; } };
  const { apply } = await import("./lib/index.js");
  apply(ctx);
  assert.ok(handler, "注册了 tools/execute");
  const exec = (name, args) => ({ name, arguments: args, agent: { session: { header: { cwd: dir } } } });

  {
    let calls = 0;
    const result = await handler(exec("read_image", { path: bigPng }), async () => {
      calls++;
      return { ok: true };
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 1, "成功时不重试");
  }

  {
    let calls = 0;
    const seen = [];
    const result = await handler(exec("read_image", { path: bigPng }), async () => {
      calls++;
      return calls === 1 ? { isError: true } : { ok: "retry recovered" };
    });
    assert.equal(calls, 2, "retried once");
    assert.equal(result.ok, "retry recovered");
  }

  {
    // 重试要把结果压到 1280 覆盖同一份 _small 产物
    const first = await handler(exec("read_image", { path: bigJpg }), async () => ({ isError: true }));
    assert.ok(first.isError);
    const out = path.join(dir, ".dsh-convert", "big_small.jpg");
    assert.ok(fs.existsSync(out), "重试产物写在工作区里");
    assert.ok((await side(out)) <= 1280, "重试档真的更小");
  }

  {
    let calls = 0;
    await handler(exec("pwsh", { path: bigPng }), async () => {
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

console.log("文档：docx/csv/html 换成 Markdown 再交出去");
{
  // 最小 docx（stored zip）当夹具：标题、正文、列表、表格各一段
  const docx = at("report.docx");
  fs.writeFileSync(docx, Buffer.from(DOCX_B64, "base64"));
  assert.equal(docKind(docx), "zip", "OOXML 先从字节认成 zip，再看目录");
  const doc = await convertDocument(docx, O);
  assert.ok(doc, "能转出内容");
  assert.equal(doc.kind, "docx", "解开 zip 后是 docx");
  assert.equal(doc.out, path.join(outDir, "report.md"), "文档沿用原文件名");
  const md = fs.readFileSync(doc.out, "utf8");
  assert.match(md, /# 季度报告/, "标题层级保留");
  assert.match(md, /- 要点一/, "列表保留");
  assert.match(md, /\| 城市 \| 销量 \|/, "表格转成管道表格");
  assert.match(md, /源文件：report\.docx（docx）/, "产物头部标了来源");

  const again = await convertDocument(docx, O);
  assert.equal(again.out, doc.out, "同一份文档只转一次（缓存命中）");
  assert.equal(again.kind, "docx", "缓存命中也能报对类型");

  const r = await rewrite({ file_path: docx }, O);
  assert.equal(r.info.length, 1);
  assert.equal(r.info[0].doc, true);
  assert.equal(r.args.file_path, doc.out, "交给 read 的已经是 md");
  assert.notEqual(r.args.file_path, docx);

  const asImage = await rewrite({ path: docx }, { ...O, imageTool: true });
  assert.equal(asImage.args.path, docx, "读图工具不该收到 md");

  const asWriter = await rewrite({ file_path: docx }, { ...O, toolName: "write" });
  assert.equal(asWriter.args.file_path, docx, "写入类工具拿到原路径，不能被换成 md");
  const asRead = await rewrite({ file_path: docx }, { ...O, toolName: "read" });
  assert.equal(asRead.args.file_path, doc.out, "read 才换 md");

  const csv = at("t.csv");
  fs.writeFileSync(csv, "a,b\n1,2\n3,4\n");
  const csvR = await rewrite({ file_path: csv }, O);
  assert.equal(csvR.args.file_path, path.join(outDir, "t.md"));
  const csvMd = fs.readFileSync(csvR.args.file_path, "utf8");
  assert.match(csvMd, /\| a \| b \|/, "CSV 转成表格");
  assert.match(csvMd, /\| 3 \| 4 \|/);

  const html = at("t.html");
  fs.writeFileSync(html, "<h2>小节</h2><p>正文</p><ul><li>一</li></ul>");
  const htmlR = await rewrite({ file_path: html }, O);
  const htmlMd = fs.readFileSync(htmlR.args.file_path, "utf8");
  assert.match(htmlMd, /## 小节/, "HTML 标题");
  assert.match(htmlMd, /- 一/, "HTML 列表");

  const bin = at("blob.bin");
  fs.writeFileSync(bin, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]));
  const binR = await rewrite({ file_path: bin }, O);
  assert.equal(binR.args.file_path, bin, "认不出的二进制原样放行");

  // 以 < 开头的 markdown / 文本不是 HTML，别顺手转一遍
  const mdDoc = at("NOTES.md");
  fs.writeFileSync(mdDoc, '<div align="center">\n\n# 标题\n\n正文\n');
  assert.equal(docKind(mdDoc), null, ".md 不进文档白名单");
  const mdR = await rewrite({ file_path: mdDoc }, O);
  assert.equal(mdR.args.file_path, mdDoc, "markdown 原样交给 read");
}

fs.rmSync(dir, { recursive: true, force: true });
console.log("all good");