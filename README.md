# dsh-auto-convert

高分辨率图在读之前自动换成低分辨率副本，省掉「图太大读不了 → 再来一轮」这一步。

## 它做什么

挂宿主 `tools/execute` 环绕钩子（`read_image`、`vision_*`、`run_code` 里的子调用都走这条路）：

1. 参数里的本地图片长边超过 2048px，或体积超过 8MB → 先用 jimp 压一档，工具拿到的是能读的小图。
2. 换完还是读不出来（工具报错）→ 自动压到 1280px 再试一次，同一轮里解决。
3. 其余一律不动：本来就读得下的图、非图片文件、不支持的格式（BMP / TIFF / HEIC / AVIF / PDF / PSD / RAW / SVG …）原样放行，让工具报它自己的错。

产物放在系统临时目录，按「源文件 + mtime + 目标长边」缓存，同一张图只压一次；原图一个字节都不改。

## 依赖

复用 profile 里已装的 `jimp`（`~/.dsh/profiles/*/node_modules/jimp`），不需要额外安装。

## 已知天花板

- 超大 GIF 会被压成单帧静态图（jimp 只读第一帧），要保动画得换 ffmpeg。
- 临时产物不主动清理，靠操作系统回收。
- 只处理读图工具本来就支持的 png / jpeg / gif / webp；其它格式不做转换。

## 自检

```
node test.mjs
```

`all good` 即通过。
