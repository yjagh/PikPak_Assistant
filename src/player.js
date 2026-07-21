// Player module (refactor B step 2): extracted from main.js.
// Owns the HLS instance handle + subtitle Blob URLs and their cleanup,
// and the loading-state helpers (setLoad/updateLoadTxt) that playVideo uses.
// Circular import with main.js is intentional: every cross reference is at
// call time (after openManager runs), never at module-init, so ESM live
// bindings resolve fine and esbuild bundles it without TDZ issues.
import { sleep, esc, gmGet } from "./utils.js";
import { apiGet } from "./api.js";
import { S, getStrings, setLoading, updateLoadingText, showAlert, showToast } from "./main.js";

    // 当前 HLS 实例句柄：每次重新播放/切集/切字幕/关闭前销毁旧实例，
    // 否则旧实例仍绑在被移除的 video 上持续下载分片（内存+网络泄漏）
    let _currentHls = null;
export function destroyHls() {
        if (_currentHls) {
            try {
                _currentHls.destroy();
            } catch (e) { }
            _currentHls = null;
        }
    }
    // 字幕轨道用的 Blob URL：在切换视频/关闭播放器时统一 revoke，避免内存泄漏
    let _subBlobUrls = [];
export function revokeSubBlobs() {
        _subBlobUrls.forEach(u => {
            try {
                URL.revokeObjectURL(u);
            } catch (e) { }
        });
        _subBlobUrls = [];
    }

    function setLoad(b) { S.loading = b; setLoading(b, getStrings()); }
    function updateLoadTxt(txt) { updateLoadingText(txt); }
export async function playVideo(item, extraTracksHtml = "", startAt = 0, forceLang = null) {
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
