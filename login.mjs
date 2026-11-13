// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { BrowserLogin } from "./browser-login.mjs";
import { credentials, saveAuth, deviceMetadata, fail } from "./protocol.mjs";
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>豆包工作 · Magpie 账号登录</title><link rel="stylesheet" href="style.css"><main><div class="brand"><img src="avatar.png" alt="豆包工作"><span>豆包工作 <small>MAGPIE · 独立登录</small></span></div><span class="eyebrow">每个账号，单独一个会话</span><h1>在独立浏览器中登录</h1><p>已为你打开新的 Chrome / Edge / 豆包内置窗口，请在那里完成豆包登录和官网验证，完成后再回到本页确认接入。日常浏览器中的账号保持原样。</p><ol><li>在新窗口扫码或输入手机验证码</li><li>如官网提示验证，请由你本人完成</li><li>回到此页点击“接入 Magpie”，核验后保存账号</li></ol><section aria-live="polite"><b id="state">正在读取状态…</b><p id="message"></p></section><p class="note">登录快照保存在 Magpie 的私有账号库，不依赖外置反代。不要发送 Cookie 或验证码给他人。</p><button id="confirm" type="button" hidden>接入 Magpie</button><button id="cancel" type="button">取消本次登录</button></main><script src="flow.js" defer></script></html>`;
const css = `:root{font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;color:#243145;background:#f5f7fa}*{box-sizing:border-box}body{margin:0;padding:40px 18px}main{max-width:520px;margin:auto;padding:32px;background:#fff;border:1px solid #e5eaf2;border-radius:18px}.brand{display:flex;gap:12px;align-items:center;margin-bottom:32px;font-weight:650;font-size:18px}.brand img{width:46px;height:46px;border-radius:12px;object-fit:cover}.brand small{display:block;font-size:9px;color:#7b889d;letter-spacing:.12em;margin-top:5px}.eyebrow{font-size:11px;color:#667489}h1{font-size:26px;letter-spacing:-.03em}p,li{font-size:13px;color:#667489;line-height:1.9}ol{padding-left:20px;margin:24px 0}section{background:#edf3ff;border:1px solid #d9e5fc;border-radius:11px;padding:17px;color:#3465cb}section p{margin:8px 0 0;font-size:12px}.note{font-size:11px;margin:22px 0}button{padding:11px 16px;background:#fff;color:#243145;border:1px solid #e5eaf2;border-radius:8px;cursor:pointer}button:disabled{opacity:.5;cursor:default}button:focus-visible{outline:3px solid #3465cb;outline-offset:3px}@media(prefers-color-scheme:dark){:root{background:#161d29;color:#e4eaf2}main{background:#1d2634;border-color:#303c4f}section{background:#233653;border-color:#385276;color:#a4c0ff}p,li{color:#a2b0c4}button{background:#1d2634;color:#e4eaf2;border-color:#303c4f}}`;
const js = `const names={waiting:'等待你完成登录',starting:'正在打开独立浏览器',awaiting_confirmation:'已登录，等待你确认接入',importing:'正在核验账号',success:'登录完成，已交给 Magpie',cancelled:'本次登录已取消',expired:'本次登录已超时',error:'登录需要检查'};const cancel=document.getElementById('cancel'),confirm=document.getElementById('confirm');async function refresh(){try{const r=await fetch('status',{headers:{'X-Doubao-Login':'1'},cache:'no-store'});if(!r.ok)throw Error();const s=await r.json();document.getElementById('state').textContent=names[s.state]||'正在读取';document.getElementById('message').textContent=s.message||'';cancel.disabled=!s.active||s.state==='importing';confirm.hidden=s.state!=='awaiting_confirmation';confirm.disabled=s.state!=='awaiting_confirmation';if(s.active)setTimeout(refresh,1200);}catch{document.getElementById('state').textContent='登录流程已结束';document.getElementById('message').textContent='返回 Magpie 查看账号。';cancel.disabled=true;confirm.hidden=true;}}async function action(path){cancel.disabled=confirm.disabled=true;try{const r=await fetch(path,{method:'POST',headers:{'X-Doubao-Login':'1'}});if(!r.ok)document.getElementById('message').textContent='状态正在更新，请稍后再次确认。';}finally{void refresh();}}cancel.addEventListener('click',()=>void action('cancel'));confirm.addEventListener('click',()=>void action('confirm'));void refresh();`;

export function createLoginManager({
  root,
  api,
  Browser = BrowserLogin,
  metadata = deviceMetadata,
} = {}) {
  let current = null,
    starting = false;
  return {
    async start({ browserId, signal } = {}) {
      if (current || starting)
        throw fail(409, "已有独立登录窗口，请先完成或取消当前登录。");
      starting = true;
      const controller = new AbortController(),
        flowSignal = signal
          ? AbortSignal.any([signal, controller.signal])
          : controller.signal;
      let browser,
        server,
        dispose,
        timer,
        parentAbort,
        saved = null,
        used = false;
      try {
        if (signal?.aborted) throw fail(499, "登录已取消。");
        await mkdir(root, { recursive: true, mode: 0o700 });
        browser = new Browser({
          tmpRoot: join(root, "tmp"),
          async importAccount(cookies) {
            let secret = credentials({ cookies });
            if (!secret.deviceId)
              secret = {
                ...(await metadata()),
                ...Object.fromEntries(
                  Object.entries(secret).filter(([, v]) => v !== ""),
                ),
              };
            const profile = await api.identify(secret, { signal: flowSignal });
            saved = saveAuth(profile);
            return { name: profile.name, updated: false };
          },
        });
        const token = randomBytes(24).toString("hex"),
          prefix = "/" + token + "/";
        let host = "",
          url = "";
        server = createServer(async (req, res) => {
          const headers = {
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Cross-Origin-Resource-Policy": "same-origin",
            "Content-Security-Policy":
              "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
          };
          const send = (code, type, text) => {
            res.writeHead(code, { ...headers, "Content-Type": type });
            res.end(text);
          };
          try {
            if (req.headers.host !== host || !req.url?.startsWith(prefix))
              return send(404, "text/plain", "未找到此登录流程。");
            const path = req.url.slice(prefix.length);
            if (req.method === "GET" && path === "")
              return send(200, "text/html; charset=utf-8", page);
            if (req.method === "GET" && path === "style.css")
              return send(200, "text/css", css);
            if (req.method === "GET" && path === "flow.js")
              return send(200, "text/javascript", js);
            if (req.method === "GET" && path === "avatar.png")
              return send(
                200,
                "image/png",
                await readFile(new URL("./avatar.png", import.meta.url)),
              );
            if (
              req.headers["x-doubao-login"] !== "1" ||
              req.headers["sec-fetch-site"] === "cross-site" ||
              (req.method === "POST" &&
                req.headers.origin !== "http://" + host) ||
              (req.headers.origin && req.headers.origin !== "http://" + host)
            )
              return send(403, "text/plain", "登录请求来源不匹配。");
            if (req.method === "GET" && path === "status") {
              const s = browser.status();
              return send(
                200,
                "application/json",
                JSON.stringify({
                  state: s.state,
                  message: s.message,
                  active: s.active,
                  expiresAt: s.expiresAt,
                }),
              );
            }
            if (
              req.method === "POST" &&
              path === "confirm" &&
              req.headers.origin === "http://" + host
            ) {
              await browser.confirm(browser.status().id);
              return send(200, "application/json", '{"ok":true}');
            }
            if (
              req.method === "POST" &&
              path === "cancel" &&
              req.headers.origin === "http://" + host
            ) {
              await browser.cancel();
              return send(200, "application/json", '{"ok":true}');
            }
            return send(404, "text/plain", "未找到该操作。");
          } catch {
            return send(
              409,
              "application/json",
              '{"error":"请在 Magpie 核对登录状态。"}',
            );
          }
        });
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        host = "127.0.0.1:" + server.address().port;
        url = "http://" + host + prefix;
        server.unref();
        let disposed;
        dispose = () =>
          (disposed ??= (async () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", parentAbort);
            controller.abort();
            saved = null;
            await browser.dispose();
            await new Promise((resolve) => {
              if (!server.listening) return resolve();
              server.close(resolve);
              server.closeAllConnections?.();
            });
            if (current?.dispose === dispose) current = null;
          })());
        current = { dispose };
        parentAbort = () => {
          void dispose();
        };
        signal?.addEventListener("abort", parentAbort, { once: true });
        timer = setTimeout(() => void dispose(), 10 * 60_000);
        timer.unref?.();
        await browser.start(browserId, { manual: true });
        if (signal?.aborted) throw fail(499, "登录已取消。");
        if (browser.status().state === "error")
          throw fail(409, browser.status().message);
        return {
          url,
          method: "auto",
          instructions:
            "在独立 Chrome / Edge / 豆包内置浏览器完成登录及官网验证，再回到本页点击“接入 Magpie”。临时窗口会保留到你确认后，不替换日常账号。",
          async callback(_code, { signal: callbackSignal } = {}) {
            if (used)
              return { type: "failed", error: "本次登录已结束，请重新发起。" };
            used = true;
            const abort = () => {
              void dispose();
            };
            callbackSignal?.addEventListener("abort", abort, { once: true });
            try {
              for (;;) {
                if (signal?.aborted || callbackSignal?.aborted)
                  return { type: "failed", error: "本次登录已取消。" };
                const s = browser.status();
                if (!s.active) {
                  if (s.state === "success" && saved) return saved;
                  return {
                    type: "failed",
                    error: s.message || "本次登录已结束，请重新发起。",
                  };
                }
                await new Promise((resolve) => setTimeout(resolve, 150));
              }
            } finally {
              callbackSignal?.removeEventListener("abort", abort);
              await dispose();
            }
          },
        };
      } catch (e) {
        if (dispose) await dispose();
        else {
          await browser?.dispose().catch(() => {});
          server?.close();
        }
        throw e;
      } finally {
        starting = false;
      }
    },
    async dispose() {
      await current?.dispose();
    },
  };
}
