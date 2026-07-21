# 重构进度与后续方案 (Refactor status & next steps)

分支 `refactor/modularize`。目标:把单文件工程化 + 解耦 openManager 巨型闭包。

## 已完成 (可静态验证,理论等价 v2.4.3,未经真实 PikPak 实测)

- **C 工程化**:esbuild 构建管线(`build.mjs` / `package.json`),源码拆成
  `src/{meta.txt, styles.css, i18n.js, config.js, utils.js, api.js, main.js}`。
  改代码 → `npm run build` → 产出 `PikPak_Assistant.user.js`。
- **B step 1**:`playVideo`(461 行)从 openManager 闭包剥离到模块级。原本只依赖
  openManager 局部的 `L`/`setLoad`/`updateLoadTxt`,已解耦(函数内 `getStrings()`
  + 模块级 `setLoad`/`updateLoadTxt` helper)。esbuild 零 error。

## B step 2 — playVideo → 独立 `src/player.js`

`playVideo` 现在是 `src/main.js` 里的模块级函数(在 `openManager` 定义前),连同紧邻的
`setLoad`/`updateLoadTxt` helper。要移到独立文件:

1. **先确认** `getHls` / `getPlyr` 的定义位置(grep `src/main.js`);它们若是全局
   `@require`(Plyr/Hls)的 wrapper,player.js 直接用全局即可,无需 import。
2. player.js 需要从别处拿的符号:
   - 从 `./api.js`:`apiGet`  从 `./utils.js`:`sleep, esc, gmGet, gmSet`
     从 `./config.js`:`CONF`(如用到)
   - 从 `./main.js`(核心,仍在 main):`S, UI, showModal, showToast, showAlert,
     showConfirm, showPrompt, setLoading, updateLoadingText, setLoad,
     updateLoadTxt, destroyHls, revokeSubBlobs, getStrings, getLang`
3. **两条路,先试 (a):**
   - (a) `player.js` `import {…} from "./main.js"`,`main.js` 给上述符号加 `export`
     并 `import { playVideo } from "./player.js"`。这是**循环依赖**,但 playVideo 用
     这些都在**运行时**(管理器打开后),ESM live-binding + esbuild 通常能正确处理
     (`S` 用 `export let S` 即可 live 反映 openManager 里的 `S = {...}` 重置)。
     `npm run build`,若 esbuild 只报 circular 提示、bundle 成功且加载测试过 → 成。
   - (b) 若循环导致运行错(TDZ 等),把上述"从 main.js 拿的核心符号"抽到中间模块
     `src/core.js`,player.js 和 main.js 都 `import from "./core.js"`(无环)。
4. 每步 `npm run build`(esbuild 会报缺失的 export/未定义)+ node --check + 加载测试。
5. **必须真实测**:打开视频、切字幕语言、上下集连播、外部播放器、关闭(HLS 销毁)。

## E — 渲染层 (`src/render.js`)

当前 `render / renderList / renderGrid / renderVisibleList / renderVisibleGrid` 是
命令式 `innerHTML` 重建(见 `renderVisibleList` 里逐行 `createElement` + innerHTML)。

- **E 半步(低风险,建议先做)**:只把这几个 render 函数抽成 `src/render.js` 模块
  (纯搬迁,不改渲染逻辑,和 C 的模块抽取同套路)。依赖 `S, UI, CONF, esc, fmt*,
  getIcon, _h(handlers), applyDragDrop` 等 → import。可静态验证等价。
- **E 完整(高风险,留到有真实测试条件)**:把命令式重建改成组件化(如 keyed diff /
  轻量模板),减少全量 innerHTML 重建。这是整个重构最大的重写,**必须能对着真实
  PikPak 边改边验**,不要盲做。

## 落地 / 验证

- 当前分支产物应等价 v2.4.3。真实测通过 → `git checkout main && git merge
  refactor/modularize && git push`(Greasyfork 同步)。**验证前勿 merge**。
- 分支产物 raw:
  `https://github.com/yjagh/PikPak_Assistant/raw/refactor/modularize/PikPak_Assistant.user.js`
