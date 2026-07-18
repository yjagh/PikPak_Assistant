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

## 致谢 / Credits

原脚本作者 / Original author: [poihoii](https://github.com/poihoii) — [PikPak_FileManager](https://github.com/poihoii/PikPak_FileManager)

## License

MIT — see [LICENSE](LICENSE).
