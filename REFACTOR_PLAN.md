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

## E 完整 (已做,2026-07-21,待真机验证)

`renderVisibleList` / `renderVisibleGrid` 已从命令式 `innerHTML` 全量重建改成
**keyed 节点池协调**:按 item id(列表分组头按 `h:type:name`)复用元素,
每帧只 create 进入项 / reuse+reposition 存活项 / remove 离开项。行/卡片是
绝对定位(top=index),协调无需 DOM 重排。每格的决策是纯函数
`planCell`(`src/render_plan.js`,leaf 模块,Node 可直接单测)。
`resetPoolIfNeeded` 在容器换新(重开管理器)或视图切换时清池;网格用 geom
签名检测缩放/尺寸变化以整体重定位。

**行为差异**:元素跨渲染复用 → 网格 `<img>` 缩略图滚动时不再重载/闪烁;
选择切换只动那一个卡片而非重建整窗;`.pk-card` 有 `transition:background .1s`,
故复用卡片的选择切换现在有 0.1s 淡入(旧版每次新元素、瞬时)——列表行无
transition,不变。

**离线已验**:planCell 真值表 7 例 + 用**真实 planCell** 驱动协调模拟器跑
初始/滚动/选择/排序/刷新/换目录/表头 7 场景(共 38 断言全过);新旧 render.js
的 innerHTML/cssText 模板串逐字节对比,仅新增 2 个不进 DOM 的内部 key 串,
所有产生可见 DOM 的模板未变;build 0 警告 + node --check + stub 加载过。
**未验(必须真机测)**:浏览器实际 DOM 行为——滚动流畅度、选择态、拖放、
缩略图懒加载、分组头、路径显示,合并前务必在真实 PikPak 回归。

至此 **A/B/C/D/E 全部完成**,`refactor/modularize` 分支的重构已收尾,只待
用户真机验证 + 合并。

## 落地 / 验证

- 当前分支产物应等价 v2.4.3。真实测通过 → `git checkout main && git merge
  refactor/modularize && git push`(Greasyfork 同步)。**验证前勿 merge**。
- 分支产物 raw:
  `https://github.com/yjagh/PikPak_Assistant/raw/refactor/modularize/PikPak_Assistant.user.js`
- 真实验证重点:播放/字幕/上下集连播/外部播放器/关闭(B);
  列表与网格渲染、虚拟滚动、选择、拖放、分组、缩略图(E 半步);
  以及 C 的样式/四语言/浏览/删除全回归。
