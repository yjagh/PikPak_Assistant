# PikPak Assistant / PikPak 助手

基于 [poihoii/PikPak_FileManager](https://github.com/poihoii/PikPak_FileManager)（MIT License）官方 2.x 版本的个人整合修改版 Tampermonkey 脚本。

A personal merged fork of [poihoii/PikPak_FileManager](https://github.com/poihoii/PikPak_FileManager) (MIT License), based on the official 2.x line.

## 相比官方版本的改动 / Changes vs. upstream

- **更稳的分批删除**：每批 100 个文件，遇 429 限流自动等待重试同一批，支持中途取消，结束显示成功/失败统计
- **复制资源链接**：批量获取选中项的原始资源链接（`params.url`），去重后复制到剪贴板
- **按目录树选择**：导入目录树 TXT 文件（支持 UTF-8/UTF-16），按文件名匹配自动选中当前列表中的对应项
- **重复检测增强**：检测范围含视频和图片；结果可按匹配类型（哈希/文件名/相似）筛选；扫描结果缓存，切换筛选不重扫；同类型归组
- **路径显示**：结构平面化和全局搜索结果中，文件名下方显示所在子目录路径

- **Robust chunked delete**: 100 files per batch, auto-retry on HTTP 429, cancellable, success/failure summary
- **Copy resource links**: batch-fetch original resource links (`params.url`) of selected items, dedupe, copy to clipboard
- **Select from directory tree**: import a directory-tree TXT file (UTF-8/UTF-16) and auto-select matching items by filename
- **Enhanced duplicate scan**: covers videos and images; filter results by match type (hash/name/similar); cached scan results (instant filter switching); same-type grouping
- **Path display**: flatten view and global search show each file's subfolder path under its name

## 安装 / Install

安装 [Tampermonkey](https://www.tampermonkey.net/)，然后点击安装 [`PikPak_Assistant.user.js`](PikPak_Assistant.user.js)。

Install [Tampermonkey](https://www.tampermonkey.net/), then install [`PikPak_Assistant.user.js`](PikPak_Assistant.user.js).

## 开发 / 构建 (Development)

源码已模块化,放在 `src/`,用 [esbuild](https://esbuild.github.io/) 打包成单个 `.user.js`:

```
src/
  meta.txt      UserScript 头 (header banner)
  styles.css    样式 (CSS)
  i18n.js       四语言词典 (ko/en/ja/zh)
  config.js     CONF 配置 + 图标 SVG
  utils.js      工具函数 (esc / fmt* / sleep / gmGet / gmSet)
  api.js        PikPak API 封装 (pkFetch / apiList / ...)
  main.js       核心逻辑 (状态 / UI / 渲染 / openManager / 播放器 / 注入)
```

改代码后重新构建:

```bash
npm install      # 首次:安装 esbuild (devDependency)
npm run build    # 打包 src/ → PikPak_Assistant.user.js
```

`PikPak_Assistant.user.js` 是**构建产物**(已提交,供 Greasyfork 同步)。不要直接手改产物——改 `src/` 后 `npm run build`。

> 注:`main.js` 仍是一个较大的核心模块(状态/UI/播放器/事件都在里面)。进一步把播放器、渲染层拆成独立模块(重构 B/E)是可选的后续工作,风险较高,建议在能对着真实 PikPak 逐步验证的条件下做。

The source is modularized under `src/` and bundled into a single `.user.js` with esbuild. Edit `src/`, then `npm run build`. `PikPak_Assistant.user.js` is the committed build artifact (synced by Greasyfork) — don't hand-edit it.

## 致谢 / Credits

原脚本作者 / Original author: [poihoii](https://github.com/poihoii) — [PikPak_FileManager](https://github.com/poihoii/PikPak_FileManager)

## License

MIT — see [LICENSE](LICENSE).
