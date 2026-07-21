import { CONF, ICONS } from "./config.js";
import { pkFetch, apiList, apiGet, apiBatchTrash, apiAction } from "./api.js";
import { sleep, esc, fmtSize, fmtDate, fmtDur, gmGet, gmSet } from "./utils.js";
import { T } from "./i18n.js";
import CSS from "./styles.css";

    function getLang() {
        const userLang = gmGet("pk_lang", "");
        if (userLang) return userLang;
        const navLang = navigator.language.slice(0, 2);
        return T[navLang] ? navLang : "en";
    }
    function getStrings() {
        return T[getLang()] || T.en;
    }

    // 单一状态源：模块级渲染函数与 openManager 业务逻辑共享同一个模块级 S，
    // 取代原先 subscribe=0 的死 store(AppState)+手动 syncState 双轨制。
    // 初始为默认值，openManager 打开时整体重置。
    let S = {
        path: [{
            id: "",
            name: "🏠 Home"
        }],
        history: [],
        forward: [],
        items: [],
        display: [],
        sel: new Set,
        sort: "name",
        dir: 1,
        scanning: false,
        dupMode: false,
        dupRunning: false,
        dupReasons: new Map,
        dupGroups: new Map,
        dupSizeStrategy: "small",
        dupDateStrategy: "old",
        clipItems: [],
        clipType: "",
        clipSourceParentId: null,
        loading: false,
        lastSelIdx: -1,
        search: "",
        view: "list",
        gridZoom: 140
    };
    let _parentEl = null;
    let _L = null;
    function initModal(parentEl, L) {
        _parentEl = parentEl;
        _L = L;
    }
    function updateModalLang(L) {
        _L = L;
    }
    function showModal(html) {
        const m = document.createElement("div");
        m.className = "pk-modal-ov";
        m.innerHTML = `<div class="pk-modal"><div class="pk-modal-close">${CONF.icons.close}</div>${html}</div>`;
        _parentEl.appendChild(m);
        m.querySelector(".pk-modal-close").addEventListener("click", () => m.remove());
        return m;
    }
    function showToast(msg, overlayEl) {
        const box = (overlayEl || _parentEl?.closest(".pk-ov"))?.querySelector("#pk-toast-box");
        if (!box) return;
        const t = document.createElement("div");
        t.className = "pk-toast";
        t.innerHTML = `<span>✅</span><span>${esc(msg)}</span>`;
        box.appendChild(t);
        setTimeout(() => t.remove(), 3e3);
    }
    function showAlert(msg, title) {
        const L = _L || {};
        title = title || L.title_alert || "Alert";
        return new Promise(resolve => {
            const m = showModal(`\n            <h3>${title}</h3>\n            <div style="margin:20px 0;line-height:1.5;">${esc(msg).replace(/\n/g, "<br>")}</div>\n            <div class="pk-modal-act">\n                <button class="pk-btn pri" id="alert_ok">${L.btn_ok || "OK"}</button>\n            </div>\n        `);
            m.querySelector("#alert_ok").onclick = () => {
                m.remove();
                resolve();
            };
            m.querySelector(".pk-modal-close").onclick = () => {
                m.remove();
                resolve();
            };
        });
    }
    function showConfirm(msg, title) {
        const L = _L || {};
        title = title || L.title_confirm || "Confirm";
        return new Promise(resolve => {
            const m = showModal(`\n            <h3>${title}</h3>\n            <div style="margin:20px 0;line-height:1.5;">${esc(msg).replace(/\n/g, "<br>")}</div>\n            <div class="pk-modal-act">\n                <button class="pk-btn" id="cfm_no">${L.btn_no || "No"}</button>\n                <button class="pk-btn pri" id="cfm_yes">${L.btn_yes || "Yes"}</button>\n            </div>\n        `);
            m.querySelector("#cfm_no").onclick = () => {
                m.remove();
                resolve(false);
            };
            m.querySelector("#cfm_yes").onclick = () => {
                m.remove();
                resolve(true);
            };
            m.querySelector(".pk-modal-close").onclick = () => {
                m.remove();
                resolve(false);
            };
        });
    }
    function showPrompt(msg, val, title) {
        const L = _L || {};
        val = val || "";
        title = title || L.title_prompt || "Prompt";
        return new Promise(resolve => {
            const m = showModal(`\n            <h3>${title}</h3>\n            <div style="margin-bottom:10px;">${esc(msg)}</div>\n            <div class="pk-field"><input type="text" id="prm_input" value="${esc(val)}"></div>\n            <div class="pk-modal-act">\n                <button class="pk-btn" id="prm_cancel">${L.btn_cancel || "Cancel"}</button>\n                <button class="pk-btn pri" id="prm_ok">${L.btn_ok || "OK"}</button>\n            </div>\n        `);
            const inp = m.querySelector("#prm_input");
            inp.focus();
            inp.onkeydown = e => {
                if (e.key === "Enter") m.querySelector("#prm_ok").click();
                if (e.key === "Escape") {
                    e.stopPropagation();
                    m.remove();
                    resolve(null);
                }
            };
            m.querySelector("#prm_cancel").onclick = () => {
                m.remove();
                resolve(null);
            };
            m.querySelector("#prm_ok").onclick = () => {
                const v = inp.value.trim();
                m.remove();
                resolve(v);
            };
            m.querySelector(".pk-modal-close").onclick = () => {
                m.remove();
                resolve(null);
            };
        });
    }
    const UI = {};
    let _overlayEl = null;
    // 管理器生命周期内所有 document 级监听器都挂到这个 signal 上，
    // 关闭时一次性 abort，避免反复开关累积监听器（旧闭包复活/CPU 泄漏）
    let _mgrAbort = null;
    // 当前 HLS 实例句柄：每次重新播放/切集/切字幕/关闭前销毁旧实例，
    // 否则旧实例仍绑在被移除的 video 上持续下载分片（内存+网络泄漏）
    let _currentHls = null;
    function destroyHls() {
        if (_currentHls) {
            try {
                _currentHls.destroy();
            } catch (e) { }
            _currentHls = null;
        }
    }
    // 字幕轨道用的 Blob URL：在切换视频/关闭播放器时统一 revoke，避免内存泄漏
    let _subBlobUrls = [];
    function revokeSubBlobs() {
        _subBlobUrls.forEach(u => {
            try {
                URL.revokeObjectURL(u);
            } catch (e) { }
        });
        _subBlobUrls = [];
    }
    function getOverlayEl() {
        return _overlayEl;
    }
    function createLayout(L, lang, version) {
        const view = S.view || "list";
        const el = document.createElement("div");
        el.className = "pk-ov";
        let siteFont = window.getComputedStyle(document.body).fontFamily || "";
        siteFont = siteFont.replace(/,?\s*sans-serif\s*$/i, "");
        el.style.fontFamily = siteFont ? `${siteFont}, "Noto Sans", sans-serif` : '"Noto Sans", sans-serif';
        el.innerHTML = `\n        <style>${CSS}</style>\n        <div class="pk-win pk-lang-${lang}">\n            <div class="pk-loading-ov" id="pk-loader"><div class="pk-spin-lg"></div><div class="pk-loading-txt" id="pk-load-txt">${L.loading_detail}</div><button class="pk-stop-btn" id="pk-stop-load" title="${L.tip_stop}">${CONF.icons.stop} <span>${L.btn_stop}</span></button></div>\n            <div class="pk-hd"><div class="pk-tt"><img src="${CONF.logoUrl}" style="width:24px;height:24px;border-radius:4px;object-fit:contain;">${L.title}</div><div style="display:flex;gap:4px;"><div class="pk-btn" id="pk-help" style="width:32px;padding:0;justify-content:center;" title="${L.tip_help}">${CONF.icons.help}</div><div class="pk-btn" id="pk-settings" style="width:32px;padding:0;justify-content:center;" title="${L.tip_settings}">${CONF.icons.settings}</div><div class="pk-btn" id="pk-close" style="width:32px;padding:0;justify-content:center;">${CONF.icons.close}</div></div></div>\n            <div class="pk-tb"><button class="pk-btn" id="pk-nav-back" title="${L.tip_back}">${CONF.icons.back}<span>${L.btn_back}</span></button><button class="pk-btn" id="pk-refresh" title="${L.tip_refresh}">${CONF.icons.refresh}</button><button class="pk-btn" id="pk-nav-fwd" title="${L.tip_fwd}">${CONF.icons.fwd}<span>${L.btn_fwd}</span></button><div class="pk-sep"></div><div class="pk-nav" id="pk-crumb"></div><div style="flex:1"></div><div class="pk-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg><input type="text" id="pk-search-input" placeholder="${L.placeholder_search}" title="${L.tip_search_global || L.tip_search}" autocomplete="off"><div class="pk-sep" style="height:16px;"></div><div id="pk-filter-toggle" class="pk-filter-icon" title="${L.tip_filter}">${CONF.icons.filter}</div></div><button class="pk-btn" id="pk-dup" style="display:none" title="${L.tip_dup}">${CONF.icons.dup} <span>${L.btn_dup}</span></button><button class="pk-btn" id="pk-scan" title="${L.tip_scan}">${CONF.icons.scan} <span>${L.btn_scan}</span></button></div>\n            <div class="pk-tb" id="pk-actionbar"><div class="pk-btn" id="pk-sidebar-toggle" title="${L.tip_sidebar}">${CONF.icons.sidebar}</div><button class="pk-btn" id="pk-view-toggle" title="${view === "list" ? L.btn_view_grid : L.btn_view_list}">${view === "list" ? CONF.icons.grid_view : CONF.icons.list_view}</button><input type="range" id="pk-grid-zoom" class="pk-zoom-slider" min="80" max="320" value="${S.gridZoom || 140}" style="display:${view === "grid" ? "inline-block" : "none"}; width:70px; margin-left:8px; cursor:pointer;" title="${L.tip_zoom}"><div class="pk-sep"></div><div class="pk-sort-dropdown" id="pk-sort-dd"><button class="pk-sort-btn" id="pk-sort-b" title="${L.tip_sort}" style="min-width:80px;padding:4px 8px;border-radius:4px;border:1px solid var(--pk-bd);background:transparent;color:var(--pk-fg);font-size:12px;cursor:pointer;display:flex;align-items:center;gap:2px;"><span class="pk-sort-label">${L.sort_name || "Sort"}</span><span class="pk-sort-dir-icon" style="font-size:10px;font-weight:bold;margin-left:2px;"></span><span style="margin-left:4px;opacity:0.4;display:flex;">${CONF.icons.chevron_down}</span></button><div class="pk-sort-menu" id="pk-sort-m"><div class="pk-sort-opt" data-k="name">${L.sort_name || "Name"}<span class="pk-sort-dir"></span></div><div class="pk-sort-opt" data-k="size">${L.sort_size || "Size"}<span class="pk-sort-dir"></span></div><div class="pk-sort-opt" data-k="duration">${L.sort_duration || "Duration"}<span class="pk-sort-dir"></span></div><div class="pk-sort-opt" data-k="modified_time">${L.sort_modified || "Modified"}<span class="pk-sort-dir"></span></div><div class="pk-sort-opt" data-k="created_time">${L.sort_created || "Created"}<span class="pk-sort-dir"></span></div><div class="pk-sort-opt" data-k="ext">${L.sort_ext || "Extension"}<span class="pk-sort-dir"></span></div></div></div><div class="pk-sep"></div><button class="pk-btn" id="pk-newfolder" title="${L.tip_newfolder}">${CONF.icons.newfolder} <span>${L.btn_newfolder}</span></button><button class="pk-btn" id="pk-del" title="${L.tip_del}">${CONF.icons.del} <span>${L.btn_del}</span></button><button class="pk-btn" id="pk-deselect" title="${L.tip_deselect}" style="display:none">${CONF.icons.deselect} <span>${L.btn_deselect}</span></button><div class="pk-sep"></div><button class="pk-btn" id="pk-copy" title="${L.tip_copy}">${CONF.icons.copy} <span>${L.btn_copy}</span></button><button class="pk-btn" id="pk-cut" title="${L.tip_cut}">${CONF.icons.cut} <span>${L.btn_cut}</span></button><button class="pk-btn" id="pk-paste" title="${L.tip_paste}" disabled>${CONF.icons.paste} <span>${L.btn_paste}</span></button><div class="pk-sep"></div><button class="pk-btn" id="pk-rename" title="${L.tip_rename}">${CONF.icons.rename} <span>${L.btn_rename}</span></button><button class="pk-btn" id="pk-bulkrename" title="${L.tip_bulkrename}">${CONF.icons.bulkrename} <span>${L.btn_bulkrename}</span></button><div class="pk-sep"></div><button class="pk-btn" id="pk-tree-select" title="${L.tip_tree_select}">📄 <span>${L.btn_tree_select}</span></button></div>\n            <div id="pk-filter-area"></div>\n            <div class="pk-dup-toolbar" id="pk-dup-tools"><span class="pk-dup-lbl">${L.lbl_dup_tool}</span><select id="pk-dup-filter" class="pk-dup-filter" title="${L.tip_dup_filter || ""}"><option value="all">${L.opt_all || "All"}</option><option value="hash">${L.opt_hash || L.tag_hash}</option><option value="name">${L.opt_name || L.tag_name}</option><option value="sim">${L.opt_sim || L.tag_sim}</option></select><button class="pk-btn-toggle" id="pk-dup-size" title="${L.tip_toggle_size}">${L.btn_toggle_size} <span id="pk-cond-size">(${L.cond_small})</span></button><button class="pk-btn-toggle" id="pk-dup-date" title="${L.tip_toggle_date}">${L.btn_toggle_date} <span id="pk-cond-date">(${L.cond_old})</span></button></div>\n            <div class="pk-body">\n                <div class="pk-sidebar" id="pk-sidebar"></div>\n                <div class="pk-main">\n                    <div class="pk-grid-hd"><div><input type="checkbox" id="pk-all"></div><div class="pk-col" data-k="name">${L.col_name} <span></span></div><div class="pk-col" data-k="size">${L.col_size} <span></span></div><div class="pk-col" data-k="duration">${L.col_dur} <span></span></div><div class="pk-col" data-k="modified_time">${L.col_date} <span></span></div></div>\n                    <div class="pk-vp" id="pk-vp"><div class="pk-in" id="pk-in"></div></div>\n                </div>\n            </div>\n            <div class="pk-ft"><div class="pk-stat" id="pk-stat">${L.status_ready.replace("{n}", 0)}</div><div class="pk-grp"><div class="pk-dl-dropdown" id="pk-dl-dd"><button class="pk-btn" id="pk-dl-btn" title="${L.tip_download_menu}">${CONF.icons.download} <span>${L.btn_download_menu}</span>${CONF.icons.chevron_down}</button><div class="pk-dl-menu" id="pk-dl-menu"><button class="pk-btn" id="pk-down" title="${L.tip_down}">${CONF.icons.download} <span>${L.btn_down}</span></button><button class="pk-btn" id="pk-link-copy" title="${L.tip_link_copy}">${CONF.icons.link_copy || "🔗"} <span>${L.btn_link_copy}</span></button><button class="pk-btn" id="pk-resource-copy" title="${L.tip_resource_copy}">${CONF.icons.link_copy || "🧲"} <span>${L.btn_resource_copy}</span></button><button class="pk-btn" id="pk-aria2" title="${L.tip_aria2}">${CONF.icons.send} <span>${L.btn_aria2}</span></button><button class="pk-btn" id="pk-idm" title="${L.tip_idm}">${CONF.icons.link} <span>${L.btn_idm}</span></button><button class="pk-btn" id="pk-ext" title="${L.tip_ext}">${CONF.icons.play} <span>${L.btn_ext}</span></button></div></div></div></div>\n        </div>\n        <div class="pk-pop" id="pk-pop"></div>\n        <div class="pk-ctx" id="pk-ctx"><div class="pk-ctx-item" id="ctx-open">📂 ${L.ctx_open}</div><div class="pk-ctx-sep"></div><div class="pk-ctx-item" id="ctx-ext-play">🖥️ ${L.ctx_ext_play}</div><div class="pk-ctx-item" id="ctx-down">💾 ${L.ctx_down}</div><div class="pk-ctx-item" id="ctx-copy">📄 ${L.ctx_copy}</div><div class="pk-ctx-item" id="ctx-cut">✂️ ${L.ctx_cut}</div><div class="pk-ctx-sep"></div><div class="pk-ctx-item" id="ctx-rename">✏️ ${L.ctx_rename}</div><div class="pk-ctx-item" id="ctx-del" style="color:#d93025">🗑️ ${L.ctx_del}</div></div>\n        <div class="pk-toast-box" id="pk-toast-box"></div>\n    `;
        document.body.appendChild(el);
        _overlayEl = el;
        UI.el = el;
        UI.win = el.querySelector(".pk-win");
        UI.vp = el.querySelector("#pk-vp");
        UI.in = el.querySelector("#pk-in");
        UI.loader = el.querySelector("#pk-loader");
        UI.loadTxt = el.querySelector("#pk-load-txt");
        UI.stopBtn = el.querySelector("#pk-stop-load");
        UI.crumb = el.querySelector("#pk-crumb");
        UI.stat = el.querySelector("#pk-stat");
        UI.chkAll = el.querySelector("#pk-all");
        UI.scan = el.querySelector("#pk-scan");
        UI.dup = el.querySelector("#pk-dup");
        UI.dupTools = el.querySelector("#pk-dup-tools");
        UI.dupFilter = el.querySelector("#pk-dup-filter");
        UI.btnDupSize = el.querySelector("#pk-dup-size");
        UI.condSize = el.querySelector("#pk-cond-size");
        UI.btnDupDate = el.querySelector("#pk-dup-date");
        UI.condDate = el.querySelector("#pk-cond-date");
        UI.btnBack = el.querySelector("#pk-nav-back");
        UI.btnFwd = el.querySelector("#pk-nav-fwd");
        UI.btnCopy = el.querySelector("#pk-copy");
        UI.btnCut = el.querySelector("#pk-cut");
        UI.btnDel = el.querySelector("#pk-del");
        UI.btnDeselect = el.querySelector("#pk-deselect");
        UI.btnRename = el.querySelector("#pk-rename");
        UI.btnBulkRename = el.querySelector("#pk-bulkrename");
        UI.btnPaste = el.querySelector("#pk-paste");
        UI.btnRefresh = el.querySelector("#pk-refresh");
        UI.btnNewFolder = el.querySelector("#pk-newfolder");
        UI.btnSettings = el.querySelector("#pk-settings");
        UI.btnClose = el.querySelector("#pk-close");
        UI.btnHelp = el.querySelector("#pk-help");
        UI.btnExt = el.querySelector("#pk-ext");
        UI.btnIdm = el.querySelector("#pk-idm");
        UI.btnLinkCopy = el.querySelector("#pk-link-copy");
        UI.btnResourceCopy = el.querySelector("#pk-resource-copy");
        UI.dlBtn = el.querySelector("#pk-dl-btn");
        UI.dlMenu = el.querySelector("#pk-dl-menu");
        UI.btnTreeSelect = el.querySelector("#pk-tree-select");
        UI.btnViewToggle = el.querySelector("#pk-view-toggle");
        UI.pop = el.querySelector("#pk-pop");
        UI.ctx = el.querySelector("#pk-ctx");
        UI.cols = el.querySelectorAll(".pk-col");
        UI.searchInput = el.querySelector("#pk-search-input");
        UI.filterToggle = el.querySelector("#pk-filter-toggle");
        UI.filterArea = el.querySelector("#pk-filter-area");
        UI.sidebarEl = el.querySelector("#pk-sidebar");
        UI.sidebarToggle = el.querySelector("#pk-sidebar-toggle");
        UI.gridZoom = el.querySelector("#pk-grid-zoom");
        let isDragging = false, startX, startY;
        let initialLeft, initialTop;
        const hd = el.querySelector(".pk-hd");
        // 窗口位置/尺寸持久化：与悬浮球位置一致，拖动/缩放后记住，下次打开恢复
        const saveWinBox = () => {
            const r = UI.win.getBoundingClientRect();
            gmSet("pk_win_left", Math.round(r.left));
            gmSet("pk_win_top", Math.round(r.top));
            gmSet("pk_win_w", Math.round(r.width));
            gmSet("pk_win_h", Math.round(r.height));
        };
        const applyStoredWinBox = () => {
            const l = gmGet("pk_win_left", null), t = gmGet("pk_win_top", null);
            const w = gmGet("pk_win_w", null), h = gmGet("pk_win_h", null);
            if (w != null && h != null) {
                UI.win.style.width = Math.max(400, Math.min(parseFloat(w), window.innerWidth)) + "px";
                UI.win.style.height = Math.max(300, Math.min(parseFloat(h), window.innerHeight)) + "px";
            }
            if (l != null && t != null) {
                // clamp 到可见范围，避免窗口恢复到视口外无法操作
                const left = Math.max(0, Math.min(parseFloat(l), window.innerWidth - 80));
                const top = Math.max(0, Math.min(parseFloat(t), window.innerHeight - 40));
                UI.win.style.left = left + "px";
                UI.win.style.top = top + "px";
                UI.win.style.margin = "0";
                UI.win.style.transform = "none";
            }
        };
        hd.addEventListener("mousedown", e => {
            if (e.target.closest(".pk-btn") || e.target.tagName === "INPUT" || e.target.tagName === "BUTTON") return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = UI.win.getBoundingClientRect();
            initialLeft = parseFloat(getComputedStyle(UI.win).left) || rect.left;
            initialTop = parseFloat(getComputedStyle(UI.win).top) || rect.top;
            document.body.style.userSelect = "none";
            hd.style.cursor = "grabbing";
        });
        document.addEventListener("mousemove", e => {
            if (!isDragging) return;
            const dx = e.clientX - startX, dy = e.clientY - startY;
            UI.win.style.left = `${initialLeft + dx}px`;
            UI.win.style.top = `${initialTop + dy}px`;
            UI.win.style.margin = "0";
            UI.win.style.transform = "none";
        }, {
            signal: _mgrAbort.signal
        });
        document.addEventListener("mouseup", () => {
            if (isDragging) saveWinBox();
            isDragging = false;
            document.body.style.userSelect = "";
            hd.style.cursor = "default";
        }, {
            signal: _mgrAbort.signal
        });
        const rsDirs = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
        rsDirs.forEach(dir => {
            const h = document.createElement("div");
            h.className = `pk-rz pk-rz-${dir}`;
            UI.win.appendChild(h);
            h.addEventListener("mousedown", e => {
                let isResizing = true, rStartX = e.clientX, rStartY = e.clientY;
                const rect = UI.win.getBoundingClientRect();
                let startW = rect.width, startH = rect.height;
                let startL = parseFloat(getComputedStyle(UI.win).left) || rect.left;
                let startT = parseFloat(getComputedStyle(UI.win).top) || rect.top;
                document.body.style.cursor = `${dir}-resize`;
                document.body.style.userSelect = "none";
                e.stopPropagation();
                e.preventDefault();
                const mm = ev => {
                    if (!isResizing) return;
                    const dx = ev.clientX - rStartX, dy = ev.clientY - rStartY;
                    if (dir.includes("e")) UI.win.style.width = `${startW + dx}px`;
                    if (dir.includes("s")) UI.win.style.height = `${startH + dy}px`;
                    if (dir.includes("w")) {
                        UI.win.style.width = `${startW - dx}px`;
                        UI.win.style.left = `${startL + dx}px`;
                    }
                    if (dir.includes("n")) {
                        UI.win.style.height = `${startH - dy}px`;
                        UI.win.style.top = `${startT + dy}px`;
                    }
                };
                const mu = () => {
                    isResizing = false;
                    document.body.style.cursor = "";
                    document.body.style.userSelect = "";
                    document.removeEventListener("mousemove", mm);
                    document.removeEventListener("mouseup", mu);
                    saveWinBox();
                };
                document.addEventListener("mousemove", mm);
                document.addEventListener("mouseup", mu);
            });
        });
        applyStoredWinBox();
        return el;
    }
    function setLoading(b, L) {
        S.loading = b;
        UI.loader.style.display = b ? "flex" : "none";
        if (b && L) UI.loadTxt.textContent = L.loading_detail;
    }
    function updateLoadingText(txt) {
        if (UI.loadTxt) UI.loadTxt.innerText = txt;
    }
    function updateStat(L) {
        const n = S.sel.size, display = S.display;
        UI.stat.textContent = n > 0 ? L.sel_count.replace("{n}", n) : L.status_ready.replace("{n}", display.length);
        const hasSel = n > 0;
        UI.btnCopy.disabled = !hasSel;
        UI.btnCut.disabled = !hasSel;
        UI.btnDel.disabled = !hasSel;
        UI.btnRename.disabled = n !== 1;
        UI.btnBulkRename.disabled = n < 2;
        UI.btnSettings.disabled = false;
        UI.btnDeselect.style.display = hasSel ? "inline-flex" : "none";
        if (UI.btnLinkCopy) UI.btnLinkCopy.disabled = !hasSel;
        if (UI.btnResourceCopy) UI.btnResourceCopy.disabled = !hasSel;
    }
    function updateNavState() {
        const path = S.path, history = S.history, forward = S.forward;
        UI.btnBack.disabled = history.length === 0 && path.length <= 1;
        UI.btnFwd.disabled = forward.length === 0;
    }
    let _h = null;
    function setHandlers(h) {
        _h = h;
    }
    let _gridCache = {
        items: [],
        cols: 1,
        cardW: 140,
        cardH: 200,
        gap: 10
    };
    let _lastListRange = {
        start: -1,
        end: -1
    };
    function getIcon(item) {
        if (item.kind === "drive#folder") return CONF.typeIcons.folder;
        const name = item.name || "";
        const dot = name.lastIndexOf(".");
        if (dot === -1) return CONF.typeIcons.file;
        const ext = name.substring(dot + 1).toLowerCase();
        if ("mp4,mkv,avi,mov,wmv,flv,webm,ts,m4v,3gp".split(",").includes(ext)) return CONF.typeIcons.video;
        if ("jpg,jpeg,png,gif,bmp,svg,webp,tiff,ico".split(",").includes(ext)) return CONF.typeIcons.image;
        if ("mp3,wav,flac,aac,ogg,m4a,wma".split(",").includes(ext)) return CONF.typeIcons.audio;
        if ("zip,rar,7z,tar,gz,iso,dmg,pkg".split(",").includes(ext)) return CONF.typeIcons.archive;
        if (ext === "pdf") return CONF.typeIcons.pdf;
        if ("doc,docx,xls,xlsx,ppt,pptx,txt,md,csv".split(",").includes(ext)) return CONF.typeIcons.text;
        return CONF.typeIcons.file;
    }
    function render() {
        const view = S.view;
        if (view === "list") {
            const hd = UI.win.querySelector(".pk-grid-hd");
            if (hd) hd.classList.remove("hidden");
            UI.in.className = "pk-in";
            renderList();
        } else {
            const hd = UI.win.querySelector(".pk-grid-hd");
            if (hd) hd.classList.add("hidden");
            UI.in.className = "pk-grid-con";
            renderGrid();
        }
    }
    function renderList() {
        const display = S.display;
        const sort = S.sort;
        const dir = S.dir;
        UI.in.style.height = `${display.length * CONF.rowHeight}px`;
        UI.cols.forEach(c => {
            c.querySelector("span").textContent = c.dataset.k === sort ? dir === 1 ? " ▲" : " ▼" : "";
            c.style.color = c.dataset.k === sort ? "var(--pk-pri)" : "";
        });
        requestAnimationFrame(renderVisibleList);
    }
    function renderVisibleList() {
        if (S.view !== "list") return;
        const display = S.display;
        const sel = S.sel;
        const top = UI.vp.scrollTop, h = UI.vp.clientHeight;
        const start = Math.max(0, Math.floor(top / CONF.rowHeight) - CONF.buffer);
        const end = Math.min(display.length, Math.ceil((top + h) / CONF.rowHeight) + CONF.buffer);
        _lastListRange.start = start;
        _lastListRange.end = end;
        UI.in.innerHTML = "";
        for (let i = start; i < end; i++) {
            const d = display[i];
            if (!d) continue;
            const row = document.createElement("div");
            row.style.position = "absolute";
            row.style.top = `${i * CONF.rowHeight}px`;
            row.style.width = "100%";
            if (d.isHeader) {
                row.className = "pk-group-hd";
                row.innerHTML = `<div style="display:flex;align-items:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"><span style="margin-right:8px;">📁</span><span>${esc(d.name)}</span></div><div style="margin-left:auto;display:flex;align-items:center;"><span class="pk-tag">${d.type}</span><span class="pk-cnt">${d.count}</span></div>`;
            } else {
                const isSel = sel.has(d.id);
                row.className = `pk-row ${isSel ? "sel" : ""}`;
                row.dataset.id = d.id;
                const durVal = d.params?.duration || d.medias?.[0]?.duration || d.video_media_metadata?.duration || "";
                const fullTitle = d._path ? `${d._path}/${d.name}` : d.name;
                row.innerHTML = `<div><input type="checkbox" ${isSel ? "checked" : ""}></div><div class="pk-name" title="${esc(fullTitle)}">${getIcon(d)}<span class="pk-name-col"><span>${esc(d.name)}</span>${d._path ? `<span class="pk-path-sub">${esc(d._path)}</span>` : ""}</span></div><div>${d.kind === "drive#folder" ? "" : fmtSize(d.size)}</div><div>${fmtDur(durVal)}</div><div style="color:#888">${fmtDate(d.modified_time)}</div>`;
                if (_h) {
                    const chk = row.querySelector("input");
                    row.onclick = e => _h.onRowClick(e, d, i, chk);
                    row.ondblclick = e => _h.onRowDblClick(e, d);
                    row.oncontextmenu = e => _h.onRowContext(e, d, i);
                    row.onmouseenter = e => _h.onRowEnter(e, d);
                    row.onmouseleave = () => _h.onRowLeave();
                }
                applyDragDrop(row, d);
            }
            UI.in.appendChild(row);
        }
    }
    function renderGrid() {
        if (S.view !== "grid") return;
        const display = S.display;
        const zoom = S.gridZoom || 140;
        const gap = 10, padding = 10, containerW = UI.vp.clientWidth - padding * 2;
        const cols = Math.floor((containerW + gap) / (zoom + gap)) || 1;
        const cardW = (containerW - (cols - 1) * gap) / cols;
        const thumbH = Math.floor(cardW * .75);
        const cardH = thumbH + 74;
        UI.in.style.setProperty("--pk-thumb-h", `${thumbH}px`);
        const visibleItems = display.filter(d => !d.isHeader);
        const totalRows = Math.ceil(visibleItems.length / cols);
        UI.in.style.height = `${totalRows * (cardH + gap)}px`;
        _gridCache = {
            items: visibleItems,
            cols,
            cardW,
            cardH,
            gap
        };
        requestAnimationFrame(renderVisibleGrid);
    }
    function renderVisibleGrid() {
        if (S.view !== "grid") return;
        const { items, cols, cardW, cardH, gap } = _gridCache;
        const sel = S.sel;
        const top = UI.vp.scrollTop, h = UI.vp.clientHeight;
        const startRow = Math.max(0, Math.floor(top / (cardH + gap)) - 2);
        const endRow = Math.min(Math.ceil(items.length / cols), Math.ceil((top + h) / (cardH + gap)) + 2);
        UI.in.innerHTML = "";
        for (let r = startRow; r < endRow; r++) {
            for (let c = 0; c < cols; c++) {
                const idx = r * cols + c;
                if (idx >= items.length) break;
                const d = items[idx], isSel = sel.has(d.id);
                const card = document.createElement("div");
                card.className = `pk-card ${isSel ? "sel" : ""}`;
                card.dataset.id = d.id;
                card.style.cssText = `width:${cardW}px;height:${cardH}px;left:${10 + c * (cardW + gap)}px;top:${10 + r * (cardH + gap)}px`;
                let thumb = getIcon(d);
                if (d.kind !== "drive#folder" && d.thumbnail_link) thumb = `<img src="${d.thumbnail_link}" loading="lazy" decoding="async">`;
                card.innerHTML = `<input type="checkbox" class="pk-card-chk" ${isSel ? "checked" : ""}><div class="pk-card-thumb">${thumb}</div><div class="pk-card-name" title="${esc(d._path ? `${d._path}/${d.name}` : d.name)}">${esc(d.name)}</div><div class="pk-card-info"><span>${d.kind === "drive#folder" ? "" : fmtSize(d.size)}</span><span>${d.params?.duration ? fmtDur(d.params.duration) : ""}</span></div>`;
                if (_h) {
                    const chk = card.querySelector("input");
                    card.onclick = e => _h.onCardClick(e, d, idx, chk, card);
                    card.ondblclick = e => _h.onCardDblClick(e, d);
                    card.oncontextmenu = e => _h.onCardContext(e, d, card);
                }
                applyDragDrop(card, d);
                UI.in.appendChild(card);
            }
        }
    }
    let _scrollPending = false;
    function initScrollHandler() {
        UI.vp.onscroll = () => {
            if (_scrollPending) return;
            _scrollPending = true;
            requestAnimationFrame(() => {
                _scrollPending = false;
                if (S.view === "list") {
                    const display = S.display;
                    const top = UI.vp.scrollTop, h = UI.vp.clientHeight;
                    const start = Math.max(0, Math.floor(top / CONF.rowHeight) - CONF.buffer);
                    const end = Math.min(display.length, Math.ceil((top + h) / CONF.rowHeight) + CONF.buffer);
                    if (start === _lastListRange.start && end === _lastListRange.end) return;
                    renderVisibleList();
                } else renderGrid();
            });
        };
    }
    function applyDragDrop(el, d) {
        el.setAttribute("draggable", "true");
        el.ondragstart = e => {
            if (!S.sel.has(d.id)) {
                S.sel.add(d.id);
                requestAnimationFrame(() => {
                    if (S.view === "list") renderVisibleList(); else renderVisibleGrid();
                });
            }
            const ids = [...S.sel];
            e.dataTransfer.setData("application/pfm-ids", JSON.stringify(ids));
            e.dataTransfer.effectAllowed = "move";
            const L = getStrings();
            const ghost = document.createElement("div");
            ghost.className = "pk-drag-ghost";
            ghost.textContent = L.drag_move_count ? L.drag_move_count.replace("{n}", ids.length) : `${ids.length}`;
            document.body.appendChild(ghost);
            e.dataTransfer.setDragImage(ghost, -10, -10);
            requestAnimationFrame(() => ghost.remove());
        };
        if (d.kind === "drive#folder") {
            el.ondragover = e => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                el.classList.add("pk-drop-over");
            };
            el.ondragleave = () => {
                el.classList.remove("pk-drop-over");
            };
            el.ondrop = e => {
                e.preventDefault();
                el.classList.remove("pk-drop-over");
                const raw = e.dataTransfer.getData("application/pfm-ids");
                if (raw && _h && _h.onDrop) {
                    try {
                        _h.onDrop(JSON.parse(raw), d.id);
                    } catch (err) { }
                }
            };
        }
    }
    const CONTAINER_ID = "pfm-toast-container";
    function ensureContainer() {
        let c = document.getElementById(CONTAINER_ID);
        if (!c) {
            c = document.createElement("div");
            c.id = CONTAINER_ID;
            document.body.appendChild(c);
        }
        return c;
    }
    const Toast = {
        show(msg, type = "info", duration = 3e3) {
            const container = ensureContainer();
            const el = document.createElement("div");
            el.className = `pfm-toast pfm-toast-${type}`;
            el.innerHTML = `\n            <span class="pfm-toast-icon">${ICONS[type] || ""}</span>\n            <span class="pfm-toast-msg">${msg}</span>\n        `;
            container.appendChild(el);
            requestAnimationFrame(() => el.classList.add("pfm-toast-visible"));
            setTimeout(() => {
                el.classList.remove("pfm-toast-visible");
                setTimeout(() => el.remove(), 300);
            }, duration);
        },
        success: (msg, dur) => Toast.show(msg, "success", dur),
        error: (msg, dur) => Toast.show(msg, "error", dur),
        warning: (msg, dur) => Toast.show(msg, "warning", dur),
        info: (msg, dur) => Toast.show(msg, "info", dur),
        progress(msg) {
            const container = ensureContainer();
            const el = document.createElement("div");
            el.className = "pfm-toast pfm-toast-progress pfm-toast-visible";
            el.innerHTML = `\n            <span class="pfm-toast-msg">${msg}</span>\n            <div class="pfm-toast-bar"><div class="pfm-toast-fill" style="width:0%"></div></div>\n            <span class="pfm-toast-pct">0%</span>\n        `;
            container.appendChild(el);
            const fill = el.querySelector(".pfm-toast-fill");
            const pct = el.querySelector(".pfm-toast-pct");
            return {
                update(percent, newMsg) {
                    fill.style.width = `${percent}%`;
                    pct.textContent = `${Math.round(percent)}%`;
                    if (newMsg) el.querySelector(".pfm-toast-msg").textContent = newMsg;
                },
                done(successMsg) {
                    el.classList.add("pfm-toast-success");
                    el.querySelector(".pfm-toast-msg").textContent = successMsg || getStrings().msg_done;
                    fill.style.width = "100%";
                    setTimeout(() => {
                        el.classList.remove("pfm-toast-visible");
                        setTimeout(() => el.remove(), 300);
                    }, 2e3);
                },
                error(errorMsg) {
                    el.classList.add("pfm-toast-error");
                    el.querySelector(".pfm-toast-msg").textContent = errorMsg || getStrings().msg_error;
                    setTimeout(() => el.remove(), 3e3);
                }
            };
        }
    };
    const TOAST_CSS = `\n#pfm-toast-container {\n    position: fixed; bottom: 24px; right: 24px;\n    display: flex; flex-direction: column; gap: 8px;\n    z-index: 2147483647; pointer-events: none;\n}\n.pfm-toast {\n    display: flex; align-items: center; gap: 8px;\n    padding: 10px 16px; border-radius: 8px;\n    font-size: 13px; font-family: inherit;\n    background: #323232; color: #fff;\n    box-shadow: 0 4px 12px rgba(0,0,0,.3);\n    opacity: 0; transform: translateY(8px);\n    transition: opacity .25s, transform .25s;\n    pointer-events: auto; max-width: 360px;\n}\n.pfm-toast.pfm-toast-visible { opacity: 1; transform: translateY(0); }\n.pfm-toast-success { background: #2e7d32; }\n.pfm-toast-error   { background: #c62828; }\n.pfm-toast-warning { background: #e65100; }\n.pfm-toast-bar     { flex: 1; height: 4px; background: rgba(255,255,255,.3); border-radius: 2px; }\n.pfm-toast-fill    { height: 100%; background: #fff; border-radius: 2px; transition: width .2s; }\n`;
    const EXTRA_CSS = TOAST_CSS;
    let _injected = false;
    function injectStyles() {
        if (_injected) return;
        _injected = true;
        const styleEl = document.createElement("style");
        styleEl.textContent = EXTRA_CSS;
        document.head.appendChild(styleEl);
    }
    const TYPE_MAP = {
        video: ["mp4", "mkv", "avi", "mov", "wmv", "flv", "ts", "m2ts", "webm", "rmvb", "m4v"],
        image: ["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "tiff", "heic"],
        subtitle: ["srt", "ass", "ssa", "smi", "vtt", "sup"],
        archive: ["zip", "rar", "7z", "tar", "gz", "bz2"],
        audio: ["mp3", "flac", "aac", "wav", "ogg", "m4a", "opus"],
        document: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv"]
    };
    const DEFAULT_FILTER = {
        types: [],
        sizeMin: null,
        sizeMax: null,
        dateFrom: "",
        dateTo: "",
        nameInclude: "",
        nameExclude: "",
        useRegex: false
    };
    function countActiveFilters(filter) {
        let n = 0;
        if (filter.types.length > 0) n++;
        if (filter.sizeMin !== null || filter.sizeMax !== null) n++;
        if (filter.dateFrom || filter.dateTo) n++;
        if (filter.nameInclude || filter.nameExclude) n++;
        return n;
    }
    function applyFilter(files, filter) {
        if (!filter) return files;
        return files.filter(f => {
            if (f.kind === "drive#folder") return true;
            if (f.isHeader) return true;
            if (filter.types.length > 0) {
                const ext = (f.name || "").split(".").pop().toLowerCase();
                const matched = filter.types.some(t => TYPE_MAP[t]?.includes(ext));
                if (!matched) return false;
            }
            const size = parseInt(f.size || 0);
            if (filter.sizeMin !== null && size < filter.sizeMin) return false;
            if (filter.sizeMax !== null && size > filter.sizeMax) return false;
            if (filter.dateFrom) {
                const t = new Date(f.created_time || f.modified_time).getTime();
                if (t < new Date(filter.dateFrom).getTime()) return false;
            }
            if (filter.dateTo) {
                const t = new Date(f.created_time || f.modified_time).getTime();
                if (t > new Date(filter.dateTo).getTime() + 864e5) return false;
            }
            const name = (f.name || "").toLowerCase();
            if (filter.nameInclude) {
                if (filter.useRegex) {
                    try {
                        if (!new RegExp(filter.nameInclude, "i").test(f.name)) return false;
                    } catch { }
                } else {
                    if (!name.includes(filter.nameInclude.toLowerCase())) return false;
                }
            }
            if (filter.nameExclude) {
                if (filter.useRegex) {
                    try {
                        if (new RegExp(filter.nameExclude, "i").test(f.name)) return false;
                    } catch { }
                } else {
                    if (name.includes(filter.nameExclude.toLowerCase())) return false;
                }
            }
            return true;
        });
    }
    function createFilterPanelHTML(L, currentFilter) {
        const f = currentFilter || DEFAULT_FILTER;
        const typeButtons = ["video", "image", "subtitle", "archive", "audio", "document"].map(t => {
            const icons = {
                video: "🎬",
                image: "🖼️",
                subtitle: "💬",
                archive: "📦",
                audio: "🎵",
                document: "📄"
            };
            const active = f.types.includes(t) ? " active" : "";
            return `<button class="pk-filter-chip${active}" data-type="${t}">${icons[t]} ${L["filter_type_" + t] || t}</button>`;
        }).join("");
        return `\n    <div class="pk-filter-panel" id="pk-filter-panel">\n        <div class="pk-filter-section">\n            <label class="pk-filter-label">${L.filter_type || "Type"}:</label>\n            <div class="pk-filter-chips" id="pk-filter-types">${typeButtons}</div>\n        </div>\n        <div class="pk-filter-sep"></div>\n        <div class="pk-filter-section">\n            <label class="pk-filter-label">${L.filter_size || "Size"}:</label>\n            <div class="pk-filter-range">\n                <input type="number" id="pk-filter-size-min" placeholder="${L.filter_size_min || "Min"}" value="${f.sizeMin !== null ? f.sizeMin / (1024 * 1024) : ""}" min="0" step="1" title="MB">\n                <span>~</span>\n                <input type="number" id="pk-filter-size-max" placeholder="${L.filter_size_max || "Max"}" value="${f.sizeMax !== null ? f.sizeMax / (1024 * 1024) : ""}" min="0" step="1" title="MB">\n            </div>\n        </div>\n        <div class="pk-filter-sep"></div>\n        <div class="pk-filter-section">\n            <label class="pk-filter-label">${L.filter_date || "Date"}:</label>\n            <div class="pk-filter-range">\n                <input type="date" id="pk-filter-date-from" value="${f.dateFrom || ""}">\n                <span>~</span>\n                <input type="date" id="pk-filter-date-to" value="${f.dateTo || ""}">\n            </div>\n        </div>\n        <div class="pk-filter-sep"></div>\n        <div class="pk-filter-section">\n            <label class="pk-filter-label">${L.filter_name || "Name"}:</label>\n            <div class="pk-filter-name-row">\n                <input type="text" id="pk-filter-name-inc" placeholder="${L.filter_name_include || "Include"}" value="${f.nameInclude || ""}">\n                <input type="text" id="pk-filter-name-exc" placeholder="${L.filter_name_exclude || "Exclude"}" value="${f.nameExclude || ""}">\n                <label class="pk-filter-regex-label"><input type="checkbox" id="pk-filter-regex" ${f.useRegex ? "checked" : ""}>${L.filter_regex || "Rx"}</label>\n            </div>\n        </div>\n        <div class="pk-filter-actions">\n            <button class="pk-btn" id="pk-filter-reset">${L.btn_filter_reset || "Reset"}</button>\n            <button class="pk-btn pri" id="pk-filter-apply">${L.btn_filter_apply || "Apply"}</button>\n        </div>\n    </div>`;
    }
    function readFilterFromPanel(panelEl) {
        const types = [];
        panelEl.querySelectorAll(".pk-filter-chip.active").forEach(ch => {
            types.push(ch.dataset.type);
        });
        const sizeMinVal = panelEl.querySelector("#pk-filter-size-min")?.value;
        const sizeMaxVal = panelEl.querySelector("#pk-filter-size-max")?.value;
        const sizeMin = sizeMinVal ? parseFloat(sizeMinVal) * 1024 * 1024 : null;
        const sizeMax = sizeMaxVal ? parseFloat(sizeMaxVal) * 1024 * 1024 : null;
        return {
            types,
            sizeMin,
            sizeMax,
            dateFrom: panelEl.querySelector("#pk-filter-date-from")?.value || "",
            dateTo: panelEl.querySelector("#pk-filter-date-to")?.value || "",
            nameInclude: panelEl.querySelector("#pk-filter-name-inc")?.value || "",
            nameExclude: panelEl.querySelector("#pk-filter-name-exc")?.value || "",
            useRegex: panelEl.querySelector("#pk-filter-regex")?.checked || false
        };
    }
    let sidebar_L = null;
    let _onNavigate = null;
    let _onDrop = null;
    let _currentFolderId = "";
    function initSidebar(container, L, onNavigate, onDrop) {
        sidebar_L = L;
        _onNavigate = onNavigate;
        _onDrop = onDrop;
        container.innerHTML = `\n        <div class="pk-sb-header">${L.sidebar_title}</div>\n        <div class="pk-sb-tree" id="pk-sb-tree">\n            <ul class="pk-tree-root"></ul>\n        </div>\n    `;
        const rootUl = container.querySelector(".pk-tree-root");
        const rootNode = _createNode("", L.sidebar_home, true);
        rootUl.appendChild(rootNode);
        _toggleNode(rootNode, true);
    }
    function highlightFolder(folderId) {
        _currentFolderId = folderId;
        const tree = document.querySelector("#pk-sb-tree");
        if (!tree) return;
        tree.querySelectorAll(".pk-tree-row").forEach(row => {
            row.classList.toggle("active", row.dataset.folderId === folderId);
        });
    }
    function invalidateFolder(folderId) {
        const tree = document.querySelector("#pk-sb-tree");
        if (!tree) return;
        const row = tree.querySelector(`.pk-tree-row[data-folder-id="${folderId}"]`);
        if (row && row.parentElement) {
            const li = row.parentElement;
            delete li.dataset.loaded;
            const childUl = li.querySelector(":scope > .pk-tree-children");
            if (childUl && !childUl.hidden) {
                _toggleNode(li, true);
            }
        }
    }
    function _createNode(folderId, name, isRoot = false) {
        const li = document.createElement("li");
        li.className = "pk-tree-node";
        const row = document.createElement("div");
        row.className = "pk-tree-row";
        row.dataset.folderId = folderId;
        if (folderId === _currentFolderId) row.classList.add("active");
        const arrow = document.createElement("span");
        arrow.className = "pk-tree-arrow";
        arrow.innerHTML = CONF.icons.chevron_right;
        const icon = document.createElement("span");
        icon.className = "pk-tree-icon";
        icon.innerHTML = isRoot ? "🏠" : CONF.typeIcons.folder;
        const label = document.createElement("span");
        label.className = "pk-tree-name";
        label.textContent = name;
        row.appendChild(arrow);
        row.appendChild(icon);
        row.appendChild(label);
        li.appendChild(row);
        const childUl = document.createElement("ul");
        childUl.className = "pk-tree-children";
        childUl.hidden = true;
        li.appendChild(childUl);
        row.addEventListener("click", e => {
            e.stopPropagation();
            if (_onNavigate) _onNavigate(folderId, name);
            _toggleNode(li);
        });
        arrow.addEventListener("click", e => {
            e.stopPropagation();
            _toggleNode(li);
        });
        _addDropTarget(row, folderId);
        return li;
    }
    let _expandTimers = new Map;
    function _addDropTarget(rowEl, folderId) {
        rowEl.addEventListener("dragover", e => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            rowEl.classList.add("pk-drop-over");
            if (!_expandTimers.has(folderId)) {
                _expandTimers.set(folderId, setTimeout(() => {
                    const li = rowEl.closest(".pk-tree-node");
                    if (li) _toggleNode(li, true);
                    _expandTimers.delete(folderId);
                }, 800));
            }
        });
        rowEl.addEventListener("dragleave", () => {
            rowEl.classList.remove("pk-drop-over");
            if (_expandTimers.has(folderId)) {
                clearTimeout(_expandTimers.get(folderId));
                _expandTimers.delete(folderId);
            }
        });
        rowEl.addEventListener("drop", async e => {
            e.preventDefault();
            rowEl.classList.remove("pk-drop-over");
            if (_expandTimers.has(folderId)) {
                clearTimeout(_expandTimers.get(folderId));
                _expandTimers.delete(folderId);
            }
            const raw = e.dataTransfer.getData("application/pfm-ids");
            if (!raw) return;
            try {
                const ids = JSON.parse(raw);
                if (ids.length > 0 && _onDrop) {
                    await _onDrop(ids, folderId);
                }
            } catch (err) {
                console.error("[PFM] Drop error:", err);
            }
        });
    }
    async function _toggleNode(li, forceOpen = false) {
        const childUl = li.querySelector(":scope > .pk-tree-children");
        const arrow = li.querySelector(":scope > .pk-tree-row > .pk-tree-arrow");
        if (!childUl) return;
        const isOpen = !childUl.hidden;
        if (isOpen && !forceOpen) {
            childUl.hidden = true;
            arrow.innerHTML = CONF.icons.chevron_right;
            li.classList.remove("expanded");
            return;
        }
        if (forceOpen && isOpen) return;
        if (!li.dataset.loaded) {
            const folderId = li.querySelector(":scope > .pk-tree-row").dataset.folderId;
            arrow.innerHTML = `<span class="pk-tree-spin"></span>`;
            try {
                const items = await apiList(folderId, 500);
                const folders = items.filter(f => f.kind === "drive#folder");
                folders.sort((a, b) => a.name.localeCompare(b.name));
                childUl.innerHTML = "";
                if (folders.length === 0) {
                    const emptyLi = document.createElement("li");
                    emptyLi.className = "pk-tree-empty";
                    emptyLi.textContent = sidebar_L.sidebar_empty;
                    childUl.appendChild(emptyLi);
                } else {
                    folders.forEach(f => {
                        childUl.appendChild(_createNode(f.id, f.name));
                    });
                }
                li.dataset.loaded = "1";
            } catch (err) {
                console.error("[PFM] Sidebar load error:", err);
                childUl.innerHTML = `<li class="pk-tree-empty" style="color:#d93025">Error</li>`;
            }
        }
        childUl.hidden = false;
        arrow.innerHTML = CONF.icons.chevron_down;
        li.classList.add("expanded");
    }
    const package_namespaceObject = {
        rE: "2.0.0"
    };
    const { rE: version } = package_namespaceObject;
    console.log("🚀 PikPak Script: LOADED from main.js");
    // relocated out of openManager (refactor B): player is now module-level
    function setLoad(b) { S.loading = b; setLoading(b, getStrings()); }
    function updateLoadTxt(txt) { updateLoadingText(txt); }
        async function playVideo(item, extraTracksHtml = "", startAt = 0, forceLang = null) {
            const L = getStrings();
            destroyHls();
            let link = item.web_content_link;
            if (!link || !item.medias) {
                try {
                    setLoad(true, L);
                    const m = await apiGet(item.id);
                    item = m;
                    link = m.web_content_link;
                    setLoad(false);
                } catch (e) {
                    console.error(e);
                    setLoad(false);
                }
            }
            let streamLink = link;
            if (item.medias && item.medias.length > 0) {
                item.medias.sort((a, b) => {
                    const resA = parseInt((a.video_resolution || "").replace(/\D/g, "")) || 0;
                    const resB = parseInt((b.video_resolution || "").replace(/\D/g, "")) || 0;
                    return resB - resA;
                });
                const bestMedia = item.medias[0];
                if (bestMedia && bestMedia.link && bestMedia.link.url) {
                    streamLink = bestMedia.link.url;
                }
            }
            if (!streamLink) {
                showAlert(L.msg_video_fail || "Cannot fetch video link.");
                return;
            }
            const getPlyr = () => window.Plyr || (typeof unsafeWindow !== "undefined" ? unsafeWindow.Plyr : undefined);
            const getHls = () => window.Hls || (typeof unsafeWindow !== "undefined" ? unsafeWindow.Hls : undefined);
            let usePlyr = true;
            if (!getPlyr()) {
                setLoad(true, L);
                const css = document.createElement("link");
                css.rel = "stylesheet";
                css.href = "https://cdnjs.cloudflare.com/ajax/libs/plyr/3.7.8/plyr.css";
                document.head.appendChild(css);
                const js = document.createElement("script");
                js.src = "https://cdnjs.cloudflare.com/ajax/libs/plyr/3.7.8/plyr.min.js";
                document.head.appendChild(js);
                if (streamLink.includes(".m3u8") && !getHls()) {
                    const hlsJs = document.createElement("script");
                    hlsJs.src = "https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.3.5/hls.min.js";
                    document.head.appendChild(hlsJs);
                }
                try {
                    await new Promise((resolve, reject) => {
                        js.onload = resolve;
                        js.onerror = () => reject(new Error("CDN Load Error"));
                        setTimeout(() => reject(new Error("Timeout")), 1e4);
                        const stopBtn = document.getElementById("pk-stop-load");
                        if (stopBtn) stopBtn.onclick = () => reject(new Error("User Stopped"));
                    });
                    setLoad(false);
                    await sleep(50);
                } catch (e) {
                    setLoad(false);
                    usePlyr = false;
                    console.warn("Plyr load failed:", e);
                    showToast(L.msg_player_fallback);
                }
            } else {
                if (!document.getElementById("pk-plyr-style")) {
                    const style = document.createElement("style");
                    style.id = "pk-plyr-style";
                    if (typeof GM_getResourceText !== "undefined") {
                        try {
                            style.textContent = GM_getResourceText("plyrCSS");
                        } catch (e) { }
                    }
                    if (!style.textContent) style.textContent = "@import url('https://cdnjs.cloudflare.com/ajax/libs/plyr/3.7.8/plyr.css');";
                    document.head.appendChild(style);
                }
            }
            const baseName = item.name.replace(/\.[^/.]+$/, "");
            const subFiles = S.items.filter(i => i.name.startsWith(baseName) && /\.(srt|vtt|ass)$/i.test(i.name));
            let tracksHtml = extraTracksHtml;
            const supportedLangs = [{
                code: "ko",
                name: "Korean"
            }, {
                code: "en",
                name: "English"
            }, {
                code: "ja",
                name: "Japanese"
            }, {
                code: "zh-CN",
                name: "Chinese (Simplified)"
            }];
            let targetLang = forceLang || (typeof GM_getValue !== "undefined" ? GM_getValue("pk_sub_lang") || "ko" : "ko");
            const processSubFile = async (text, name, isSecondary = false) => {
                let processedText = text;
                if (name.toLowerCase().endsWith(".srt")) {
                    processedText = "WEBVTT\n\n" + text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
                }
                const translateToGoogle = async (vttText, tl) => {
                    const chunks = vttText.split("\n\n");
                    let translatedVtt = "WEBVTT\n\n";
                    const validChunks = [];
                    for (let i = 1; i < chunks.length; i++) {
                        const block = chunks[i].trim();
                        if (!block) continue;
                        const lines = block.split("\n");
                        if (lines.length >= 2) {
                            const tc = lines[0];
                            const tc2 = lines[1].includes("--\x3e") ? lines[1] : null;
                            let contentLines = tc2 ? lines.slice(2) : lines.slice(1);
                            validChunks.push({
                                block,
                                tc: tc2 ? tc + "\n" + tc2 : tc,
                                content: contentLines.join("\n")
                            });
                        } else {
                            validChunks.push({
                                block,
                                tc: null,
                                content: null
                            });
                        }
                    }
                    const BATCH_SIZE = 50;
                    const DELIM = " [[###]] ";
                    for (let i = 0; i < validChunks.length; i += BATCH_SIZE) {
                        const batch = validChunks.slice(i, i + BATCH_SIZE);
                        const contentsToTranslate = batch.filter(x => x.content).map(x => x.content);
                        if (contentsToTranslate.length === 0) {
                            batch.forEach(x => translatedVtt += x.block + "\n\n");
                            continue;
                        }
                        const queryText = contentsToTranslate.join(DELIM);
                        let translatedQuery = "";
                        try {
                            const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t`;
                            let responseText = "";
                            if (typeof GM_xmlhttpRequest !== "undefined") {
                                responseText = await new Promise(resolve => {
                                    GM_xmlhttpRequest({
                                        method: "POST",
                                        url,
                                        data: "q=" + encodeURIComponent(queryText),
                                        headers: {
                                            "Content-Type": "application/x-www-form-urlencoded"
                                        },
                                        onload: res => resolve(res.responseText),
                                        onerror: () => resolve("")
                                    });
                                });
                            } else {
                                const res = await fetch(url, {
                                    method: "POST",
                                    headers: {
                                        "Content-Type": "application/x-www-form-urlencoded"
                                    },
                                    body: "q=" + encodeURIComponent(queryText)
                                });
                                responseText = await res.text();
                            }
                            if (responseText) {
                                const json = JSON.parse(responseText);
                                translatedQuery = json[0].map(x => x[0] || "").join("");
                            }
                        } catch (e) {
                            console.error("Batch translate failed", e);
                        }
                        let translatedContents = [];
                        if (translatedQuery) {
                            translatedContents = translatedQuery.split(/[\[［]\s*[\[［]\s*[#＃]+\s*[\]］]\s*[\]］]/).map(s => s.trim());
                        }
                        let tIdx = 0;
                        for (let j = 0; j < batch.length; j++) {
                            const item = batch[j];
                            if (item.content) {
                                let transText = item.content;
                                if (translatedContents[tIdx]) {
                                    transText = translatedContents[tIdx];
                                }
                                translatedVtt += item.tc + "\n" + transText + "\n\n";
                                tIdx++;
                            } else {
                                translatedVtt += item.block + "\n\n";
                            }
                        }
                        updateLoadTxt(`${L.loading_translating} ${Math.min(i + BATCH_SIZE, validChunks.length)} / ${validChunks.length}`);
                    }
                    return translatedVtt;
                };
                let autoTranslatedText = "";
                // 隐私：字幕正文会被发送到 Google 翻译，默认关闭，仅在设置中显式开启后才自动翻译
                const translateEnabled = gmGet("pk_sub_translate", "false") === "true";
                if (translateEnabled && !name.toLowerCase().includes(`.${targetLang}.`)) {
                    try {
                        updateLoadTxt(L.loading_translating);
                        autoTranslatedText = await translateToGoogle(processedText, targetLang);
                    } catch (e) {
                        console.error("Translating failed", e);
                    }
                }
                const langMatch = name.match(/\.([a-zA-Z]{2,3}(-[a-zA-Z]+)?)\.(srt|vtt|ass)$/i);
                const originalLang = langMatch ? langMatch[1].toUpperCase() : `Original`;
                const originalBlob = new Blob([processedText], {
                    type: "text/vtt"
                });
                const origUrl = URL.createObjectURL(originalBlob);
                _subBlobUrls.push(origUrl);
                const safeName = esc(name);
                let html = `<track kind="captions" label="${originalLang} (${safeName})" srclang="${originalLang.toLowerCase()}" src="${origUrl}" />\n`;
                if (autoTranslatedText) {
                    const trBlob = new Blob([autoTranslatedText], {
                        type: "text/vtt"
                    });
                    const trUrl = URL.createObjectURL(trBlob);
                    _subBlobUrls.push(trUrl);
                    const langName = supportedLangs.find(l => l.code === targetLang)?.name || targetLang;
                    html += `<track kind="captions" label="${esc(langName)} (Auto)" srclang="${targetLang}" src="${trUrl}" default />\n`;
                } else {
                    html = `<track kind="captions" label="${originalLang} (${safeName})" srclang="${originalLang.toLowerCase()}" src="${origUrl}" default />\n`;
                }
                return html;
            };
            if (subFiles.length > 0 && !extraTracksHtml) {
                setLoad(true);
                updateLoadTxt(L.loading_subs);
                for (let i = 0; i < subFiles.length; i++) {
                    const sub = subFiles[i];
                    let subLink = sub.web_content_link;
                    if (!subLink) {
                        try {
                            const m = await apiGet(sub.id);
                            subLink = m.web_content_link;
                        } catch (e) { }
                    }
                    if (subLink) {
                        try {
                            const res = await fetch(subLink);
                            const text = await res.text();
                            tracksHtml += await processSubFile(text, sub.name);
                        } catch (e) {
                            console.warn("Sub fetch failed", e);
                        }
                    }
                }
                setLoad(false);
            }
            let langOptionsHtml = "";
            supportedLangs.forEach(l => {
                langOptionsHtml += `<option value="${l.code}" ${l.code === targetLang ? "selected" : ""}>-> ${l.name}</option>`;
            });
            const videoList = S.items.filter(v => v.mime_type?.startsWith("video") && v.phase === "PHASE_TYPE_COMPLETE");
            let currentVideoIdx = videoList.findIndex(v => v.id === item.id);
            const hasPrev = currentVideoIdx > 0;
            const hasNext = currentVideoIdx < videoList.length - 1;
            let d = document.getElementById("pk-player-ov");
            const isReuse = !!d;
            if (!isReuse) {
                d = document.createElement("div");
                d.id = "pk-player-ov";
                d.tabIndex = 0;
                document.body.appendChild(d);
            }
            let playlistHTML = "";
            videoList.forEach((v, idx) => {
                const isCur = idx === currentVideoIdx;
                playlistHTML += `<div class="pk-pl-item ${isCur ? "active" : ""}" data-idx="${idx}" style="padding:8px 12px;cursor:pointer;font-size:12px;border-bottom:1px solid #222;display:flex;align-items:center;gap:8px;color:${isCur ? "var(--pk-pri)" : "#ccc"};background:${isCur ? "rgba(76,194,255,0.08)" : "transparent"};transition:background 0.15s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"><span style="color:#555;font-size:10px;min-width:24px;">${idx + 1}</span><span style="overflow:hidden;text-overflow:ellipsis;">${esc(v.name)}</span></div>`;
            });
            if (!isReuse) {
                d.innerHTML = `<div style="position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.95);display:flex;justify-content:center;align-items:center;">\n                <div style="width:95vw;height:95vh;max-width:1600px;background:#000;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,0.8);display:flex;flex-direction:column;overflow:hidden;border:1px solid #333;">\n                    <div style="flex:0 0 48px;background:#111;padding:0 20px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #222; z-index: 10;">\n                        <div style="color:#eee;font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:12px;min-width:0;flex:1;">\n                            <svg width="18" height="18" viewBox="0 0 24 24" fill="var(--pk-pri)" style="flex-shrink:0;"><path d="M8 5v14l11-7z"/></svg>\n                            <span id="pk-player-title" style="overflow:hidden;text-overflow:ellipsis;">${esc(item.name)}</span>\n                            <span style="font-size:11px;color:#555;flex-shrink:0;">${currentVideoIdx >= 0 ? `${currentVideoIdx + 1}/${videoList.length}` : ""}</span>\n                        </div>\n\n                        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">\n                            <div style="display:flex;align-items:center;gap:2px;background:rgba(255,255,255,0.05);border-radius:4px;padding:2px 4px;border:1px solid rgba(255,255,255,0.1);">\n                                <button id="pk-player-prev" title="${L.tip_player_prev}" style="background:none;border:none;color:${hasPrev ? "#ccc" : "#333"};cursor:${hasPrev ? "pointer" : "default"};font-size:16px;padding:4px 6px;transition:all 0.2s;border-radius:3px;" ${hasPrev ? "" : "disabled"}>⏮</button>\n                                <button id="pk-player-next" title="${L.tip_player_next}" style="background:none;border:none;color:${hasNext ? "#ccc" : "#333"};cursor:${hasNext ? "pointer" : "default"};font-size:16px;padding:4px 6px;transition:all 0.2s;border-radius:3px;" ${hasNext ? "" : "disabled"}>⏭</button>\n                                <button id="pk-player-shuffle" title="${L.tip_player_shuffle}" style="background:none;border:none;color:#666;cursor:pointer;font-size:14px;padding:4px 6px;transition:all 0.2s;border-radius:3px;">🎲</button>\n                                <button id="pk-player-playlist" title="${L.tip_player_playlist}" style="background:none;border:none;color:#666;cursor:pointer;font-size:14px;padding:4px 6px;transition:all 0.2s;border-radius:3px;">📃</button>\n                            </div>\n                            <div style="width:1px;height:20px;background:#333;"></div>\n                            <button id="pk-player-sub" title="${L.tip_player_sub}" style="background:none;border:none;color:#888;cursor:pointer;font-size:13px;padding:4px 8px;transition:all 0.2s;border-radius:4px;border:1px solid #333;position:relative;">🔤 ${L.btn_player_sub}</button>\n                            <div id="pk-sub-menu" style="display:none;position:absolute;top:48px;right:100px;background:#1a1a1a;border:1px solid #333;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.5);z-index:999;min-width:240px;padding:6px 0;">\n                                <div style="padding:8px 14px;font-size:11px;color:#666;font-weight:600;border-bottom:1px solid #222;">${L.lbl_sub_settings}</div>\n                                <div style="padding:8px 14px;display:flex;align-items:center;gap:8px;cursor:pointer;color:#ccc;transition:background 0.15s;font-size:12px;" id="pk-sub-menu-lang" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='transparent'">\n                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2zm-2.62 7l1.62-4.33L19.12 17z"/></svg>\n                                    <span>${L.lbl_sub_lang}:</span>\n                                    <select id="pk-sub-lang-sel" style="background:#222;color:#eee;border:1px solid #444;border-radius:3px;font-size:11px;padding:2px 4px;outline:none;cursor:pointer;flex:1;">\n                                        ${langOptionsHtml}\n                                    </select>\n                                </div>\n                                <div style="padding:8px 14px;display:flex;align-items:center;gap:8px;color:#ccc;font-size:12px;">\n                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12.75 12a.75.75 0 0 1-.75.75H4.5a.75.75 0 0 1 0-1.5h7.5a.75.75 0 0 1 .75.75Zm9 0a.75.75 0 0 1-.75.75h-7.5a.75.75 0 0 1 0-1.5h7.5a.75.75 0 0 1 .75.75ZM7.5 7a.75.75 0 0 1-.75.75h-2.25a.75.75 0 0 1 0-1.5h2.25A.75.75 0 0 1 7.5 7Zm12 0a.75.75 0 0 1-.75.75H12.75a.75.75 0 0 1 0-1.5h6a.75.75 0 0 1 .75.75Zm-15 10a.75.75 0 0 1-.75.75H3.75a.75.75 0 0 1 0-1.5h.75a.75.75 0 0 1 .75.75Zm14.25 0a.75.75 0 0 1-.75.75H9.75a.75.75 0 0 1 0-1.5h9a.75.75 0 0 1 .75.75Z" /></svg>\n                                    <span>${L.lbl_sub_size}:</span>\n                                    <input type="range" id="pk-sub-size-sel" min="12" max="48" value="${typeof GM_getValue !== "undefined" ? GM_getValue("pk_sub_size", 20) : 20}" style="flex:1;cursor:pointer;height:2px;accent-color:var(--pk-pri);">\n                                    <span id="pk-sub-size-val" style="min-width:32px;text-align:right;font-size:10px;color:#888;">${typeof GM_getValue !== "undefined" ? GM_getValue("pk_sub_size", 20) : 20}px</span>\n                                </div>\n                                <label style="padding:8px 14px;display:flex;align-items:center;gap:8px;cursor:pointer;color:#ccc;transition:background 0.15s;font-size:12px;" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='transparent'">\n                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6z"/></svg>\n                                    <span>${L.lbl_sub_load_local}</span>\n                                    <input type="file" id="pk-local-sub" accept=".srt,.vtt,.ass" style="display:none;" />\n                                </label>\n                            </div>\n                            <button id="pk-player-ext" title="${L.tip_player_ext}" style="background:none;border:none;color:#888;cursor:pointer;font-size:13px;padding:4px 8px;transition:all 0.2s;border-radius:4px;border:1px solid #333;">🖥️</button>\n                            <button class="pk-close-btn" title="${L.tip_player_close}" style="color:#aaa;background:none;border:none;font-size:28px;cursor:pointer;width:36px;height:36px;display:flex;align-items:center;justify-content:center;transition:color 0.2s;line-height:1;">×</button>\n                        </div>\n                    </div>\n                    <div style="flex:1;display:flex;overflow:hidden;">\n                        <div style="flex:1;background:#000;position:relative;display:flex;align-items:center;justify-content:center;overflow:hidden;" id="pk-vid-con">\n                            <video id="pk-plyr-vid" playsinline controls autoplay preload="auto" crossorigin="anonymous" style="width:100%;height:100%;">\n                                ${tracksHtml}\n                            </video>\n                        </div>\n                        <div id="pk-playlist-panel" style="width:280px;background:#0a0a0a;border-left:1px solid #222;display:none;flex-direction:column;flex-shrink:0;">\n                            <div style="padding:10px 14px;border-bottom:1px solid #222;font-size:12px;font-weight:600;color:#888;display:flex;justify-content:space-between;align-items:center;">\n                                <span>🎥 ${L.lbl_playlist} (${videoList.length})</span>\n                            </div>\n                            <div id="pk-playlist-list" style="flex:1;overflow-y:auto;">${playlistHTML}</div>\n                        </div>\n                    </div>\n                </div>\n                <style>\n                    .pk-close-btn:hover{color:#fff}\n                    #pk-player-ov .plyr { width: 100%; height: 100%; }\n                    #pk-player-ov .plyr__video-wrapper { height: 100%; width: 100%; background: #000; }\n                    #pk-player-ov video { max-height: 100%; width: 100%; object-fit: contain; }\n                    #pk-player-ov .plyr__caption { font-size: var(--pk-sub-size, ${typeof GM_getValue !== "undefined" ? GM_getValue("pk_sub_size", 20) : 20}px) !important; text-shadow: 0 0 4px rgba(0,0,0,1), 0 0 8px rgba(0,0,0,0.8) !important; }\n                    .pk-sub-load-btn:hover { color: #fff !important; }\n                    #pk-player-prev:not(:disabled):hover, #pk-player-next:not(:disabled):hover { color: #fff !important; background: rgba(255,255,255,0.1); }\n                    #pk-player-shuffle:hover, #pk-player-playlist:hover, #pk-player-ext:hover { color: #fff !important; background: rgba(255,255,255,0.1); }\n                    #pk-player-shuffle.active { color: var(--pk-pri) !important; background: rgba(76,194,255,0.15); }\n                    #pk-player-playlist.active { color: var(--pk-pri) !important; background: rgba(76,194,255,0.15); }\n                    .pk-pl-item:hover { background: rgba(255,255,255,0.06) !important; }\n                    .pk-pl-item.active { font-weight: 600; }\n                    #pk-playlist-panel::-webkit-scrollbar, #pk-playlist-list::-webkit-scrollbar { width: 4px; }\n                    #pk-playlist-list::-webkit-scrollbar-thumb { background: #444; border-radius: 2px; }\n                </style>\n            </div>`;
            } else {
                d.querySelector("#pk-player-title").textContent = item.name;
                d.querySelector("#pk-player-title").nextElementSibling.textContent = currentVideoIdx >= 0 ? `${currentVideoIdx + 1}/${videoList.length}` : "";
                d.querySelector("#pk-playlist-list").innerHTML = playlistHTML;
                const pBtn = d.querySelector("#pk-player-prev");
                pBtn.disabled = !hasPrev;
                pBtn.style.color = hasPrev ? "#ccc" : "#333";
                pBtn.style.cursor = hasPrev ? "pointer" : "default";
                const nBtn = d.querySelector("#pk-player-next");
                nBtn.disabled = !hasNext;
                nBtn.style.color = hasNext ? "#ccc" : "#333";
                nBtn.style.cursor = hasNext ? "pointer" : "default";
                const vc = d.querySelector("#pk-vid-con");
                if (vc) vc.innerHTML = `<video id="pk-plyr-vid" playsinline controls autoplay preload="auto" crossorigin="anonymous" style="width:100%;height:100%;">${tracksHtml}</video>`;
            }
            d.focus();
            setTimeout(() => {
                const activeItem = d.querySelector(".pk-pl-item.active");
                if (activeItem) activeItem.scrollIntoView({
                    block: "center"
                });
            }, 100);
            const vidEl = d.querySelector("#pk-plyr-vid");
            let player = null;
            const langSel = d.querySelector("#pk-sub-lang-sel");
            const subSizeSel = d.querySelector("#pk-sub-size-sel");
            const subSizeVal = d.querySelector("#pk-sub-size-val");
            if (subSizeSel && subSizeVal) {
                subSizeSel.oninput = e => {
                    const val = e.target.value;
                    subSizeVal.textContent = val + "px";
                    document.documentElement.style.setProperty("--pk-sub-size", val + "px");
                };
                subSizeSel.onchange = e => {
                    if (typeof GM_setValue !== "undefined") GM_setValue("pk_sub_size", e.target.value);
                };
                document.documentElement.style.setProperty("--pk-sub-size", subSizeSel.value + "px");
            }
            langSel.onchange = e => {
                const newLang = e.target.value;
                targetLang = newLang;
                if (typeof GM_setValue !== "undefined") GM_setValue("pk_sub_lang", newLang);
                showToast(L.msg_translate_target.replace("{lang}", e.target.options[e.target.selectedIndex].text));
                const curTime = player ? player.currentTime : vidEl.currentTime;
                setLoad(true);
                updateLoadTxt(L.loading_restart_player);
                setTimeout(() => {
                    if (player) player.destroy();
                    playVideo(item, "", curTime, newLang);
                }, 100);
            };
            const manualSubInput = d.querySelector("#pk-local-sub");
            if (manualSubInput) {
                manualSubInput.onchange = async e => {
                    const file = e.target.files[0];
                    if (!file) return;
                    try {
                        setLoad(true);
                        updateLoadTxt(L.loading_local_sub);
                        const text = await file.text();
                        const html = await processSubFile(text, file.name, true);
                        let existingTracksHtml = "";
                        vidEl.querySelectorAll("track").forEach(t => existingTracksHtml += t.outerHTML);
                        const curTime = player ? player.currentTime : vidEl.currentTime;
                        if (player) player.destroy();
                        playVideo(item, existingTracksHtml + "\n" + html, curTime);
                        showToast(L.msg_local_sub_loaded);
                    } catch (err) { } finally {
                        setLoad(false);
                    }
                };
            }
            const initPlyr = () => {
                const PlyrFn = getPlyr();
                if (usePlyr && PlyrFn) {
                    player = new PlyrFn(vidEl, {
                        controls: ["play-large", "restart", "rewind", "play", "fast-forward", "progress", "current-time", "duration", "mute", "volume", "captions", "settings", "pip", "airplay", "fullscreen"],
                        settings: ["captions", "quality", "speed", "loop"],
                        autoplay: true,
                        captions: {
                            active: true,
                            update: true
                        },
                        keyboard: {
                            focused: true,
                            global: true
                        }
                    });
                    player.on("ready", () => {
                        setTimeout(() => {
                            if (player) {
                                player.captions.active = true;
                                if (targetLang) {
                                    player.language = targetLang;
                                }
                            }
                        }, 500);
                    });
                }
            };
            const HlsFn = getHls();
            if (streamLink.includes(".m3u8") && HlsFn && HlsFn.isSupported()) {
                const hls = new HlsFn;
                _currentHls = hls;
                hls.loadSource(streamLink);
                hls.attachMedia(vidEl);
                hls.on(HlsFn.Events.MANIFEST_PARSED, function () {
                    initPlyr();
                    if (startAt > 0) setTimeout(() => {
                        if (player) player.currentTime = startAt; else vidEl.currentTime = startAt;
                    }, 200);
                });
            } else {
                const source = document.createElement("source");
                source.src = streamLink;
                source.type = item.mime_type || "video/mp4";
                vidEl.appendChild(source);
                initPlyr();
                if (startAt > 0) setTimeout(() => {
                    if (player) player.currentTime = startAt; else vidEl.currentTime = startAt;
                }, 100);
            }
            const closePlayer = () => {
                destroyHls();
                revokeSubBlobs();
                if (player) player.destroy();
                d.remove();
            };
            const playByIndex = idx => {
                if (idx < 0 || idx >= videoList.length) return;
                if (player) player.destroy();
                playVideo(videoList[idx]);
            };
            const prevBtn = d.querySelector("#pk-player-prev");
            const nextBtn = d.querySelector("#pk-player-next");
            if (prevBtn && !prevBtn.disabled) prevBtn.onclick = () => playByIndex(currentVideoIdx - 1);
            if (nextBtn && !nextBtn.disabled) nextBtn.onclick = () => playByIndex(currentVideoIdx + 1);
            d.querySelector("#pk-player-shuffle").onclick = () => {
                if (videoList.length <= 1) return;
                let rndIdx;
                do {
                    rndIdx = Math.floor(Math.random() * videoList.length);
                } while (rndIdx === currentVideoIdx);
                playByIndex(rndIdx);
            };
            const plPanel = d.querySelector("#pk-playlist-panel");
            const plToggle = d.querySelector("#pk-player-playlist");
            plToggle.onclick = () => {
                const isOpen = plPanel.style.display === "flex";
                plPanel.style.display = isOpen ? "none" : "flex";
                plToggle.classList.toggle("active", !isOpen);
            };
            d.querySelector("#pk-playlist-list").onclick = e => {
                const itemEl = e.target.closest(".pk-pl-item");
                if (!itemEl) return;
                playByIndex(parseInt(itemEl.dataset.idx));
            };
            vidEl.addEventListener("ended", () => {
                if (currentVideoIdx < videoList.length - 1) {
                    playByIndex(currentVideoIdx + 1);
                }
            });
            const subBtn = d.querySelector("#pk-player-sub");
            const subMenu = d.querySelector("#pk-sub-menu");
            if (subBtn && subMenu) {
                subBtn.onclick = e => {
                    e.stopPropagation();
                    const isOpen = subMenu.style.display !== "none";
                    subMenu.style.display = isOpen ? "none" : "block";
                    subBtn.classList.toggle("active", !isOpen);
                };
            }
            const extBtn = d.querySelector("#pk-player-ext");
            const extPlayer = gmGet("pk_ext_player", "potplayer");
            const extLabel = extPlayer === "vlc" ? "VLC" : "PotPlayer";
            extBtn.textContent = `🖥️ ${extLabel}`;
            extBtn.onclick = () => {
                const scheme = extPlayer === "vlc" ? "vlc://" : "potplayer://";
                window.open(scheme + streamLink, "_self");
            };
            d.onkeydown = e => {
                if (e.key === "Escape") {
                    closePlayer();
                    e.stopPropagation();
                }
            };
            d.querySelector(".pk-close-btn").onclick = closePlayer;
            d.onclick = e => {
                if (e.target === d.firstElementChild) closePlayer(); else if (subMenu && !subMenu.contains(e.target) && e.target !== subBtn) subMenu.style.display = "none";
            };
        }

    async function openManager() {
        if (document.querySelector(".pk-ov")) return;
        _mgrAbort = new AbortController();
        const L = getStrings();
        const lang = getLang();
        S = {
            path: [{
                id: "",
                name: "🏠 Home"
            }],
            history: [],
            forward: [],
            items: [],
            display: [],
            sel: new Set,
            sort: "name",
            dir: 1,
            scanning: false,
            dupMode: false,
            dupRunning: false,
            dupReasons: new Map,
            dupGroups: new Map,
            dupSizeStrategy: "small",
            dupDateStrategy: "old",
            clipItems: [],
            clipType: "",
            clipSourceParentId: null,
            loading: false,
            lastSelIdx: -1,
            search: "",
            view: gmGet("pk_view_mode", "list"),
            gridZoom: parseInt(gmGet("pk_grid_zoom", "140"), 10),
            foldersFirst: gmGet("pk_folders_first", "true") === "true",
            filter: {
                ...DEFAULT_FILTER
            },
            filterActive: false,
            dupFilter: "all",
            dupCachedGroups: null
        };
        const el = createLayout(L, lang, version);
        initModal(UI.win, L);
        injectStyles();
        const sidebarOpen = gmGet("pk_sidebar_open", "false") === "true";
        if (sidebarOpen) {
            UI.sidebarEl.classList.add("open");
            UI.sidebarToggle.classList.add("active");
        }
        initSidebar(UI.sidebarEl, L, (folderId, folderName) => {
            if (S.loading) return;
            S.history.push({
                path: [...S.path]
            });
            S.forward = [];
            if (!folderId) {
                S.path = [{
                    id: "",
                    name: L.sidebar_home
                }];
            } else {
                S.path = [{
                    id: "",
                    name: L.sidebar_home
                }, {
                    id: folderId,
                    name: folderName
                }];
            }
            load();
        }, async (ids, targetFolderId) => {
            const currentFolderId = S.path[S.path.length - 1].id || "";
            if (ids.includes(targetFolderId)) {
                showToast(L.drag_move_same);
                return;
            }
            try {
                setLoad(true);
                await apiAction(":batchMove", {
                    ids,
                    to: {
                        parent_id: targetFolderId
                    }
                });
                showToast(L.drag_move_done.replace("{n}", ids.length));
                invalidateFolder(targetFolderId);
                S.items = S.items.filter(i => !ids.includes(i.id));
                ids.forEach(id => S.sel.delete(id));
                refresh();
            } catch (e) {
                showAlert(L.drag_move_fail.replace("{e}", e.message));
            } finally {
                setLoad(false);
            }
        });
        UI.sidebarToggle.onclick = () => {
            const isOpen = UI.sidebarEl.classList.toggle("open");
            UI.sidebarToggle.classList.toggle("active", isOpen);
            gmSet("pk_sidebar_open", isOpen ? "true" : "false");
        };
        const setLoad = b => {
            S.loading = b;
            setLoading(b, L);
        };
        const updateLoadTxt = txt => updateLoadingText(txt);
        const _updateNavState = () => {
            updateNavState();
        };
        const _updateStat = () => {
            updateStat(L);
        };
        const _render = () => {
            render();
        };
        setHandlers({
            onRowClick(e, d, i, chk) {
                if (S.loading) return;
                if (e.target.tagName === "INPUT") {
                    if (chk.checked) S.sel.add(d.id); else S.sel.delete(d.id);
                    S.lastSelIdx = i;
                } else if (e.shiftKey && S.lastSelIdx !== -1) {
                    const s = Math.min(S.lastSelIdx, i), end = Math.max(S.lastSelIdx, i);
                    for (let k = s; k <= end; k++) {
                        if (!S.display[k].isHeader) S.sel.add(S.display[k].id);
                    }
                } else if (e.ctrlKey || e.metaKey) {
                    chk.checked = !chk.checked;
                    if (chk.checked) S.sel.add(d.id); else S.sel.delete(d.id);
                    S.lastSelIdx = i;
                } else {
                    S.sel.clear();
                    S.sel.add(d.id);
                    S.lastSelIdx = i;
                }
                    renderList();
                _updateStat();
            },
            onRowDblClick(e, d) {
                e.preventDefault();
                if (S.loading) return;
                if (d.kind === "drive#folder") {
                    S.history.push({
                        path: [...S.path]
                    });
                    S.path.push({
                        id: d.id,
                        name: d.name
                    });
                    S.forward = [];
                    load();
                } else if (d.mime_type?.startsWith("video")) playVideo(d);
            },
            onRowContext(e, d, i) {
                e.preventDefault();
                if (!S.sel.has(d.id)) {
                    S.sel.clear();
                    S.sel.add(d.id);
                    S.lastSelIdx = i;
                            renderList();
                    _updateStat();
                }
                UI.ctx.style.display = "block";
                let x = e.clientX, y = e.clientY;
                const w = UI.ctx.offsetWidth || 150, h2 = UI.ctx.offsetHeight || 200;
                if (x + w > window.innerWidth) x = window.innerWidth - w - 10;
                if (y + h2 > window.innerHeight) y = window.innerHeight - h2 - 10;
                UI.ctx.style.left = x + "px";
                UI.ctx.style.top = y + "px";
            },
            onRowEnter(e, d) {
                if (d.thumbnail_link && !S.loading) {
                    UI.pop.innerHTML = `<img src="${d.thumbnail_link}">`;
                    UI.pop.style.display = "block";
                    const r = UI.pop.getBoundingClientRect();
                    let t = e.clientY + 15;
                    if (t + r.height > window.innerHeight) t = e.clientY - r.height - 10;
                    UI.pop.style.top = t + "px";
                    UI.pop.style.left = e.clientX + 15 + "px";
                }
            },
            onRowLeave() {
                UI.pop.style.display = "none";
            },
            onCardClick(e, d, idx, chk, card) {
                if (S.loading) return;
                if (e.target.tagName === "INPUT") {
                    if (chk.checked) S.sel.add(d.id); else S.sel.delete(d.id);
                    S.lastSelIdx = idx;
                } else if (e.shiftKey && S.lastSelIdx !== -1) {
                    const visibleItems = S.display.filter(v => !v.isHeader);
                    const s = Math.min(S.lastSelIdx, idx), end = Math.max(S.lastSelIdx, idx);
                    for (let k = s; k <= end; k++) {
                        S.sel.add(visibleItems[k].id);
                    }
                } else if (e.ctrlKey || e.metaKey) {
                    chk.checked = !chk.checked;
                    if (chk.checked) S.sel.add(d.id); else S.sel.delete(d.id);
                    S.lastSelIdx = idx;
                } else {
                    S.sel.clear();
                    S.sel.add(d.id);
                    S.lastSelIdx = idx;
                }
                    renderGrid();
                _updateStat();
            },
            onCardDblClick(e, d) {
                e.preventDefault();
                if (S.loading) return;
                if (d.kind === "drive#folder") {
                    S.history.push({
                        path: [...S.path]
                    });
                    S.path.push({
                        id: d.id,
                        name: d.name
                    });
                    S.forward = [];
                    load();
                } else if (d.mime_type?.startsWith("video")) playVideo(d);
            },
            onCardContext(e, d, card) {
                e.preventDefault();
                if (!S.sel.has(d.id)) {
                    S.sel.clear();
                    S.sel.add(d.id);
                    card.classList.add("sel");
                    _updateStat();
                }
                UI.ctx.style.display = "block";
                UI.ctx.style.left = e.clientX + "px";
                UI.ctx.style.top = e.clientY + "px";
            },
            async onDrop(ids, targetFolderId) {
                const currentFolderId = S.path[S.path.length - 1].id || "";
                if (ids.includes(targetFolderId)) {
                    showToast(L.drag_move_same);
                    return;
                }
                try {
                    setLoad(true);
                    await apiAction(":batchMove", {
                        ids,
                        to: {
                            parent_id: targetFolderId
                        }
                    });
                    showToast(L.drag_move_done.replace("{n}", ids.length));
                    invalidateFolder(targetFolderId);
                    S.items = S.items.filter(i => !ids.includes(i.id));
                    ids.forEach(id => S.sel.delete(id));
                    refresh();
                } catch (e) {
                    showAlert(L.drag_move_fail.replace("{e}", e.message));
                } finally {
                    setLoad(false);
                }
            }
        });
        initScrollHandler();
        function renderCrumb() {
            UI.crumb.innerHTML = "";
            S.path.forEach((p, i) => {
                const s = document.createElement("span");
                s.textContent = p.name;
                s.className = i === S.path.length - 1 ? "act" : "";
                s.onclick = () => {
                    if (i !== S.path.length - 1 && !S.loading) {
                        S.history.push({
                            path: [...S.path]
                        });
                        S.forward = [];
                        S.path = S.path.slice(0, i + 1);
                        load();
                    }
                };
                UI.crumb.appendChild(s);
                if (i < S.path.length - 1) UI.crumb.appendChild(document.createTextNode(" › "));
            });
        }
        const goBack = async () => {
            if (S.loading) return;
            if (S.history.length > 0) {
                S.forward.push([...S.path]);
                const prev = S.history.pop();
                S.path = prev.path;
                load(true);
                return;
            }
            if (S.path.length > 1) {
                S.forward.push([...S.path]);
                S.path = S.path.slice(0, S.path.length - 1);
                load(true);
                return;
            }
            if (S.path.length === 1 && S.history.length === 0) {
                if (await showConfirm(L.msg_exit_confirm)) {
                    el.remove();
                }
            }
        };
        const goForward = () => {
            if (S.forward.length > 0 && !S.loading) {
                S.history.push({
                    path: [...S.path]
                });
                const next = S.forward.pop();
                S.path = next;
                load();
            }
        };
        async function load(isHistoryNav = false) {
            if (S.loading) return;
            setLoad(true);
            S.search = "";
            if (UI.searchInput) UI.searchInput.value = "";
            const cur = S.path[S.path.length - 1];
            _updateNavState();
            UI.scan.style.display = "flex";
            UI.dup.style.display = "none";
            UI.dupTools.style.display = "none";
            S.dupMode = false;
            S.dupCachedGroups = null;
            S.lastSelIdx = -1;
            renderCrumb();
            highlightFolder(cur.id || "");
            try {
                if (!S.scanning) {
                    S.loadingNav = true;
                    const stopBtn = document.getElementById("pk-stop-load");
                    if (stopBtn) stopBtn.onclick = () => {
                        S.loadingNav = false;
                    };
                    const loadingMsgs = L.loading_msgs || [L.loading_detail];
                    updateLoadTxt(loadingMsgs[Math.floor(Math.random() * loadingMsgs.length)]);
                    S.items = await apiList(cur.id, 1e3, cnt => {
                        updateLoadTxt(L.loading_fetch.replace("{n}", cnt));
                    }, () => S.loadingNav);
                    refresh();
                }
            } catch (e) {
                if (e.message !== "AbortError") {
                    console.error(e);
                    showAlert(L.err_load + ": " + e.message);
                }
            } finally {
                S.loadingNav = false;
                setLoad(false);
            }
            el.focus();
        }
        function dupTagOf(key) {
            return key === "hash" ? L.tag_hash : key === "name" ? L.tag_name : L.tag_sim;
        }
        function renderDupDisplay() {
            S.dupReasons.clear();
            S.dupGroups.clear();
            const newDisplay = [];
            let gOut = 0;
            (S.dupCachedGroups || []).forEach(g => {
                if (S.dupFilter && S.dupFilter !== "all" && g.key !== S.dupFilter) return;
                const items = g.ids.map(id => S.items.find(x => x.id === id)).filter(Boolean);
                if (items.length < 2) return;
                const gIdx = gOut++;
                const tag = dupTagOf(g.key);
                newDisplay.push({
                    id: `grp_${gIdx}`,
                    isHeader: true,
                    name: items[0].name,
                    count: items.length,
                    type: tag
                });
                items.forEach(it => {
                    S.dupGroups.set(it.id, gIdx);
                    S.dupReasons.set(it.id, tag);
                    newDisplay.push(it);
                });
            });
            S.display = newDisplay;
            const currentIds = new Set(newDisplay.filter(x => !x.isHeader).map(i => i.id));
            for (let id of S.sel) {
                if (!currentIds.has(id)) S.sel.delete(id);
            }
            if (S.sel.size === 0) UI.chkAll.checked = false;
            _render();
            _updateStat();
        }
        async function refresh() {
            if (S.search) {
                const q = S.search.toLowerCase();
                S.display = S.items.filter(i => i.name.toLowerCase().includes(q));
            } else {
                S.display = [...S.items];
            }
            if (S.filterActive && countActiveFilters(S.filter) > 0) {
                S.display = applyFilter(S.display, S.filter);
            }
            S.dupReasons.clear();
            S.dupGroups.clear();
            if (S.dupMode) {
                if (S.dupCachedGroups) {
                    UI.dupTools.style.display = "flex";
                    renderDupDisplay();
                    return;
                }
                setLoad(true);
                S.dupRunning = true;
                UI.stopBtn.onclick = () => {
                    S.dupRunning = false;
                };
                updateLoadTxt(L.loading_dup.replace("{p}", 0));
                await sleep(50);
                const videos = S.display.filter(i => i.mime_type && (i.mime_type.startsWith("video") || i.mime_type.startsWith("image")));
                videos.sort((a, b) => a.name.length - b.name.length);
                const clean = name => name.replace(/\.[^/.]+$/, "").toLowerCase().trim();
                const VIDEO_EXT = new Set(["mp4", "mov", "mkv", "avi", "wmv", "flv", "webm", "ts", "m4v", "3gp", "mpg", "mpeg", "rmvb", "rm", "vob", "m2ts", "f4v"]);
                const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "tif", "ico", "heic", "heif", "avif"]);
                // 文件名一致时的同类判定：视频类与图片类互不算重复；未知扩展名仅与完全相同扩展名同类
                const nameKind = name => {
                    const dot = name.lastIndexOf(".");
                    const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
                    if (VIDEO_EXT.has(ext)) return "video";
                    if (IMAGE_EXT.has(ext)) return "image";
                    return "ext:" + ext;
                };
                const assigned = new Set;
                const groups = [];
                const chunkSize = 50;
                for (let i = 0; i < videos.length; i++) {
                    if (!S.dupRunning) break;
                    if (i % chunkSize === 0) {
                        updateLoadTxt(L.loading_dup.replace("{p}", Math.round(i / videos.length * 100)));
                        await sleep(0);
                    }
                    if (assigned.has(videos[i].id)) continue;
                    const root = videos[i];
                    const rootName = clean(root.name);
                    const rootHash = root.gcid || root.md5_checksum || root.hash;
                    const rootDur = parseFloat(root.params?.duration || 0);
                    const group = {
                        items: [root],
                        type: ""
                    };
                    assigned.add(root.id);
                    for (let j = i + 1; j < videos.length; j++) {
                        if (assigned.has(videos[j].id)) continue;
                        const target = videos[j];
                        let isDup = false;
                        let type = "";
                        const targetHash = target.gcid || target.md5_checksum || target.hash;
                        if (rootHash && targetHash && rootHash === targetHash && root.size === target.size) {
                            isDup = true;
                            type = "hash";
                        }
                        if (!isDup) {
                            const targetName = clean(target.name);
                            if (rootName === targetName && nameKind(root.name) === nameKind(target.name)) {
                                isDup = true;
                                type = "name";
                            } else if (rootDur > 0) {
                                if (Math.abs(rootDur - parseFloat(target.params?.duration || 0)) <= 1 && (targetName.includes(rootName) || rootName.includes(targetName))) {
                                    isDup = true;
                                    type = "sim";
                                }
                            }
                        }
                        if (isDup) {
                            if (!group.type) group.type = type;
                            if (type === group.type) {
                                group.items.push(target);
                                assigned.add(target.id);
                            }
                        }
                    }
                    if (group.items.length > 1) {
                        groups.push({
                            ids: group.items.map(i => i.id),
                            key: group.type
                        });
                    }
                }
                S.dupCachedGroups = groups;
                S.dupRunning = false;
                setLoad(false);
                UI.dupTools.style.display = "flex";
                renderDupDisplay();
                return;
            } else {
                UI.dupTools.style.display = "none";
                const activeOpt = document.querySelector(`.pk-sort-opt[data-k="${S.sort}"]`);
                const sortBtnLabel = document.querySelector("#pk-sort-b .pk-sort-label");
                const sortBtnDir = document.querySelector("#pk-sort-b .pk-sort-dir-icon");
                if (activeOpt && sortBtnLabel && sortBtnDir) {
                    const label = L["sort_" + S.sort.replace("_time", "")] || L["sort_" + S.sort] || activeOpt.textContent.trim().split(/\s+/)[0];
                    sortBtnLabel.textContent = label;
                    sortBtnDir.textContent = S.dir === 1 ? "▲" : "▼";
                }
                S.display.sort((a, b) => {
                    if (S.foldersFirst && a.kind !== b.kind) return a.kind === "drive#folder" ? -1 : 1;
                    let va, vb;
                    if (S.sort === "ext") {
                        va = (a.name || "").split(".").pop().toLowerCase();
                        vb = (b.name || "").split(".").pop().toLowerCase();
                    } else if (S.sort === "created_time") {
                        va = a.created_time || a.modified_time || "";
                        vb = b.created_time || b.modified_time || "";
                    } else if (S.sort === "size") {
                        va = parseInt(a.size || 0);
                        vb = parseInt(b.size || 0);
                    } else if (S.sort === "duration") {
                        va = parseInt(a.params?.duration || 0);
                        vb = parseInt(b.params?.duration || 0);
                    } else {
                        va = a[S.sort];
                        vb = b[S.sort];
                    }
                    if (va > vb) return S.dir;
                    if (va < vb) return -S.dir;
                    return 0;
                });
            }
            const currentIds = new Set(S.display.filter(x => !x.isHeader).map(i => i.id));
            for (let id of S.sel) {
                if (!currentIds.has(id)) S.sel.delete(id);
            }
            if (S.sel.size === 0) UI.chkAll.checked = false;
            _render();
            _updateStat();
        }
        async function getLinks() {
            const res = [];
            for (const id of S.sel) {
                let item = S.items.find(x => x.id === id);
                if (item && !item.web_content_link) {
                    try {
                        item = await apiGet(id);
                    } catch { }
                }
                if (item?.web_content_link) res.push(item);
            }
            return res;
        }
        async function getResourceLinks(onProgress) {
            const found = [];
            const skipped = [];
            const failed = [];
            const ids = Array.from(S.sel);
            for (let index = 0; index < ids.length; index++) {
                const id = ids[index];
                const listItem = S.items.find(x => x.id === id);
                try {
                    const detail = await apiGet(id);
                    const rawUrl = detail?.params?.url;
                    const url = typeof rawUrl === "string" ? rawUrl.trim() : "";
                    if (url) {
                        found.push({
                            id,
                            name: detail.name || listItem?.name || id,
                            url
                        });
                    } else {
                        skipped.push({
                            id,
                            name: detail?.name || listItem?.name || id
                        });
                    }
                } catch (error) {
                    console.warn("Failed to get resource link", id, error);
                    failed.push({
                        id,
                        name: listItem?.name || id,
                        error
                    });
                }
                if (onProgress) onProgress(index + 1, ids.length);
                if (index + 1 < ids.length) await sleep(120);
            }
            const uniqueByUrl = new Map;
            found.forEach(item => {
                if (!uniqueByUrl.has(item.url)) uniqueByUrl.set(item.url, item);
            });
            const links = Array.from(uniqueByUrl.values());
            return {
                links,
                skipped,
                failed,
                duplicates: found.length - links.length
            };
        }
        function normalizeTreeName(value) {
            return String(value || "").normalize("NFKC").trim().toLocaleLowerCase();
        }
        function parseDirectoryTreeNames(text) {
            const names = new Map;
            String(text || "").split(/\r?\n/).forEach(line => {
                let name = line.replace(/\0/g, "").replace(/^\uFEFF/, "").trimEnd();
                if (/^\s*\|[-\u2500\u2014]{2,}/.test(name)) return;
                name = name.replace(/^\s*(?:(?:[|\u2502\u2503]\s*)+)?(?:[\u251c\u2514\u250c\u252c]?\s*[-\u2500\u2014]+\s*)?/, "").trim();
                name = name.replace(/^.*[\\/]/, "").trim();
                const normalized = normalizeTreeName(name);
                if (normalized && !names.has(normalized)) names.set(normalized, name);
            });
            return names;
        }
        async function readDirectoryTreeFile(file) {
            const buffer = await file.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            let encoding = "utf-8";
            let offset = 0;
            if (bytes[0] === 0xff && bytes[1] === 0xfe) {
                encoding = "utf-16le";
                offset = 2;
            } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
                encoding = "utf-16be";
                offset = 2;
            } else if (bytes.length > 3 && bytes[1] === 0 && bytes[3] === 0) {
                encoding = "utf-16le";
            }
            return new TextDecoder(encoding).decode(bytes.subarray(offset));
        }
        function pickDirectoryTreeFile() {
            return new Promise(resolve => {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = ".txt,text/plain";
                input.style.display = "none";
                input.onchange = () => {
                    const file = input.files?.[0] || null;
                    input.remove();
                    resolve(file);
                };
                document.body.appendChild(input);
                input.click();
            });
        }

        el.tabIndex = 0;
        el.focus();
        const keyHandler = e => {
            if (!document.querySelector(".pk-ov")) return;
            if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
            if (e.key === "Escape") {
                const player = document.getElementById("pk-player-ov");
                if (player) {
                    destroyHls();
                    revokeSubBlobs();
                    player.remove();
                    return;
                }
                const openModal = document.querySelector(".pk-modal-ov");
                if (openModal) {
                    openModal.remove();
                    return;
                }
                if (UI.ctx.style.display === "block") UI.ctx.style.display = "none"; else if (S.sel.size > 0) {
                    S.sel.clear();
                    refresh();
                } else if (S.path.length === 1) closeManager();
                return;
            }
            if (e.key === "F2") {
                e.preventDefault();
                if (S.sel.size === 1) UI.btnRename.click(); else if (S.sel.size > 1) UI.btnBulkRename.click();
            }
            if (e.key === "F5") {
                e.preventDefault();
                UI.btnRefresh.click();
            }
            if (e.key === "F8") {
                e.preventDefault();
                UI.btnNewFolder.click();
            }
            if (e.key === "Delete") {
                UI.btnDel.click();
            }
            if (e.key === "Backspace") {
                e.preventDefault();
                if (e.shiftKey) {
                    if (!S.scanning) goForward();
                } else {
                    if (!S.scanning) goBack();
                }
                return;
            }
            if (e.altKey && e.key === "ArrowLeft") {
                e.preventDefault();
                goBack();
                return;
            }
            if (e.altKey && e.key === "ArrowRight") {
                e.preventDefault();
                goForward();
                return;
            }
            if (e.ctrlKey || e.metaKey) {
                if (e.key === "a" || e.key === "A") {
                    e.preventDefault();
                    UI.chkAll.click();
                }
                if (e.key === "c" || e.key === "C") {
                    e.preventDefault();
                    UI.btnCopy.click();
                }
                if (e.key === "x" || e.key === "X") {
                    e.preventDefault();
                    UI.btnCut.click();
                }
                if (e.key === "v" || e.key === "V") {
                    e.preventDefault();
                    UI.btnPaste.click();
                }
            }
            if (e.altKey) {
                if (e.key === "s" || e.key === "S") {
                    e.preventDefault();
                    UI.btnSettings.click();
                }
            }
        };
        document.addEventListener("keydown", keyHandler, {
            signal: _mgrAbort.signal
        });
        const mouseHandler = e => {
            if (!document.querySelector(".pk-ov")) return;
            if (e.button === 3) {
                e.preventDefault();
                e.stopPropagation();
                goBack();
            }
            if (e.button === 4) {
                e.preventDefault();
                e.stopPropagation();
                goForward();
            }
            if (UI.ctx.style.display === "block" && !UI.ctx.contains(e.target)) UI.ctx.style.display = "none";
        };
        document.addEventListener("mouseup", mouseHandler, {
            signal: _mgrAbort.signal
        });
        document.addEventListener("mouseenter", e => {
            const t = e.target.closest("[title]");
            if (!t) return;
            if (!t.closest(".pk-ov") && !t.closest("#pk-player-ov")) return;
            if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA") return;
            if (!t.dataset.tip) {
                t.dataset.tip = t.getAttribute("title");
                t.removeAttribute("title");
                const rect = t.getBoundingClientRect();
                if (rect.left < 100) t.classList.add("tip-r"); else if (window.innerWidth - rect.right < 100) t.classList.add("tip-l");
                if (t.closest("#pk-player-ov")) {
                    const header = t.closest('div[style*="flex:0 0 48px"]');
                    if (header) t.classList.add("tip-down");
                }
            }
        }, {
            capture: true,
            signal: _mgrAbort.signal
        });
        const lassoEl = document.createElement("div");
        lassoEl.className = "pk-lasso";
        lassoEl.style.display = "none";
        document.body.appendChild(lassoEl);
        const closeManager = () => {
            el.remove();
            lassoEl.remove();
            if (_mgrAbort) _mgrAbort.abort();
        };
        let lassoActive = false, lassoStartX = 0, lassoStartY = 0, lassoInitSel = new Set;
        UI.vp.addEventListener("mousedown", e => {
            if (e.button !== 0) return;
            if (e.target.closest(".pk-row") || e.target.closest(".pk-card") || e.target.closest(".pk-grid-hd")) return;
            lassoActive = true;
            lassoStartX = e.clientX;
            lassoStartY = e.clientY;
            lassoEl.style.left = lassoStartX + "px";
            lassoEl.style.top = lassoStartY + "px";
            lassoEl.style.width = "0px";
            lassoEl.style.height = "0px";
            lassoEl.style.display = "block";
            if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
                S.sel.clear();
                _render();
                _updateStat();
            }
            lassoInitSel = new Set(S.sel);
            document.body.style.userSelect = "none";
        });
        document.addEventListener("mousemove", e => {
            if (!lassoActive) return;
            const cx = e.clientX, cy = e.clientY;
            const left = Math.min(lassoStartX, cx), top = Math.min(lassoStartY, cy);
            const width = Math.abs(cx - lassoStartX), height = Math.abs(cy - lassoStartY);
            lassoEl.style.left = left + "px";
            lassoEl.style.top = top + "px";
            lassoEl.style.width = width + "px";
            lassoEl.style.height = height + "px";
            const lr = lassoEl.getBoundingClientRect();
            const items = S.view === "list" ? UI.in.querySelectorAll(".pk-row:not(.pk-group-hd)") : UI.in.querySelectorAll(".pk-card");
            items.forEach(el => {
                const id = el.dataset.id;
                if (!id) return;
                const r = el.getBoundingClientRect();
                const intersect = !(lr.right < r.left || lr.left > r.right || lr.bottom < r.top || lr.top > r.bottom);
                const shouldSelect = lassoInitSel.has(id) || intersect;
                if (shouldSelect) {
                    if (!S.sel.has(id)) {
                        S.sel.add(id);
                        el.classList.add("sel");
                        const chk = el.querySelector("input");
                        if (chk) chk.checked = true;
                    }
                } else {
                    if (S.sel.has(id)) {
                        S.sel.delete(id);
                        el.classList.remove("sel");
                        const chk = el.querySelector("input");
                        if (chk) chk.checked = false;
                    }
                }
            });
            _updateStat();
        }, {
            signal: _mgrAbort.signal
        });
        document.addEventListener("mouseup", () => {
            if (lassoActive) {
                lassoActive = false;
                lassoEl.style.display = "none";
                document.body.style.userSelect = "";
            }
        }, {
            signal: _mgrAbort.signal
        });
        if (UI.searchInput) {
            UI.searchInput.oninput = e => {
                S.search = e.target.value.trim();
                refresh();
            };
            UI.searchInput.onkeydown = async e => {
                e.stopPropagation();
                if (e.key === "Enter") {
                    e.preventDefault();
                    const q = e.target.value.trim();
                    if (!q) return;
                    S.scanning = true;
                    setLoad(true);
                    UI.stopBtn.onclick = () => {
                        S.scanning = false;
                        setLoad(false);
                    };
                    try {
                        let searchQueue = [{
                            id: "",
                            name: L.lbl_root || "Root",
                            path: ""
                        }];
                        let allFiles = [];
                        let matchCount = 0;
                        const lq = q.toLowerCase();
                        updateLoadTxt(L.loading_searching || "Searching...");
                        while (searchQueue.length && S.scanning) {
                            const curr = searchQueue.shift();
                            updateLoadTxt(L.status_scanning.replace("{n}", matchCount).replace("{s}", allFiles.length).replace("{f}", curr.name));
                            const files = await apiList(curr.id, 500, currentCount => {
                                updateLoadTxt(L.status_scanning.replace("{n}", matchCount).replace("{s}", allFiles.length + currentCount).replace("{f}", curr.name));
                            });
                            for (const f of files) {
                                if (f.kind === "drive#folder") {
                                    searchQueue.push({
                                        id: f.id,
                                        name: f.name,
                                        path: curr.path ? `${curr.path}/${f.name}` : f.name
                                    });
                                } else {
                                    f._path = curr.path || "";
                                    allFiles.push(f);
                                    if ((f.name || "").toLowerCase().includes(lq)) {
                                        matchCount++;
                                    }
                                }
                            }
                            await sleep(20);
                        }
                        if (S.scanning) {
                            S.items = allFiles.filter(i => (i.name || "").toLowerCase().includes(lq));
                            S.dupCachedGroups = null;
                            S.path = [{
                                id: "",
                                name: `Global Search: "${q}"`
                            }];
                            S.search = "";
                            UI.searchInput.value = "";
                            refresh();
                        }
                    } catch (err) {
                        showAlert(L.err_search + ": " + err.message);
                    } finally {
                        S.scanning = false;
                        setLoad(false);
                    }
                }
            };
        }
        UI.btnHelp.onclick = () => {
            const m = showModal(`\n            <h3 style="margin-bottom:16px;">${L.modal_help_title}</h3>\n            <div style="max-height:70vh;overflow-y:auto;font-size:13px;line-height:1.7;">\n                ${L.help_desc}\n            </div>\n            <div class="pk-modal-act" style="margin-top:20px;"><button class="pk-btn pri" id="help_close" style="width:100%;justify-content:center;height:40px;">${L.btn_close}</button></div>\n        `);
            m.querySelector("#help_close").onclick = () => m.remove();
        };
        UI.scan.onclick = async () => {
            if (S.scanning) {
                S.scanning = false;
                return;
            }
            if (!await showConfirm(L.msg_flatten_warn)) return;
            S.scanning = true;
            UI.stopBtn.onclick = () => {
                S.scanning = false;
            };
            const root = S.path[S.path.length - 1];
            let q = [{
                id: root.id,
                name: root.name,
                path: ""
            }];
            let all = [];
            setLoad(true);
            try {
                while (q.length && S.scanning) {
                    const curr = q.shift();
                    updateLoadTxt(L.status_scanning.replace("{n}", all.length).replace("{s}", all.length).replace("{f}", curr.name));
                    const files = await apiList(curr.id, 500, currentCount => {
                        updateLoadTxt(L.status_scanning.replace("{n}", all.length + currentCount).replace("{s}", all.length + currentCount).replace("{f}", curr.name));
                    });
                    for (const f of files) {
                        if (f.kind === "drive#folder") q.push({
                            id: f.id,
                            name: f.name,
                            path: curr.path ? `${curr.path}/${f.name}` : f.name
                        }); else {
                            f._path = curr.path || "";
                            all.push(f);
                        }
                    }
                    await sleep(20);
                }
                if (S.scanning) {
                    S.items = all;
                    S.dupCachedGroups = null;
                    UI.dup.style.display = "flex";
                    refresh();
                }
            } catch (e) {
                showAlert(L.err_generic + ": " + e.message);
            } finally {
                S.scanning = false;
                setLoad(false);
                _updateStat();
            }
        };
        UI.dup.onclick = async () => {
            if (!S.dupMode) if (!await showConfirm(L.msg_dup_warn)) return;
            S.dupMode = !S.dupMode;
            S.dupCachedGroups = null;
            S.dupFilter = "all";
            if (UI.dupFilter) UI.dupFilter.value = "all";
            UI.dup.style.backgroundColor = S.dupMode ? "#444" : "";
            UI.dup.style.color = S.dupMode ? "#fff" : "";
            UI.dup.style.borderColor = S.dupMode ? "#666" : "";
            refresh();
        };
        if (UI.dupFilter) UI.dupFilter.onchange = () => {
            S.dupFilter = UI.dupFilter.value;
            if (S.dupMode) renderDupDisplay();
        };
        if (UI.dlBtn && UI.dlMenu) {
            // 下载/导出下拉：主按钮开合菜单，点菜单项(原 button, handler 不变)后收起，点外收起
            UI.dlBtn.onclick = e => {
                e.stopPropagation();
                UI.dlMenu.classList.toggle("open");
            };
            UI.dlMenu.addEventListener("click", () => UI.dlMenu.classList.remove("open"));
            document.addEventListener("click", e => {
                if (!e.target.closest("#pk-dl-dd")) UI.dlMenu.classList.remove("open");
            }, {
                signal: _mgrAbort.signal
            });
        }
        UI.btnDupSize.onclick = () => {
            S.dupSizeStrategy = S.dupSizeStrategy === "small" ? "large" : "small";
            UI.condSize.textContent = `(${S.dupSizeStrategy === "small" ? L.cond_small : L.cond_large})`;
            S.sel.clear();
            const itemMap = new Map;
            S.display.forEach(d => {
                if (d.isHeader) return;
                const gIdx = S.dupGroups.get(d.id);
                if (gIdx !== undefined) {
                    if (!itemMap.has(gIdx)) itemMap.set(gIdx, []);
                    itemMap.get(gIdx).push(d);
                }
            });
            itemMap.forEach(items => {
                if (items.length < 2) return;
                let keep = S.dupSizeStrategy === "small" ? items.reduce((a, b) => parseInt(a.size) > parseInt(b.size) ? a : b) : items.reduce((a, b) => parseInt(a.size) < parseInt(b.size) ? a : b);
                items.forEach(i => {
                    if (i.id !== keep.id) S.sel.add(i.id);
                });
            });
            _render();
            _updateStat();
        };
        UI.btnDupDate.onclick = () => {
            S.dupDateStrategy = S.dupDateStrategy === "old" ? "new" : "old";
            UI.condDate.textContent = `(${S.dupDateStrategy === "old" ? L.cond_old : L.cond_new})`;
            S.sel.clear();
            const itemMap = new Map;
            S.display.forEach(d => {
                if (d.isHeader) return;
                const gIdx = S.dupGroups.get(d.id);
                if (gIdx !== undefined) {
                    if (!itemMap.has(gIdx)) itemMap.set(gIdx, []);
                    itemMap.get(gIdx).push(d);
                }
            });
            itemMap.forEach(items => {
                if (items.length < 2) return;
                let keep = S.dupDateStrategy === "old" ? items.reduce((a, b) => new Date(a.modified_time) > new Date(b.modified_time) ? a : b) : items.reduce((a, b) => new Date(a.modified_time) < new Date(b.modified_time) ? a : b);
                items.forEach(i => {
                    if (i.id !== keep.id) S.sel.add(i.id);
                });
            });
            _render();
            _updateStat();
        };
        UI.cols.forEach(c => c.onclick = () => {
            const k = c.dataset.k;
            if (S.sort === k) S.dir *= -1; else {
                S.sort = k;
                S.dir = 1;
            }
            refresh();
        });
        document.addEventListener("click", e => {
            const ddBtn = e.target.closest("#pk-sort-b");
            const opt = e.target.closest(".pk-sort-opt");
            const menu = document.getElementById("pk-sort-m");
            if (ddBtn && menu) {
                e.stopPropagation();
                menu.classList.toggle("open");
                menu.querySelectorAll(".pk-sort-opt").forEach(o => o.classList.remove("active"));
                menu.querySelectorAll(".pk-sort-dir").forEach(o => o.textContent = "");
                const initOpt = menu.querySelector(`.pk-sort-opt[data-k="${S.sort}"]`);
                if (initOpt) {
                    initOpt.classList.add("active");
                    const initDir = initOpt.querySelector(".pk-sort-dir");
                    if (initDir) initDir.textContent = S.dir === 1 ? " ▲" : " ▼";
                }
            } else if (opt && menu && menu.contains(opt)) {
                const k = opt.dataset.k;
                if (S.sort === k) S.dir *= -1; else {
                    S.sort = k;
                    S.dir = 1;
                }
                refresh();
                menu.classList.remove("open");
            } else if (menu && !e.target.closest("#pk-sort-dd")) {
                menu.classList.remove("open");
            }
        }, {
            signal: _mgrAbort.signal
        });
        const _updateFilterBadge = () => {
            const n = countActiveFilters(S.filter);
            const existing = UI.filterToggle.querySelector(".pk-filter-badge");
            if (existing) existing.remove();
            if (S.filterActive && n > 0) {
                const badge = document.createElement("span");
                badge.className = "pk-filter-badge";
                badge.textContent = n;
                UI.filterToggle.appendChild(badge);
            }
        };
        const _initFilterPanel = () => {
            UI.filterArea.innerHTML = createFilterPanelHTML(L, S.filter);
            const panel = UI.filterArea.querySelector(".pk-filter-panel");
            panel.classList.add("open");
            panel.querySelectorAll(".pk-filter-chip").forEach(ch => {
                ch.onclick = () => ch.classList.toggle("active");
            });
            panel.querySelector("#pk-filter-apply").onclick = () => {
                S.filter = readFilterFromPanel(panel);
                S.filterActive = countActiveFilters(S.filter) > 0;
                _updateFilterBadge();
                refresh();
            };
            panel.querySelector("#pk-filter-reset").onclick = () => {
                S.filter = {
                    ...DEFAULT_FILTER
                };
                S.filterActive = false;
                _updateFilterBadge();
                _initFilterPanel();
                refresh();
            };
        };
        UI.filterToggle.onclick = () => {
            let panel = UI.filterArea.querySelector(".pk-filter-panel");
            if (panel) {
                panel.classList.toggle("open");
                return;
            }
            _initFilterPanel();
        };
        UI.chkAll.onclick = e => {
            if (e.target.checked) S.display.forEach(i => S.sel.add(i.id)); else S.sel.clear();
            _render();
            _updateStat();
        };
        UI.btnBack.onclick = goBack;
        UI.btnFwd.onclick = goForward;
        UI.btnRefresh.onclick = () => load();
        UI.btnNewFolder.onclick = async () => {
            const name = await showPrompt(L.msg_newfolder_prompt, "");
            if (!name) return;
            const cur = S.path[S.path.length - 1];
            try {
                await pkFetch("https://api-drive.mypikpak.com/drive/v1/files", {
                    method: "POST",
                    body: JSON.stringify({
                        kind: "drive#folder",
                        parent_id: cur.id || "",
                        name
                    })
                });
                load();
            } catch (e) {
                showAlert(L.err_generic + ": " + e.message);
            }
        };
        UI.btnCopy.onclick = () => {
            if (S.sel.size === 0) return;
            S.clipItems = Array.from(S.sel);
            S.clipType = "copy";
            S.clipSourceParentId = S.path[S.path.length - 1].id || "";
            UI.btnPaste.disabled = false;
            showToast(L.msg_copy_done);
        };
        UI.btnCut.onclick = () => {
            if (S.sel.size === 0) return;
            S.clipItems = Array.from(S.sel);
            S.clipType = "move";
            S.clipSourceParentId = S.path[S.path.length - 1].id || "";
            UI.btnPaste.disabled = false;
            showToast(L.msg_cut_done);
        };
        UI.btnPaste.onclick = async () => {
            if (!S.clipItems || S.clipItems.length === 0) {
                showAlert(L.msg_paste_empty);
                return;
            }
            setLoad(true);
            const dest = S.path[S.path.length - 1].id || "";
            if (S.clipSourceParentId === dest) {
                showAlert(L.msg_paste_same_folder);
                setLoad(false);
                return;
            }
            const ids = S.clipItems.slice();
            const endpoint = S.clipType === "move" ? "https://api-drive.mypikpak.com/drive/v1/files:batchMove" : "https://api-drive.mypikpak.com/drive/v1/files:batchCopy";
            try {
                await pkFetch(endpoint, {
                    method: "POST",
                    body: JSON.stringify({
                        ids,
                        to: {
                            parent_id: dest
                        }
                    })
                });
                S.clipItems = [];
                S.clipType = "";
                UI.btnPaste.disabled = true;
                await sleep(500);
                setLoad(false);
                await load();
            } catch (e) {
                showAlert(L.err_paste + ": " + e.message);
                setLoad(false);
            }
        };
        UI.btnRename.onclick = async () => {
            if (S.sel.size !== 1) return;
            const id = Array.from(S.sel)[0];
            const item = S.items.find(i => i.id === id);
            if (!item) return;
            const m = showModal(`<h3>${L.modal_rename_title}</h3><div class="pk-field"><input type="text" id="rn_new_name" value="${esc(item.name)}"></div><div class="pk-modal-act"><button class="pk-btn" id="rn_cancel">${L.btn_cancel}</button><button class="pk-btn pri" id="rn_confirm">${L.btn_confirm}</button></div>`);
            const inp = m.querySelector("#rn_new_name");
            inp.focus();
            if (item.kind !== "drive#folder" && item.name.lastIndexOf(".") > 0) inp.setSelectionRange(0, item.name.lastIndexOf(".")); else inp.select();
            const doRename = async () => {
                const newName = inp.value.trim();
                if (!newName || newName === item.name) {
                    m.remove();
                    return;
                }
                if (S.items.some(i => i.id !== item.id && i.name === newName && i.parent_id === item.parent_id)) {
                    showAlert(L.msg_name_exists.replace("{n}", newName));
                    return;
                }
                m.remove();
                try {
                    setLoad(true);
                    await apiAction(`/${id}`, {
                        name: newName
                    });
                    await sleep(200);
                    setLoad(false);
                    load();
                } catch (e) {
                    showAlert(L.err_generic + ": " + e.message);
                    setLoad(false);
                }
            };
            m.querySelector("#rn_cancel").onclick = () => m.remove();
            m.querySelector("#rn_confirm").onclick = doRename;
            inp.onkeydown = e => {
                if (e.key === "Enter") doRename();
                if (e.key === "Escape") {
                    m.remove();
                    e.stopPropagation();
                }
            };
        };
        UI.btnBulkRename.onclick = () => {
            if (S.sel.size < 2) return;
            const m = showModal(`<h3>${L.modal_rename_multi_title}</h3><div class="pk-field"><label><input type="radio" name="rn_mode" value="pattern" checked> ${L.label_pattern}</label><input type="text" id="rn_pattern" value="Video {n}" placeholder="Video {n}"></div><div class="pk-field" style="margin-top:10px"><label><input type="radio" name="rn_mode" value="replace"> ${L.label_replace} <span style="font-size:11px;color:#888">${L.label_replace_note}</span></label><input type="text" id="rn_find" placeholder="${L.placeholder_find}" disabled><input type="text" id="rn_rep" placeholder="${L.placeholder_replace}" disabled></div><div style="margin-top: 15px; border: 1px solid var(--pk-bd); border-radius: 4px; max-height: 200px; display: flex; flex-direction: column; overflow: hidden; background: var(--pk-bg);"><div style="padding: 6px 10px; border-bottom: 1px solid var(--pk-bd); background: var(--pk-gh); font-size: 12px; font-weight: bold; flex-shrink: 0; color: var(--pk-gh-fg);">${L.label_preview}</div><div id="rn_live_preview" style="padding: 6px 10px; font-size: 11px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px;"></div></div><div class="pk-modal-act" style="margin-top: 15px;"><button class="pk-btn" id="rn_cancel">${L.btn_cancel}</button><button class="pk-btn pri" id="rn_confirm">${L.btn_confirm}</button></div>`);
            const radios = m.querySelectorAll('input[name="rn_mode"]');
            const inpPattern = m.querySelector("#rn_pattern");
            const inpFind = m.querySelector("#rn_find");
            const inpRep = m.querySelector("#rn_rep");
            const previewBox = m.querySelector("#rn_live_preview");
            const btnConfirm = m.querySelector("#rn_confirm");
            let currentChanges = [];
            const updatePreview = () => {
                const mode = m.querySelector('input[name="rn_mode"]:checked').value;
                const pattern = inpPattern.value;
                const findStr = inpFind.value;
                const repStr = inpRep.value || "";
                let idx = 1;
                const changes = [];
                // 按所属文件夹分别建立已有名称集合，避免扁平化/全局搜索时跨目录误判重名
                const namesByParent = new Map();
                const nameSetFor = pid => {
                    if (!namesByParent.has(pid)) namesByParent.set(pid, new Set(S.items.filter(i => i.parent_id === pid).map(i => i.name)));
                    return namesByParent.get(pid);
                };
                let errorMsg = null;
                for (const id of S.sel) {
                    const item = S.items.find(x => x.id === id);
                    if (!item) continue;
                    let base = item.name;
                    let ext = "";
                    if (item.kind !== "drive#folder" && item.name.lastIndexOf(".") > 0) {
                        base = item.name.substring(0, item.name.lastIndexOf("."));
                        ext = item.name.substring(item.name.lastIndexOf("."));
                    }
                    let newBase = base;
                    if (mode === "pattern") {
                        if (pattern) newBase = pattern.split("{n}").join(idx++);
                    } else {
                        if (findStr && base.includes(findStr)) newBase = base.split(findStr).join(repStr);
                    }
                    const finalName = newBase + ext;
                    if (finalName !== item.name) {
                        const existingNames = nameSetFor(item.parent_id);
                        if (existingNames.has(finalName)) {
                            errorMsg = L.msg_name_exists.replace("{n}", finalName);
                        }
                        changes.push({
                            id: item.id,
                            old: item.name,
                            new: finalName
                        });
                        existingNames.add(finalName);
                    }
                }
                currentChanges = changes;
                if (errorMsg) {
                    previewBox.innerHTML = `<div style="color: red; font-weight: bold">${esc(errorMsg)}</div>`;
                    btnConfirm.disabled = true;
                } else if (changes.length === 0) {
                    previewBox.innerHTML = `<div style="color: #888">No changes detected.</div>`;
                    btnConfirm.disabled = true;
                } else {
                    previewBox.innerHTML = changes.map(c => `<div style="display:flex; justify-content:space-between; border-bottom: 1px solid var(--pk-bd); padding-bottom: 2px;"><span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; opacity:0.7;" title="${esc(c.old)}">${esc(c.old)}</span><span style="margin:0 10px;color:#888;">→</span><span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--pk-pri); font-weight:600;" title="${esc(c.new)}">${esc(c.new)}</span></div>`).join("");
                    btnConfirm.disabled = false;
                }
            };
            const attachLiveEvent = el => el.addEventListener("input", updatePreview);
            attachLiveEvent(inpPattern);
            attachLiveEvent(inpFind);
            attachLiveEvent(inpRep);
            radios.forEach(r => r.onchange = () => {
                const isPat = r.value === "pattern";
                inpPattern.disabled = !isPat;
                inpFind.disabled = isPat;
                inpRep.disabled = isPat;
                updatePreview();
            });
            m.querySelector("#rn_cancel").onclick = () => m.remove();
            btnConfirm.onclick = async () => {
                if (currentChanges.length === 0) return;
                setLoad(true);
                let count = 0;
                try {
                    for (const c of currentChanges) {
                        await apiAction("/" + c.id, {
                            name: c.new
                        });
                        count++;
                        await sleep(50);
                    }
                    showToast(L.msg_bulkrename_done.replace("{n}", count));
                    load();
                } catch (e) {
                    // 中途失败：前 count 个已在服务端改名，刷新列表以反映真实状态并告知进度
                    showAlert(`${L.err_rename} (${count}/${currentChanges.length}): ` + e.message);
                    load();
                } finally {
                    setLoad(false);
                    m.remove();
                }
            };
            updatePreview();
        };
        UI.btnExt.onclick = async () => {
            const player = gmGet("pk_ext_player", "potplayer");
            if (S.sel.size === 0) {
                showToast(L.msg_no_selection);
                return;
            }
            if (S.sel.size > 1) {
                const files = await getLinks();
                if (!files.length) {
                    showAlert(L.msg_download_fail);
                    return;
                }
                let m3u = "#EXTM3U\n";
                files.forEach(f => {
                    m3u += `#EXTINF:-1,${f.name}\n${f.web_content_link}\n`;
                });
                const blob = new Blob([m3u], {
                    type: "audio/x-mpegurl"
                });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = `pikpak_playlist_${Date.now()}.m3u`;
                a.click();
                showAlert(L.msg_batch_m3u);
            } else {
                const files = await getLinks();
                if (!files.length) {
                    showAlert(L.msg_download_fail);
                    return;
                }
                window.open((player === "vlc" ? "vlc://" : "potplayer://") + files[0].web_content_link, "_self");
            }
        };
        UI.btnIdm.onclick = async () => {
            const files = await getLinks();
            if (!files || files.length === 0) {
                showAlert(L.msg_download_fail);
                return;
            }
            if (S.sel.size > 1) {
                let ef2 = "";
                files.forEach(f => {
                    ef2 += `<\r\n${f.web_content_link}\r\nfilename=${f.name}\r\n>\r\n`;
                });
                const blob = new Blob([ef2], {
                    type: "text/plain"
                });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = `pikpak_idm_${Date.now()}.ef2`;
                a.click();
                showAlert(L.msg_batch_ef2);
            } else {
                window.open(files[0].web_content_link, "_blank");
            }
        };
        UI.win.querySelector("#pk-down").onclick = async () => {
            const files = await getLinks();
            if (!files || files.length === 0) {
                showAlert(L.msg_download_fail);
                return;
            }
            for (const f of files) {
                const a = document.createElement("a");
                a.href = f.web_content_link;
                document.body.appendChild(a);
                a.click();
                a.remove();
                await sleep(200);
            }
        };
        UI.win.querySelector("#pk-aria2").onclick = async () => {
            const files = await getLinks();
            if (!files.length) {
                showAlert(L.msg_download_fail);
                return;
            }
            const ariaUrl = gmGet("pk_aria2_url", "ws://localhost:6800/jsonrpc");
            const ariaToken = gmGet("pk_aria2_token", "");
            const payload = files.map(f => ({
                jsonrpc: "2.0",
                method: "aria2.addUri",
                id: f.id,
                params: [`token:${ariaToken}`, [f.web_content_link], {
                    out: f.name
                }]
            }));
            try {
                const res = await fetch(ariaUrl, {
                    method: "POST",
                    body: JSON.stringify(payload),
                    headers: {
                        "Content-Type": "application/json"
                    }
                });
                if (!res.ok) throw new Error("HTTP " + res.status);
                // aria2 批量 JSON-RPC 返回结果数组，失败项带 error 字段——不要一律报成功
                const result = await res.json().catch(() => null);
                const failed = Array.isArray(result) ? result.filter(r => r && r.error).length : 0;
                if (failed > 0) throw new Error(`${failed}/${files.length} rejected`);
                showAlert(L.msg_aria2_sent.replace("{n}", files.length));
            } catch (e) {
                showAlert(L.err_generic + ": Aria2 - " + e.message);
            }
        };
        UI.btnDel.onclick = async () => {
            if (!S.sel.size) return;
            if (await showConfirm(L.warn_del.replace("{n}", S.sel.size))) {
                const allIds = Array.from(S.sel);
                const CHUNK = 100;
                const totalChunks = Math.ceil(allIds.length / CHUNK);
                const succeededIds = [];
                const failedIds = [];
                let cancelled = false;
                setLoad(true);
                UI.stopBtn.onclick = () => {
                    cancelled = true;
                };
                updateLoadTxt(L.loading_batch_delete.replace("{done}", 0).replace("{total}", allIds.length));
                try {
                    for (let c = 0; c < totalChunks; c++) {
                        if (cancelled) {
                            failedIds.push(...allIds.slice(c * CHUNK));
                            break;
                        }
                        const chunk = allIds.slice(c * CHUNK, (c + 1) * CHUNK);
                        updateLoadTxt(L.loading_batch_delete.replace("{done}", c * CHUNK + chunk.length).replace("{total}", allIds.length));
                        try {
                            // 复用 apiBatchTrash：有上限的 429 退避重试 + 读取 Retry-After + 解析错误体，
                            // 取代旧的 c-- 无限重试（服务端持续限流时只能靠手动停止退出）
                            await apiBatchTrash(chunk);
                            succeededIds.push(...chunk);
                        } catch (e) {
                            failedIds.push(...chunk);
                            console.error("batchTrash failed:", e);
                        }
                        if (c < totalChunks - 1) await sleep(200);
                    }
                    if (succeededIds.length) {
                        await sleep(500);
                        if (!S.scanning) {
                            await load();
                        } else {
                            const succeededSet = new Set(succeededIds);
                            S.items = S.items.filter(item => !succeededSet.has(item.id));
                            succeededIds.forEach(id => S.sel.delete(id));
                            await refresh();
                        }
                    }
                    if (failedIds.length > 0) await showAlert(L.msg_batch_delete_result.replace("{success}", succeededIds.length).replace("{failed}", failedIds.length));
                } finally {
                    setLoad(false);
                }
            }
        };
        UI.btnDeselect.onclick = () => {
            S.sel.clear();
            refresh();
        };
        if (UI.btnViewToggle) {
            UI.btnViewToggle.onclick = () => {
                S.view = S.view === "list" ? "grid" : "list";
                gmSet("pk_view_mode", S.view);
                UI.btnViewToggle.innerHTML = S.view === "list" ? CONF.icons.grid_view : CONF.icons.list_view;
                UI.btnViewToggle.title = S.view === "list" ? L.btn_view_grid : L.btn_view_list;
                if (UI.gridZoom) UI.gridZoom.style.display = S.view === "grid" ? "inline-block" : "none";
                _render();
            };
        }
        if (UI.gridZoom) {
            UI.gridZoom.oninput = e => {
                S.gridZoom = parseInt(e.target.value, 10);
                gmSet("pk_grid_zoom", S.gridZoom.toString());
                    renderGrid();
            };
        }
        if (UI.btnLinkCopy) {
            UI.btnLinkCopy.onclick = async () => {
                if (S.sel.size === 0) {
                    showToast(L.msg_no_selection);
                    return;
                }
                setLoad(true);
                try {
                    const links = await getLinks();
                    if (!links.length) {
                        showToast(L.msg_download_fail);
                        return;
                    }
                    const text = links.map(f => f.web_content_link).join("\n");
                    if (typeof GM_setClipboard !== "undefined") {
                        GM_setClipboard(text);
                    } else {
                        await navigator.clipboard.writeText(text);
                    }
                    showToast(L.msg_link_copied.replace("{n}", links.length));
                } catch (e) {
                    console.error(e);
                    showToast(L.msg_copy_fail);
                } finally {
                    setLoad(false);
                }
            };
        }
        if (UI.btnResourceCopy) {
            UI.btnResourceCopy.onclick = async () => {
                if (S.sel.size === 0) {
                    showToast(L.msg_no_selection || "No items selected.");
                    return;
                }
                setLoad(true);
                updateLoadTxt(L.loading_resource_links.replace("{done}", "0").replace("{total}", S.sel.size));
                try {
                    const result = await getResourceLinks((done, total) => {
                        updateLoadTxt(L.loading_resource_links.replace("{done}", done).replace("{total}", total));
                    });
                    const values = {
                        n: result.links.length,
                        skipped: result.skipped.length,
                        failed: result.failed.length,
                        duplicates: result.duplicates
                    };
                    if (!result.links.length) {
                        showToast(L.msg_resource_none.replace("{skipped}", values.skipped).replace("{failed}", values.failed));
                        return;
                    }
                    const text = result.links.map(item => item.url).join("\n");
                    if (typeof GM_setClipboard !== "undefined") {
                        GM_setClipboard(text);
                    } else {
                        await navigator.clipboard.writeText(text);
                    }
                    showToast(L.msg_resource_copied.replace("{n}", values.n).replace("{skipped}", values.skipped).replace("{failed}", values.failed).replace("{duplicates}", values.duplicates));
                } catch (e) {
                    console.error(e);
                    showToast(e?.message || L.err_generic);
                } finally {
                    setLoad(false);
                }
            };
        }
        if (UI.btnTreeSelect) {
            UI.btnTreeSelect.onclick = async () => {
                const file = await pickDirectoryTreeFile();
                if (!file) return;
                try {
                    const text = await readDirectoryTreeFile(file);
                    const treeNames = parseDirectoryTreeNames(text);
                    if (!treeNames.size) {
                        showToast(L.msg_tree_empty);
                        return;
                    }
                    const candidates = S.display.filter(item => item && !item.isHeader);
                    const matchedNames = new Set;
                    S.sel.clear();
                    candidates.forEach(item => {
                        const normalized = normalizeTreeName(item.name);
                        if (treeNames.has(normalized)) {
                            S.sel.add(item.id);
                            matchedNames.add(normalized);
                        }
                    });
                    UI.chkAll.checked = candidates.length > 0 && S.sel.size === candidates.length;
                    _render();
                    _updateStat();
                    showToast(L.msg_tree_selected.replace("{matched}", S.sel.size).replace("{total}", treeNames.size).replace("{unmatched}", treeNames.size - matchedNames.size));
                } catch (e) {
                    console.error(e);
                    showToast(L.msg_tree_read_fail);
                }
            };
        }
        UI.btnSettings.onclick = () => {
            const curLang = gmGet("pk_lang", lang);
            const curPlayer = gmGet("pk_ext_player", "potplayer");
            const curAriaUrl = gmGet("pk_aria2_url", "");
            const curAriaToken = gmGet("pk_aria2_token", "");
            const curFoldersFirst = S.foldersFirst;
            const curSubTranslate = gmGet("pk_sub_translate", "false") === "true";
            const m = showModal(`<h3>${L.modal_settings_title}<div style="font-size:11px;color:#888;font-weight:normal;margin-top:4px;">PikPak Assistant v${version}</div></h3><div class="pk-field"><label>${L.label_lang}</label><select id="set_lang"><option value="ko" ${curLang === "ko" ? "selected" : ""}>한국어</option><option value="en" ${curLang === "en" ? "selected" : ""}>English</option><option value="ja" ${curLang === "ja" ? "selected" : ""}>日本語</option><option value="zh" ${curLang === "zh" ? "selected" : ""}>中文 (简体)</option></select></div><div class="pk-field"><label>${L.label_player}</label><select id="set_player"><option value="potplayer" ${curPlayer === "potplayer" ? "selected" : ""}>PotPlayer</option><option value="vlc" ${curPlayer === "vlc" ? "selected" : ""}>VLC Player</option></select></div><div class="pk-field" style="flex-direction:row;align-items:center;gap:8px;"><input type="checkbox" id="set_folders_first" ${curFoldersFirst ? "checked" : ""}><label for="set_folders_first" style="cursor:pointer;user-select:none;">${L.label_folders_first}</label></div><div class="pk-field" style="flex-direction:row;align-items:center;gap:8px;"><input type="checkbox" id="set_sub_translate" ${curSubTranslate ? "checked" : ""}><label for="set_sub_translate" style="cursor:pointer;user-select:none;">${L.label_sub_translate}</label></div><div class="pk-field"><label>${L.label_aria2_url}</label><input type="text" id="set_aria_url" name="pk_aria2_addr" autocomplete="off" value="${esc(curAriaUrl)}" placeholder="ws://localhost:6800/jsonrpc"></div><div class="pk-field"><label>${L.label_aria2_token}</label><input type="text" id="set_aria_token" name="pk_aria2_tok" autocomplete="off" value="${esc(curAriaToken)}" placeholder="Empty"></div><div class="pk-modal-act"><button class="pk-btn" id="set_cancel">${L.btn_cancel}</button><button class="pk-btn pri" id="set_save">${L.btn_save}</button></div><div class="pk-credit"><b>제작: 브랜뉴(poihoii)</b><br><a href="https://github.com/poihoii/PikPak_FileManager" target="_blank">https://github.com/poihoii/PikPak_FileManager</a></div>`);
            m.querySelector("#set_cancel").onclick = () => m.remove();
            m.querySelector("#set_save").onclick = async () => {
                const saveBtn = m.querySelector("#set_save");
                const newLang = m.querySelector("#set_lang").value;
                const newPlayer = m.querySelector("#set_player").value;
                const newFoldersFirst = m.querySelector("#set_folders_first").checked;
                const newSubTranslate = m.querySelector("#set_sub_translate").checked;
                const newUrl = m.querySelector("#set_aria_url").value.trim();
                const newToken = m.querySelector("#set_aria_token").value.trim();
                const langChanged = newLang !== curLang;
                const foldersChanged = newFoldersFirst !== S.foldersFirst;
                // 所有设置无条件、独立保存——aria2 连不上也不影响语言/播放器等其它设置
                gmSet("pk_lang", newLang);
                gmSet("pk_ext_player", newPlayer);
                gmSet("pk_folders_first", newFoldersFirst ? "true" : "false");
                gmSet("pk_sub_translate", newSubTranslate ? "true" : "false");
                gmSet("pk_aria2_url", newUrl);
                gmSet("pk_aria2_token", newToken);
                S.foldersFirst = newFoldersFirst;
                // aria2 仅做可选的连通性检查：失败只提示，不回滚已保存的配置
                let aria2Warn = false;
                if (newUrl || newToken) {
                    saveBtn.disabled = true;
                    saveBtn.textContent = "...";
                    try {
                        const payload = {
                            jsonrpc: "2.0",
                            method: "aria2.getVersion",
                            id: "pk_test",
                            params: [`token:${newToken}`]
                        };
                        let fetchUrl = newUrl || "ws://localhost:6800/jsonrpc";
                        if (fetchUrl.startsWith("ws")) fetchUrl = fetchUrl.replace("ws", "http");
                        const res = await fetch(fetchUrl, {
                            method: "POST",
                            body: JSON.stringify(payload),
                            headers: {
                                "Content-Type": "application/json"
                            }
                        });
                        if (!res.ok) throw new Error("Network Error");
                        const data = await res.json();
                        if (data.error) throw new Error(data.error.message);
                    } catch (e) {
                        console.error(e);
                        aria2Warn = true;
                    }
                    saveBtn.disabled = false;
                    saveBtn.textContent = L.btn_save;
                }
                m.remove();
                // 只有语言变更需要重建整个 UI；其它设置即时/下次生效，避免无谓的整页刷新
                if (langChanged) {
                    await showAlert(L.msg_settings_saved);
                    location.reload();
                    return;
                }
                if (foldersChanged) refresh();
                showToast(L.msg_settings_saved);
                if (aria2Warn) showAlert(L.msg_aria2_check_fail);
            };
        };
        const ctx = el.querySelector("#pk-ctx");
        ctx.querySelector("#ctx-open").onclick = () => {
            ctx.style.display = "none";
            const id = Array.from(S.sel)[0];
            const item = S.items.find(i => i.id === id);
            if (item) {
                if (item.kind === "drive#folder") {
                    S.history.push({
                        path: [...S.path]
                    });
                    S.path.push({
                        id: item.id,
                        name: item.name
                    });
                    S.forward = [];
                    load();
                } else if (item.mime_type?.startsWith("video")) playVideo(item);
            }
        };
        ctx.querySelector("#ctx-ext-play").onclick = async () => {
            ctx.style.display = "none";
            const id = Array.from(S.sel)[0];
            const item = S.items.find(i => i.id === id);
            if (!item) return;
            let link = item.web_content_link;
            if (!link) {
                try {
                    const m = await apiGet(item.id);
                    link = m.web_content_link;
                } catch (e) { }
            }
            if (!link) {
                showToast(L.msg_link_fail);
                return;
            }
            const extPlayer = gmGet("pk_ext_player", "system");
            if (extPlayer === "potplayer") window.open("potplayer://" + link, "_self"); else if (extPlayer === "vlc") window.open("vlc://" + link, "_self"); else window.open("potplayer://" + link, "_self");
        };
        ctx.querySelector("#ctx-down").onclick = () => {
            ctx.style.display = "none";
            UI.win.querySelector("#pk-down").click();
        };
        ctx.querySelector("#ctx-copy").onclick = () => {
            ctx.style.display = "none";
            UI.btnCopy.click();
        };
        ctx.querySelector("#ctx-cut").onclick = () => {
            ctx.style.display = "none";
            UI.btnCut.click();
        };
        ctx.querySelector("#ctx-rename").onclick = () => {
            ctx.style.display = "none";
            UI.btnRename.click();
        };
        ctx.querySelector("#ctx-del").onclick = () => {
            ctx.style.display = "none";
            UI.btnDel.click();
        };
        UI.btnClose.addEventListener("click", closeManager);
        _updateStat();
        load();
    }
    console.log("🚀 PikPak Script: LOADED from index.js");
    function tryInject() {
        console.log("🚀 PikPak Script: Attempting inject...");
        if (document.getElementById("pk-launch")) {
            console.log("🚀 PikPak Script: Already injected.");
            return;
        }
        if (!document.body) {
            console.log("🚀 PikPak Script: Body not ready, retrying...");
            setTimeout(tryInject, 500);
            return;
        }
        inject();
        console.log("🚀 PikPak Script: INJECT SUCCESS!");
    }
    function inject() {
        if (document.getElementById("pk-launch")) return;
        const b = document.createElement("button");
        b.id = "pk-launch";
        b.style.cssText = `position:fixed;bottom:20px;right:20px;width:50px;height:50px;border-radius:50%;background:#1a5eff;border:none;cursor:pointer;z-index:2147483647;box-shadow:0 4px 12px rgba(0,0,0,0.3);padding:0;overflow:hidden;opacity:0.6;transition:transform 0.1s,opacity 0.2s;display:flex!important;align-items:center!important;justify-content:center!important;`;
        b.innerHTML = `<svg width="60%" height="60%" viewBox="0 0 238 200" version="1.1" xmlns="http://www.w3.org/2000/svg"><path d="M0 0 C1.82724609 0.01353516 1.82724609 0.01353516 3.69140625 0.02734375 C4.59761719 0.03894531 5.50382812 0.05054688 6.4375 0.0625 C5.95097979 7.11704304 4.33696858 12.90149479 1.6875 19.4375 C1.35234375 20.32566406 1.0171875 21.21382812 0.671875 22.12890625 C0.3315625 22.98097656 -0.00875 23.83304688 -0.359375 24.7109375 C-0.66198242 25.47583496 -0.96458984 26.24073242 -1.27636719 27.02880859 C-3.01571023 29.77913653 -4.60880008 30.70366989 -7.5625 32.0625 C-10.93383789 32.72265625 -10.93383789 32.72265625 -14.78515625 33.125 C-15.47874237 33.20142731 -16.17232849 33.27785461 -16.88693237 33.3565979 C-18.36660067 33.51855298 -19.84685768 33.67520381 -21.3276062 33.82696533 C-25.19232303 34.22318595 -29.05286739 34.65697538 -32.9140625 35.0859375 C-33.67180466 35.16903168 -34.42954681 35.25212585 -35.21025085 35.33773804 C-40.99791882 35.97875931 -46.74864414 36.77615252 -52.5 37.6875 C-61.81496788 39.10080547 -71.19269316 40.07620454 -80.5625 41.0625 C-19.8425 41.0625 40.8775 41.0625 103.4375 41.0625 C91.8875 39.7425 80.3375 38.4225 68.4375 37.0625 C63.8175 36.4025 59.1975 35.7425 54.4375 35.0625 C49.17221542 34.42736314 43.90722683 33.79696512 38.63671875 33.20703125 C37.62996094 33.08714844 36.62320313 32.96726563 35.5859375 32.84375 C34.69052246 32.74126953 33.79510742 32.63878906 32.87255859 32.53320312 C30.35601376 32.0467485 28.59527547 31.44037784 26.4375 30.0625 C23.38532266 24.97553776 21.3341425 19.45473677 19.1875 13.9375 C18.91695801 13.25671387 18.64641602 12.57592773 18.36767578 11.87451172 C16.82394482 7.78804812 16.13851057 4.42502757 16.4375 0.0625 C33.20320897 -0.76054389 50.04132 2.04640823 66.578125 4.53515625 C70.96365446 5.13439358 75.35589707 5.627565 79.75488281 6.11669922 C97.85972043 8.13836316 97.85972043 8.13836316 106.6875 9.4375 C107.39487305 9.52700928 108.10224609 9.61651855 108.83105469 9.70874023 C113.96714941 10.51808328 116.87598017 12.31623275 120.4375 16.0625 C121.69830294 18.53927732 122.67025259 20.7202309 123.5625 23.3125 C124.02136126 24.56846882 124.48232815 25.8236702 124.9453125 27.078125 C125.27250149 28.00288179 125.27250149 28.00288179 125.60630035 28.94632053 C126.38750394 31.05750635 126.38750394 31.05750635 127.44002533 32.93062496 C131.07482517 39.83448151 131.00351579 46.31795394 130.95507812 53.99243164 C130.96050802 55.37978344 130.96763552 56.76712947 130.97631836 58.15446472 C130.99445028 61.89829685 130.98752708 65.6416848 130.97480202 69.38552403 C130.96462344 73.31622656 130.97408092 77.24689291 130.98034668 81.17759705 C130.98760817 87.77544941 130.97807403 94.37312221 130.95898438 100.97094727 C130.93720936 108.58452515 130.94427739 116.19767461 130.96629 123.81124216 C130.98447611 130.36524706 130.98698696 136.91912344 130.97653532 143.47314543 C130.97031913 147.38014362 130.96941296 151.2869408 130.98268127 155.19392586 C130.99428653 158.8672447 130.9861299 162.54001414 130.96310425 166.213274 C130.95534421 168.19404482 130.96713242 170.17486244 130.97961426 172.15560913 C130.90049754 180.52230774 129.95755225 186.09535704 124.25390625 192.5234375 C123.51011719 193.15507812 122.76632813 193.78671875 122 194.4375 C121.25878906 195.08460938 120.51757812 195.73171875 119.75390625 196.3984375 C114.7661098 199.98157627 110.22842399 200.35421576 104.22135925 200.32992554 C103.39785408 200.33445665 102.5743489 200.33898776 101.72588903 200.34365618 C98.968488 200.35630894 96.21128426 200.35467924 93.45385742 200.35302734 C91.475975 200.35901206 89.49809491 200.36581748 87.5202179 200.37338257 C82.14823484 200.39105594 76.77631549 200.39573853 71.40430617 200.39701414 C66.91878502 200.39891354 62.4332787 200.40627158 57.94776326 200.41335833 C47.36384951 200.42964512 36.77996977 200.43452703 26.19604492 200.43310547 C15.28118177 200.43190408 4.36651636 200.45300486 -6.54829675 200.4845928 C-15.92170288 200.51075235 -25.29504442 200.52147289 -34.66848677 200.52019465 C-40.26569836 200.51968491 -45.86273424 200.52537507 -51.45990944 200.54655075 C-56.725388 200.56592749 -61.99052314 200.5660613 -67.25601387 200.55151749 C-69.1861191 200.54942757 -71.11624579 200.55414114 -73.04631424 200.5662384 C-75.68641426 200.58171127 -78.32533312 200.57236959 -80.96540833 200.55697632 C-81.72466655 200.56726344 -82.48392478 200.57755057 -83.26619083 200.58814943 C-90.327556 200.49750269 -96.39704041 197.82485418 -101.375 192.75 C-102.18904297 191.95142578 -102.18904297 191.95142578 -103.01953125 191.13671875 C-108.29053612 184.05088689 -108.01804154 177.09915158 -108.0300293 168.55004883 C-108.04229625 167.18245883 -108.05575106 165.81487905 -108.07029724 164.4473114 C-108.10523797 160.74401042 -108.12059214 157.04088761 -108.13013434 153.33744264 C-108.13673436 151.01403475 -108.14708893 148.69067299 -108.15863991 146.36728477 C-108.19836069 138.23287671 -108.22038571 130.09860956 -108.22827148 121.96411133 C-108.23610728 114.43116961 -108.28516577 106.89925647 -108.35333699 99.36664182 C-108.41007964 92.86514961 -108.43519788 86.36399446 -108.43721896 79.86225718 C-108.43904166 75.9947118 -108.45309089 72.1282487 -108.50003624 68.26096535 C-108.72797687 48.29049317 -107.52961567 30.83210742 -95.5625 14.0625 C-92.23797604 10.732487 -88.44904231 10.20048941 -83.953125 9.5 C-83.20613342 9.37633057 -82.45914185 9.25266113 -81.68951416 9.12524414 C-74.04584045 7.901492 -66.3645662 7.06662299 -58.66394043 6.29776001 C-54.62860447 5.8940274 -50.59547976 5.46951727 -46.5625 5.04296875 C-45.77776306 4.96008102 -44.99302612 4.8771933 -44.18450928 4.79179382 C-36.33754684 3.9513441 -28.53467892 2.87051571 -20.734375 1.67578125 C-13.79617508 0.63078847 -7.03103815 -0.06826251 0 0 Z M-37.4375 87.4375 C-41.76814335 92.78711826 -40.78388874 98.21215336 -40.8125 104.875 C-40.833125 106.06416016 -40.85375 107.25332031 -40.875 108.47851562 C-40.88015625 109.62642578 -40.8853125 110.77433594 -40.890625 111.95703125 C-40.8999707 113.00737549 -40.90931641 114.05771973 -40.91894531 115.13989258 C-40.50704184 118.51721889 -39.58167158 120.34513508 -37.5625 123.0625 C-33.8251144 125.5540904 -31.98918417 125.52043285 -27.5625 125.0625 C-24.80920979 123.26687595 -23.03622539 122.00995078 -21.5625 119.0625 C-21.2630429 114.46407809 -21.28436362 109.85701583 -21.25 105.25 C-21.20649414 103.32317383 -21.20649414 103.32317383 -21.16210938 101.35742188 C-21.15373047 100.11927734 -21.14535156 98.88113281 -21.13671875 97.60546875 C-21.12213623 96.47133545 -21.10755371 95.33720215 -21.0925293 94.16870117 C-21.66318532 90.39703539 -22.92773916 88.76654018 -25.5625 86.0625 C-30.04892468 83.81928766 -33.65294159 84.31112566 -37.4375 87.4375 Z M45.4375 89.0625 C43.16309531 93.61130937 44.11732026 99.81887268 44.0625 104.8125 C44.02511719 106.08867188 43.98773438 107.36484375 43.94921875 108.6796875 C43.6563417 116.25277258 43.6563417 116.25277258 46.7109375 122.91015625 C50.0632924 125.55649945 51.41007501 125.90713502 55.50390625 125.58984375 C58.83921214 124.68021487 60.4149221 122.75927054 62.4375 120.0625 C64.03299443 115.26404894 63.62174204 110.1852134 63.625 105.1875 C63.64336914 103.71603516 63.64336914 103.71603516 63.66210938 102.21484375 C63.77173933 93.57358621 63.77173933 93.57358621 59.75 86.1875 C54.0132506 83.39664894 49.78182352 84.71817648 45.4375 89.0625 Z M-18.5625 155.0625 C-20.89546251 157.88967213 -20.89546251 157.88967213 -20.3125 161.125 C-19.8031756 164.161959 -19.8031756 164.161959 -17.5625 166.0625 C-15.5023267 166.81656896 -13.41368556 167.49416461 -11.3125 168.125 C-10.19359375 168.46660156 -9.0746875 168.80820313 -7.921875 169.16015625 C-1.62436639 170.85169635 4.26860909 171.24487637 10.75 171.25 C11.9555957 171.26836914 11.9555957 171.26836914 13.18554688 171.28710938 C21.14907742 171.30632948 28.31945463 169.57146397 35.875 167.125 C36.88433594 166.80660156 37.89367187 166.48820313 38.93359375 166.16015625 C41.73511224 165.200361 41.73511224 165.200361 43.4375 162.0625 C43.1133631 158.74009676 42.82973697 157.45473697 40.4375 155.0625 C35.63637087 154.61062902 31.50016124 155.74460874 26.9375 157.0625 C14.69655136 160.31686985 0.092469 160.8899845 -11.5625 155.0625 C-15.0625 154.72916667 -15.0625 154.72916667 -18.5625 155.0625 Z " fill="#FDFDFD" transform="translate(107.5625,-0.0625)"/></svg>`;
        const savedLeft = gmGet("pk_pos_left", null);
        const savedTop = gmGet("pk_pos_top", null);
        if (savedLeft !== null && savedTop !== null) {
            b.style.bottom = "auto";
            b.style.right = "auto";
            b.style.left = savedLeft;
            b.style.top = savedTop;
        }
        let isDragging = false, dragStartX, dragStartY;
        b.onmouseenter = () => { b.style.opacity = "1"; };
        b.onmouseleave = () => { b.style.opacity = "0.6"; };
        b.onmousedown = e => {
            isDragging = false;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            const rect = b.getBoundingClientRect();
            b.style.bottom = "auto";
            b.style.right = "auto";
            b.style.left = rect.left + "px";
            b.style.top = rect.top + "px";
            b.style.transition = "none";
            const offsetX = e.clientX - rect.left, offsetY = e.clientY - rect.top;
            const onMove = em => {
                if (!isDragging && (Math.abs(em.clientX - dragStartX) > 3 || Math.abs(em.clientY - dragStartY) > 3)) isDragging = true;
                if (isDragging) {
                    b.style.left = em.clientX - offsetX + "px";
                    b.style.top = em.clientY - offsetY + "px";
                }
            };
            const onUp = () => {
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
                b.style.transition = "transform 0.1s";
                if (!isDragging) openManager(); else {
                    gmSet("pk_pos_left", b.style.left);
                    gmSet("pk_pos_top", b.style.top);
                }
            };
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        };
        document.body.appendChild(b);
        console.log("🚀 Button Created!");
    }
    const startObserver = () => {
        // 低频轮询代替全页面 MutationObserver：PikPak SPA 的 DOM 变动极频繁，
        // subtree 监听会让浏览器为全站每次变动生成记录，持续消耗 CPU
        setInterval(() => {
            if (!document.getElementById("pk-launch")) tryInject();
        }, 3000);
    };
    if (document.readyState === "loading") {
        window.addEventListener("DOMContentLoaded", () => {
            tryInject();
            startObserver();
        });
    } else {
        tryInject();
        startObserver();
    }
