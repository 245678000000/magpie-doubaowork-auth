import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function devToolsAddress(text) {
  if (typeof text !== "string" || text.length > 4096) throw Error("临时浏览器端口信息格式异常。");
  const lines = text.trim().split(/\r?\n/);
  if (lines.length !== 2 || !/^[1-9][0-9]{0,4}$/.test(lines[0]) || Number(lines[0]) > 65535 ||
      !/^\/devtools\/browser\/[a-zA-Z0-9-]{1,128}$/.test(lines[1])) throw Error("临时浏览器端口信息格式异常。");
  return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
}

// Read only the newly created private profile. Never attach to a daily browser,
// scan ports, accept a caller-provided address, or use a fixed TCP port.
export async function waitDevToolsAddress(profile, { timeoutMs = 15000 } = {}) {
  const file = join(profile, "DevToolsActivePort"), end = Date.now() + timeoutMs;
  do {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw Error("Invalid port file");
      return devToolsAddress(await readFile(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw Error("临时浏览器端口信息读取失败。");
    }
    await pause(80);
  } while (Date.now() < end);
  throw Error("临时浏览器端口等待超时。");
}

export class SocketClient {
  constructor(address, { WebSocketImpl = globalThis.WebSocket, timeoutMs = 7000, maxBytes = 2 * 1024 * 1024 } = {}) {
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    this.socketClosed = false;
    this.disconnected = new Promise((resolve) => { this.resolveClosed = resolve; });
    this.socket = new WebSocketImpl(address);
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.close(); reject(Error("浏览器连接超时。")); }, timeoutMs);
      const done = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
      this.socket.addEventListener("open", () => done(), { once: true });
      this.socket.addEventListener("error", () => { done(Error("浏览器连接失败。")); this.close(); }, { once: true });
      this.socket.addEventListener("close", () => { done(Error("浏览器登录窗口已断开。")); this.socketClosed = true; this.resolveClosed(); this.close(); }, { once: true });
    });
    this.socket.addEventListener("message", (event) => this.receive(event.data));
  }
  receive(frame) {
    if (this.closed) return;
    if (typeof frame !== "string" || Buffer.byteLength(frame) > this.maxBytes) return this.close();
    let value;
    try { value = JSON.parse(frame); } catch { return this.close(); }
    if (!value || typeof value !== "object" || Array.isArray(value)) return this.close();
    const waiter = this.pending.get(value.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.pending.delete(value.id);
    value.error ? waiter.reject(Error("浏览器登录通信失败。")) : waiter.resolve(value.result || {});
  }
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(Error("浏览器登录窗口已断开。"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error("浏览器响应超时。")); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); } catch { this.close(); }
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(Error("浏览器登录窗口已断开。")); }
    this.pending.clear();
    try { this.socket.close(); } catch { /* Cleanup retains the profile unless socket closure is observed. */ }
  }
}
