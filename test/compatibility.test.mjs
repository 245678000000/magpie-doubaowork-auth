import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { availableBrowsers, browserArgs, launchIsolatedBrowser, IDENTITY_EXPRESSION } from "../browser-login.mjs";
import { checkLinuxEnvironment } from "../posix-browser.mjs";
import { devToolsAddress, waitDevToolsAddress, SocketClient } from "../cdp-port.mjs";

test("Linux discovers Chrome, Edge and Chromium, including explicit paths; ignores relative paths", async () => {
  const present = new Set(["/custom/google-chrome", "/usr/bin/microsoft-edge", "/snap/bin/chromium"]);
  const found = await availableBrowsers("linux", "/home/fixture", { DW_CHROME_BIN: "/custom/google-chrome", PATH: "relative:/usr/bin" }, { usable: async (file) => present.has(file) });
  assert.deepEqual(found.map((b) => b.id), ["chrome", "edge", "chromium"]);
  assert.equal(found[0].path, "/custom/google-chrome");
  const checked = [];
  await availableBrowsers("linux", "/home/fixture", { DW_CHROME_BIN: "relative/google-chrome", PATH: "relative" }, { usable: async (file) => { checked.push(file); return false; } });
  assert(checked.every((p) => p.startsWith("/") && !p.includes("relative")));
});
test("Linux keeps browser sandbox and requires a real graphical non-root session", async () => {
  assert.throws(() => checkLinuxEnvironment({ env: { DISPLAY: ":99" }, uid: 0 }), /普通用户/);
  assert.throws(() => checkLinuxEnvironment({ env: {}, uid: 1000 }), /DISPLAY/);
  checkLinuxEnvironment({ env: { WAYLAND_DISPLAY: "wayland-0" }, uid: 1000 });
  for (const transport of ["pipe", "port"]) {
    const args = browserArgs("/tmp/private", { transport });
    assert(!args.some((arg) => /no-sandbox|disable-web-security|disable-setuid-sandbox/.test(arg)));
  }
  await assert.rejects(launchIsolatedBrowser({ id: "chrome", path: "/fixture/chrome" }, "/tmp/private", {
    platform: "linux", env: {}, uid: 1000, spawnProcess() { assert.fail("must not spawn"); },
  }), (error) => error.status === 409 && /DISPLAY/.test(error.message));
});
test("port compatibility is explicit and only binds a random loopback port with a new profile", () => {
  assert(browserArgs("/tmp/private").includes("--remote-debugging-pipe"));
  const args = browserArgs("/tmp/private", { transport: "port" });
  assert(args.includes("--remote-debugging-address=127.0.0.1"));
  assert(args.includes("--remote-debugging-port=0"));
  assert(args.includes("--user-data-dir=/tmp/private"));
  assert(!args.includes("--remote-debugging-pipe"));
});
test("port file only accepts a bounded browser WebSocket path, not a supplied remote host", async () => {
  assert.equal(devToolsAddress("43210\n/devtools/browser/fixture-123\n"), "ws://127.0.0.1:43210/devtools/browser/fixture-123");
  for (const value of ["0\n/devtools/browser/x", "65536\n/devtools/browser/x", "80\nws://foreign.test", "80\n/devtools/browser/../x", "80\n/devtools/browser/x?q=1", "80\n/devtools/browser/x\nextra", "x".repeat(4097)]) assert.throws(() => devToolsAddress(value));
  const dir = await mkdtemp(join(tmpdir(), "dw-port-file-"));
  try {
    const file = join(dir, "DevToolsActivePort");
    await assert.rejects(waitDevToolsAddress(dir, { timeoutMs: 1 }), /超时/);
    await writeFile(file, "43210\n/devtools/browser/fixture-123");
    assert.equal(await waitDevToolsAddress(dir), "ws://127.0.0.1:43210/devtools/browser/fixture-123");
    await rm(file);
    // Windows symlink privileges vary, so the lstat guard is exercised on POSIX.
    if (process.platform !== "win32") {
      await writeFile(join(dir, "other"), "43210\n/devtools/browser/fixture-123");
      await symlink(join(dir, "other"), file);
      await assert.rejects(waitDevToolsAddress(dir), /读取失败/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
class FixtureSocket extends EventTarget {
  constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
  send(packet) {
    const value = JSON.parse(packet);
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value.method === "error"
      ? { id: value.id, error: { message: "SENSITIVE" } }
      : { id: value.id, result: { ok: true } }) })));
  }
  close() { if (this.closed) return; this.closed = true; this.dispatchEvent(new Event("close")); }
}
test("WebSocket client bounds frames, rejects pending commands on close and hides remote payload errors", async () => {
  const client = new SocketClient("ws://127.0.0.1:1/devtools/browser/fixture", { WebSocketImpl: FixtureSocket });
  await client.ready;
  assert.deepEqual(await client.send("fixture"), { ok: true });
  await assert.rejects(client.send("error"), (error) => !error.message.includes("SENSITIVE"));
  client.receive("x".repeat(2 * 1024 * 1024 + 1));
  assert(client.closed);
  assert(client.socketClosed);
  await assert.rejects(client.send("late"), /已断开/);
});
test("port startup survives a wrapper exiting, and validates profile before reading any account data", async () => {
  const profile = "/fixture/private-profile", calls = [];
  let client;
  class Port {
    constructor() { client = this; this.ready = Promise.resolve(); this.disconnected = new Promise((r) => { this.finish = r; }); }
    async send(method) {
      calls.push(method);
      if (method === "Browser.getBrowserCommandLine") return { arguments: ["--user-data-dir=" + profile, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"] };
      if (method === "Browser.getVersion") return { product: "Chrome/fixture" };
      if (method === "Target.getTargets") return { targetInfos: [{ type: "page", targetId: "fixture", url: "about:blank" }] };
      if (method === "Browser.close") { this.socketClosed = true; this.finish(); }
      return {};
    }
    close() { this.closed = true; }
  }
  const spawnProcess = (_file, args, opts) => {
    assert(args.includes("--remote-debugging-port=0"));
    assert.equal(opts.stdio.length, 3);
    const child = new EventEmitter();
    child.kill = () => assert.fail("wrapper already exited");
    queueMicrotask(() => { child.emit("spawn"); child.emit("exit", 0); });
    return child;
  };
  const handle = await launchIsolatedBrowser({ id: "chrome", path: "/fixture/chrome" }, profile, {
    platform: "win32", transport: "port", spawnProcess, PortClient: Port,
    portAddress: async (p) => { assert.equal(p, profile); return "ws://127.0.0.1:1/devtools/browser/fixture"; },
  });
  assert.equal(calls[0], "Browser.getBrowserCommandLine");
  assert.deepEqual(await handle.cookies(), []);
  await handle.dispose();
  assert(client.closed);
  assert(calls.includes("Browser.close"));
});
test("a wrapper overriding the profile is disconnected without closing or inspecting the other browser", async () => {
  const calls = [];
  class WrongProfile {
    constructor() { this.ready = Promise.resolve(); }
    async send(method) { calls.push(method); return { arguments: ["--user-data-dir=/daily-profile"] }; }
    close() { calls.push("disconnect"); }
  }
  await assert.rejects(launchIsolatedBrowser({ id: "chrome", path: "/fixture/chrome" }, "/fixture/private", {
    platform: "win32", transport: "port", PortClient: WrongProfile,
    portAddress: async () => "ws://127.0.0.1:1/devtools/browser/fixture",
    spawnProcess: () => { const child = new EventEmitter(); queueMicrotask(() => { child.emit("spawn"); child.emit("exit", 0); }); return child; },
  }), (error) => error.cleanupPending && error.status === 503);
  assert.deepEqual(calls, ["Browser.getBrowserCommandLine", "disconnect"]);
});
test("identity expression rechecks the live origin and tolerates one malformed localStorage entry", () => {
  const evaluate = (url, entries) => runInNewContext(IDENTITY_EXPRESSION, { location: new URL(url), localStorage: { getItem: (key) => entries[key] } });
  assert.deepEqual(JSON.parse(evaluate("https://www.doubao.com/chat/", { client_device_info: "bad", samantha_web_web_id: '{"web_id":"WEB_FIXTURE"}' })), { webId: "WEB_FIXTURE", deviceId: "", clientVersion: "", chromiumVersion: "", channel: "", userAgent: "" });
  for (const url of ["https://foreign.test/", "http://www.doubao.com/", "https://www.doubao.com:9999/"])
    assert.equal(evaluate(url, { client_device_info: '{"deviceId":"SENSITIVE"}' }), "{}");
});


test("a wrapper widening the listener is closed after private-profile verification, before any cookie read", async () => {
  const calls = [];
  class ChangedFlags {
    constructor() { this.ready = Promise.resolve(); this.disconnected = Promise.resolve(); }
    async send(method) {
      calls.push(method);
      if (method === "Browser.getBrowserCommandLine") return { arguments: ["--user-data-dir=/fixture/private", "--remote-debugging-address=0.0.0.0", "--remote-debugging-port=0"] };
      if (method === "Browser.close") this.socketClosed = true;
      return {};
    }
    close() { calls.push("disconnect"); this.closed = true; }
  }
  await assert.rejects(launchIsolatedBrowser({ id: "chrome", path: "/fixture/chrome" }, "/fixture/private", {
    platform: "win32", transport: "port", PortClient: ChangedFlags,
    portAddress: async () => "ws://127.0.0.1:1/devtools/browser/fixture",
    spawnProcess: () => { const child = new EventEmitter(); queueMicrotask(() => { child.emit("spawn"); child.emit("exit", 0); }); return child; },
  }), (error) => error.status === 503 && !error.cleanupPending);
  assert.deepEqual(calls, ["Browser.getBrowserCommandLine", "Browser.close", "disconnect"]);
});
