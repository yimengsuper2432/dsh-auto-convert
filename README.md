# dsh-auto-convert

高分辨率图在读之前自动换成低分辨率副本，省掉「图太大读不了 → 再来一轮」这一步。

## 它做什么

挂宿主 `tools/execute` 环绕钩子（`read_image`、`vision_*`、`run_code` 里的子调用都走这条路）：

1. 参数里的本地图片长边超过 2048px，或体积超过 8MB → 先用 jimp 压一档，工具拿到的是能读的小图。
2. 格式不支持（BMP / TIFF）→ 直接转成 PNG；尺寸也超标的话顺带压到 2048px。
3. 聊天里上传的图（参数是 `attachmentIds` / `attachmentId` 的 `sha256:...`）先到 `~/.dsh/attachments/v1/objects` 里落地成文件，再按第 1、2 条处理，处理完换成路径交给工具；落不了地的 id 原样放行。
4. 换完还是读不出来（工具报错）→ 自动压到 1280px 再试一次，同一轮里解决。
5. 其余一律不动：本来就读得下的图、非图片文件、jimp 解不开的格式（HEIC / AVIF / PDF / PSD / RAW / SVG …）原样放行，让工具报它自己的错。

产物放在系统临时目录，按「源文件 + mtime + 目标长边 + 输出格式」缓存，同一张图只转一次；原图一个字节都不改。

## 依赖

复用 profile 里已装的 `jimp`（`~/.dsh/profiles/*/node_modules/jimp`），不需要额外安装。

## 已知天花板

- 超大 GIF 会被压成单帧静态图（jimp 只读第一帧），要保动画得换 ffmpeg。
- 临时产物不主动清理，靠操作系统回收。
- 转格式只覆盖 jimp 解得开的 BMP / TIFF；HEIC / AVIF 需要 libheif 或 sharp，本机没装，原样放行。

## 自检

```
node test.mjs
```

`all good` 即通过。
