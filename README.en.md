<div align="center">

# dsh-auto-convert

**Make DeepSeek Harness able to read what you drop in — before the tool touches it**

[![License](https://img.shields.io/badge/license-MIT-4D6BFE)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%E2%89%A50.2.0-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)

</div>

A host plugin for DeepSeek Harness. It adds no commands and asks for no new habits: drop a screenshot, a phone photo, a Word report, an Excel sheet, a slide deck or a PDF straight into the conversation. Oversized images get downscaled, unreadable image formats get re-encoded, and Office/PDF documents are turned into Markdown — all **before** `read_image`, `vision_*` or `read` ever sees the file.

## Supported conversions

### Images

| Input | When it acts | Output |
| --- | --- | --- |
| PNG / JPEG / GIF / WebP | longer edge > **2048 px** or size > **8 MB** | downscaled to 2048 px: no alpha → JPEG (q88), alpha → PNG |
| BMP / TIFF | **always** (the read tool refuses them) | PNG |
| HEIC / AVIF / PSD / RAW / SVG | never | passed through untouched |
| already-compliant images | never | original file, no re-encode, no copy |

A mislabeled upload (a WebP named `.png`, the usual `IMAGE_TYPE_MISMATCH`) is fixed by **relabeling only** — not a byte is rewritten.

### Documents

| Input | Output | Kept |
| --- | --- | --- |
| `.docx` | Markdown | heading levels, paragraphs, lists, tables |
| `.xlsx` | Markdown | one pipe table per worksheet, in workbook order |
| `.pptx` | Markdown | one `##` per slide, slide text and tables |
| `.pdf` (with a text layer) | Markdown | body text, line by line |
| `.csv` / `.tsv` | Markdown | pipe table |
| `.html` / `.htm` | Markdown | headings, lists, links, emphasis, tables |
| `.doc` / `.xls` / `.ppt`, scanned PDFs | untouched | legacy binaries need Office/LibreOffice, scans need OCR |

> Only text and structure are carried over. Images, charts and formulas inside a document are not extracted.

## How it works

1. **Hooked on the host `tools/execute` around-hook**, not on a single tool: images are prepared for `read_image`, `vision_*` and `read`, while documents are swapped only for `read` (`write`, `pwsh` and friends still receive the original path). The tool never learns that the file was swapped.
2. **Formats are detected from bytes**, not extensions — a renamed image is still recognized. Unknown bytes are passed through instead of guessed at.
3. **Every absolute path in the arguments is rewritten** (5 levels deep, at most 8 files); `sha256:…` attachment ids are resolved to real files first.
4. **Downscaling** uses the `jimp` already installed in the profile and keeps the aspect ratio. Products go into **`<workspace>/.dsh-convert/`** and keep the source name: a pure format change keeps the original stem (`pic.bmp` → `pic.png`), a downscale appends `_small` (`photo.jpg` → `photo_small.jpg`).
5. **Document conversion has no dependencies**: OOXML is just a zip, unpacked with `node:zlib` and read from `document.xml` / `sheet*.xml` / `slide*.xml`; PDFs are reduced to their text layer, with ToUnicode CMaps parsed when fonts are CID-keyed. No network, no Python, no Office.
6. **One automatic retry within the same turn**: if a downscaled image is still too large for `read_image` / `vision_*`, it is squeezed to 1280 px and run once more. Documents are never retried.
7. **The upload gate is wrapped too**: media type is checked against the actual bytes before admission.

## Install

> Requires DeepSeek Harness `0.2.0` or newer. No build step — install and restart once.

```text
https://github.com/yimengsuper2432/dsh-auto-convert.git
```

or:

```bash
dsh plugin --profile desktop add github:yimengsuper2432/dsh-auto-convert
```

No configuration, no settings page — the plugin is on by default.

## Tuning

Edit the constants at the top of `lib/index.js` (`MAX_SIDE`, `MAX_BYTES`, `RETRY_SIDE`, `SUPPORTED`, `CONVERTIBLE`, `DOC_EXT`) and `MAX_MD` / `MAX_ROWS` in `lib/docs.js`.

## Known limits

- **Animated GIFs lose all but the first frame** once downscaled (jimp reads one frame); untouched GIFs stay intact.
- **HEIC / AVIF are still unreadable** — they need `sharp` or `libheif`, which are not bundled.
- **Renamed WebP is only relabeled**, never transcoded.
- **Scanned PDFs are not OCR'd** — no text layer means the original file is passed through.
- **Legacy Office binaries (.doc/.xls/.ppt) are not supported** — OLE2 needs a real converter.
- **Text and structure only**: embedded images and formulas are skipped.
- **Same-named files share one product**: two `report.docx` in different folders both map to `.dsh-convert/report.md` and the later conversion wins. Add `<workspace>/.dsh-convert/` to your project's `.gitignore`.
- **Products stay with the workspace and are never cleaned up proactively**: downscaled images and Markdown copies live in `<workspace>/.dsh-convert/`; delete the folder if you do not want them, it is regenerated next time.

## Development

```bash
node test.mjs   # prints "all good"
```

## License

[MIT](LICENSE)