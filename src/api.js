import { sleep } from "./utils.js";
export function getHeaders() {
        let token = "", captcha = "";
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith("credentials")) {
                try {
                    const v = JSON.parse(localStorage.getItem(k));
                    token = v.token_type + " " + v.access_token;
                } catch { }
            }
            if (k && k.startsWith("captcha")) {
                try {
                    const v = JSON.parse(localStorage.getItem(k));
                    captcha = v.captcha_token;
                } catch { }
            }
        }
        return {
            "Content-Type": "application/json",
            Authorization: token,
            "x-device-id": localStorage.getItem("deviceid") || "",
            "x-captcha-token": captcha
        };
    }
    // 统一的底层请求封装：超时(15s) + 429 退避重试(优先 Retry-After) + 错误体解析。
    // apiList/apiGet/apiBatchTrash/apiAction 都基于它，消除三处不一致的 429 实现。
export async function pkFetch(url, opts = {}) {
        const { method = "GET", body = null, retries = 3, timeout = 15e3, checkActive = null } = opts;
        for (let attempt = 0; attempt < retries; attempt++) {
            if (checkActive && !checkActive()) throw new Error("AbortError");
            let res;
            const controller = new AbortController;
            const timer = timeout ? setTimeout(() => controller.abort(), timeout) : null;
            try {
                res = await fetch(url, {
                    method,
                    headers: getHeaders(),
                    ...body != null ? { body } : {},
                    signal: controller.signal
                });
            } catch (e) {
                if (timer) clearTimeout(timer);
                if (e.name === "AbortError") {
                    if (checkActive && !checkActive()) throw new Error("AbortError");
                    throw new Error("API Request Timed Out");
                }
                throw e;
            }
            if (timer) clearTimeout(timer);
            const data = await res.json().catch(() => null);
            if (res.ok && !(data && data.error)) return data;
            if (res.status === 429 && attempt < retries - 1) {
                const retryAfter = Number(res.headers.get("Retry-After")) || 2 * (attempt + 1);
                await sleep(retryAfter * 1e3);
                continue;
            }
            const message = data && (data.error_description || data.error && data.error.message || data.message) || `API Error ${res.status}`;
            throw new Error(message);
        }
        throw new Error("API Error 429");
    }
export async function apiList(parentId, limit = 1e3, onProgress, checkActive, filters = null) {
        let all = [], next = null, safe = 5e3;
        while (safe-- > 0) {
            if (checkActive && !checkActive()) throw new Error("AbortError");
            const filterStr = filters ? `&filters=${encodeURIComponent(JSON.stringify(filters))}` : "";
            const url = `https://api-drive.mypikpak.com/drive/v1/files?thumbnail_size=SIZE_MEDIUM&limit=${limit}&parent_id=${parentId || ""}&with_audit=true${next ? `&page_token=${next}` : ""}${filterStr}`;
            const data = await pkFetch(url, { retries: 6, checkActive });
            if (data && data.files) {
                const validFiles = data.files.filter(f => !f.trashed && f.phase === "PHASE_TYPE_COMPLETE");
                for (const f of validFiles) all.push(f);
                if (onProgress) {
                    onProgress(all.length);
                    await sleep(0);
                }
            }
            next = data && data.next_page_token;
            if (!next) break;
            if (checkActive && !checkActive()) break;
        }
        return all;
    }
export async function apiGet(id) {
        return pkFetch(`https://api-drive.mypikpak.com/drive/v1/files/${id}`, { retries: 3 });
    }
export async function apiBatchTrash(ids) {
        return pkFetch("https://api-drive.mypikpak.com/drive/v1/files:batchTrash", {
            method: "POST",
            body: JSON.stringify({ ids }),
            retries: 3
        });
    }
export async function apiAction(action, data) {
        const method = action.includes("batch") ? "POST" : "PATCH";
        return pkFetch(`https://api-drive.mypikpak.com/drive/v1/files${action}`, {
            method,
            body: JSON.stringify(data),
            retries: 3
        });
    }