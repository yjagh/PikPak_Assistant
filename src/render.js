// Render module (refactor E). Virtualized list/grid renderers.
//
// E-full: renderVisibleList/renderVisibleGrid reconcile a keyed node pool
// instead of tearing down UI.in and rebuilding every row/card on each scroll
// frame and selection change. Rows/cards are absolutely positioned by index,
// so reconciliation needs no DOM reordering — only create / reuse / reposition
// / remove, keyed by item id (list headers by "h:type:name"). The per-cell
// decision is the pure, unit-tested planCell() (src/render_plan.js); the rest
// is mechanical DOM. DOM state after each render is identical to the old
// full-rebuild code, minus the churn — notably grid <img> thumbnails are no
// longer recreated on every scroll frame, so they stop reloading/flickering.
//
// Owns its view state (_gridCache/_lastListRange/_scrollPending + the pools),
// getIcon, applyDragDrop, initScrollHandler; cross-references main.js only at
// call time (after openManager populates UI and sets _h), so the circular
// import flattens with no TDZ.
import { esc, fmtSize, fmtDur, fmtDate } from "./utils.js";
import { CONF } from "./config.js";
import { S, UI, _h, getStrings } from "./main.js";
import { planCell } from "./render_plan.js";

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
    // --- keyed node pool (E-full) ---
    // list rows keyed by id (data) or "h:type:name" (group header); grid cards
    // keyed by id. Entry shape: { el, d, index, sel }.
    let _listPool = new Map();
    let _gridPool = new Map();
    let _poolContainer = null; // UI.in identity — changes when the manager re-opens
    let _poolKind = null;      // "list" | "grid" — changes when the view toggles
    let _gridGeom = null;      // "cols:cardW:cardH:gap" — when it changes, every card repositions
    // Hard reset when the container element or the view kind changes: drop both
    // pools and clear the container so stale/foreign nodes never linger.
    function resetPoolIfNeeded(kind) {
        if (_poolContainer === UI.in && _poolKind === kind) return;
        UI.in.innerHTML = "";
        _listPool.clear();
        _gridPool.clear();
        _poolContainer = UI.in;
        _poolKind = kind;
        _gridGeom = null;
    }
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
export function render() {
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
export function renderList() {
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
        resetPoolIfNeeded("list");
        const display = S.display;
        const sel = S.sel;
        const top = UI.vp.scrollTop, h = UI.vp.clientHeight;
        const start = Math.max(0, Math.floor(top / CONF.rowHeight) - CONF.buffer);
        const end = Math.min(display.length, Math.ceil((top + h) / CONF.rowHeight) + CONF.buffer);
        _lastListRange.start = start;
        _lastListRange.end = end;
        const needed = new Set();
        for (let i = start; i < end; i++) {
            const d = display[i];
            if (!d) continue;
            const key = d.isHeader ? `h:${d.type}:${d.name}` : d.id;
            needed.add(key);
            const isSel = d.isHeader ? false : sel.has(d.id);
            const prev = _listPool.get(key);
            const plan = planCell(prev, d, i, isSel);
            const row = plan.create ? document.createElement("div") : prev.el;
            if (plan.create) {
                row.style.position = "absolute";
                row.style.width = "100%";
                UI.in.appendChild(row);
            }
            if (plan.position) row.style.top = `${i * CONF.rowHeight}px`;
            if (d.isHeader) {
                if (plan.content) {
                    row.className = "pk-group-hd";
                    row.innerHTML = `<div style="display:flex;align-items:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"><span style="margin-right:8px;">📁</span><span>${esc(d.name)}</span></div><div style="margin-left:auto;display:flex;align-items:center;"><span class="pk-tag">${d.type}</span><span class="pk-cnt">${d.count}</span></div>`;
                }
            } else {
                if (plan.content) {
                    row.className = `pk-row ${isSel ? "sel" : ""}`;
                    row.dataset.id = d.id;
                    const durVal = d.params?.duration || d.medias?.[0]?.duration || d.video_media_metadata?.duration || "";
                    const fullTitle = d._path ? `${d._path}/${d.name}` : d.name;
                    row.innerHTML = `<div><input type="checkbox" ${isSel ? "checked" : ""}></div><div class="pk-name" title="${esc(fullTitle)}">${getIcon(d)}<span class="pk-name-col"><span>${esc(d.name)}</span>${d._path ? `<span class="pk-path-sub">${esc(d._path)}</span>` : ""}</span></div><div>${d.kind === "drive#folder" ? "" : fmtSize(d.size)}</div><div>${fmtDur(durVal)}</div><div style="color:#888">${fmtDate(d.modified_time)}</div>`;
                } else if (plan.sel) {
                    row.classList.toggle("sel", isSel);
                    const chk = row.querySelector("input");
                    if (chk) chk.checked = isSel;
                }
                if (plan.click && _h) {
                    const chk = row.querySelector("input");
                    row.onclick = e => _h.onRowClick(e, d, i, chk);
                    row.ondblclick = e => _h.onRowDblClick(e, d);
                    row.oncontextmenu = e => _h.onRowContext(e, d, i);
                    row.onmouseenter = e => _h.onRowEnter(e, d);
                    row.onmouseleave = () => _h.onRowLeave();
                }
                if (plan.drag) applyDragDrop(row, d);
            }
            _listPool.set(key, { el: row, d, index: i, sel: isSel });
        }
        for (const key of [..._listPool.keys()]) {
            if (!needed.has(key)) { _listPool.get(key).el.remove(); _listPool.delete(key); }
        }
    }
export function renderGrid() {
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
        resetPoolIfNeeded("grid");
        const { items, cols, cardW, cardH, gap } = _gridCache;
        const geom = `${cols}:${cardW}:${cardH}:${gap}`;
        const geomChanged = geom !== _gridGeom;
        _gridGeom = geom;
        const sel = S.sel;
        const top = UI.vp.scrollTop, h = UI.vp.clientHeight;
        const startRow = Math.max(0, Math.floor(top / (cardH + gap)) - 2);
        const endRow = Math.min(Math.ceil(items.length / cols), Math.ceil((top + h) / (cardH + gap)) + 2);
        const needed = new Set();
        for (let r = startRow; r < endRow; r++) {
            for (let c = 0; c < cols; c++) {
                const idx = r * cols + c;
                if (idx >= items.length) break;
                const d = items[idx], isSel = sel.has(d.id);
                const key = d.id;
                needed.add(key);
                const prev = _gridPool.get(key);
                const plan = planCell(prev, d, idx, isSel);
                const card = plan.create ? document.createElement("div") : prev.el;
                if (plan.create) UI.in.appendChild(card);
                if (plan.content) {
                    card.className = `pk-card ${isSel ? "sel" : ""}`;
                    card.dataset.id = d.id;
                    let thumb = getIcon(d);
                    if (d.kind !== "drive#folder" && d.thumbnail_link) thumb = `<img src="${d.thumbnail_link}" loading="lazy" decoding="async">`;
                    card.innerHTML = `<input type="checkbox" class="pk-card-chk" ${isSel ? "checked" : ""}><div class="pk-card-thumb">${thumb}</div><div class="pk-card-name" title="${esc(d._path ? `${d._path}/${d.name}` : d.name)}">${esc(d.name)}</div><div class="pk-card-info"><span>${d.kind === "drive#folder" ? "" : fmtSize(d.size)}</span><span>${d.params?.duration ? fmtDur(d.params.duration) : ""}</span></div>`;
                } else if (plan.sel) {
                    card.classList.toggle("sel", isSel);
                    const chk = card.querySelector("input");
                    if (chk) chk.checked = isSel;
                }
                if (plan.position || geomChanged) {
                    card.style.cssText = `width:${cardW}px;height:${cardH}px;left:${10 + c * (cardW + gap)}px;top:${10 + r * (cardH + gap)}px`;
                }
                if (plan.click && _h) {
                    const chk = card.querySelector("input");
                    card.onclick = e => _h.onCardClick(e, d, idx, chk, card);
                    card.ondblclick = e => _h.onCardDblClick(e, d);
                    card.oncontextmenu = e => _h.onCardContext(e, d, card);
                }
                if (plan.drag) applyDragDrop(card, d);
                _gridPool.set(key, { el: card, d, index: idx, sel: isSel });
            }
        }
        for (const key of [..._gridPool.keys()]) {
            if (!needed.has(key)) { _gridPool.get(key).el.remove(); _gridPool.delete(key); }
        }
    }
    let _scrollPending = false;
export function initScrollHandler() {
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
