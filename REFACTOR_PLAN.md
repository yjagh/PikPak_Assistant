# 重构进度与后续方案 (Refactor status & next steps)

分支 `refactor/modularize`。目标:把单文件工程化 + 解耦 openManager 巨型闭包。

## 已完成 (可静态验证,理论等价 v2.4.3,未经真实 PikPak 实测)

- **C 工程化**:esbuild 构建管线(`build.mjs` / `package.json`),源码拆成
  `src/{meta.txt, styles.css, i18n.js, config.js, utils.js, api.js, main.js}`。
- **B 播放器模块**:
  - step 1 — `playVideo`(461 行)从 openManager 闭包剥离到模块级。
  - step 2 — `playVideo` + HLS/字幕清理(`_currentHls` / `destroyHls` /
    `_subBlobUrls` / `revokeSubBlobs`)+ 加载态 helper(`setLoad` /
    `updateLoadTxt`)整体移到 **`src/player.js`**。
- **E 渲染层(仅低风险半步)**:虚拟列表/网格渲染器
  (`render` / `renderList` / `renderVisibleList` / `renderGrid` /
  `renderVisibleGrid` + `_gridCache` / `_lastListRange` / `_scrollPending` +
  `getIcon` / `applyDragDrop` / `initScrollHandler`)整簇搬到 **`src/render.js`**。
  **纯搬迁,渲染逻辑一行未改。**

三次抽离都用同一套机械搬迁 + 校验流程,每次结果一致:
1. node 脚本按边界断言精确切片,内容匹配加 `export`、行号范围删除;
2. `npm run build`(esbuild 解析循环依赖 + 校验每个 import 都有对应 export,0 警告);
3. `node --check` 两个源文件 + 产物;
4. **stub 加载测试**:mock window/document/GM_* 在 Node 里跑完整个 IIFE,
   证明模块初始化顺序(含 main↔player、main↔render 两组循环依赖)不抛异常;
5. **排序等价 diff**:重构前后 bundle 排序后逐行对比,差异仅
   esbuild 的 `// src/xxx.js` 边界注释 + 一个空行 —— 每行代码逐字节相同。

循环依赖为何安全:player/render 对 main 的所有引用都在**调用时**(openManager
打开、handlers 设好之后),模块-init 时不触碰任何 main 绑定;`S`/`_h` 用
`export let`(live binding)、`UI` 用 `export const`(对象被 openManager 填充),
esbuild 把三方扁平化进一个 IIFE 作用域,无 TDZ。

当前 `src/`:`main.js`(2486) / `player.js`(496) / `render.js`(212) /
`api.js` / `utils.js` / `config.js` / `i18n.js` / `styles.css` / `meta.txt`。
main.js 从原 ~4300 行单体降到 2486,仍含 openManager 巨型闭包、模态框、
工具栏、布局、注入、状态与业务逻辑。

## 仅剩 E 完整 (高风险,留到有真实测试条件再做)

当前 `render.js` 里的 `renderVisibleList` / `renderVisibleGrid` 仍是命令式
`innerHTML` 全量重建(每次滚动/选择都 `UI.in.innerHTML = ""` 再逐行
`createElement`)。**E 完整** = 把它改成组件化(keyed diff / 轻量模板),
减少全量重建、保留 DOM 状态。

这是整个重构最大的一次**行为改写**:它会改变渲染时机、DOM 复用、事件绑定,
**无法用排序-diff 证等价,也无法靠 stub 加载验证**。必须能对着真实 PikPak
边改边验(滚动流畅度、选择态、拖放、缩略图懒加载、分组头、路径显示都要回归)。
**不要盲做。** 做时建议:先只改 list 或只改 grid 之一,小步验证再推另一个。

## 落地 / 验证

- 当前分支产物应等价 v2.4.3。真实测通过 → `git checkout main && git merge
  refactor/modularize && git push`(Greasyfork 同步)。**验证前勿 merge**。
- 分支产物 raw:
  `https://github.com/yjagh/PikPak_Assistant/raw/refactor/modularize/PikPak_Assistant.user.js`
- 真实验证重点:播放/字幕/上下集连播/外部播放器/关闭(B);
  列表与网格渲染、虚拟滚动、选择、拖放、分组、缩略图(E 半步);
  以及 C 的样式/四语言/浏览/删除全回归。
