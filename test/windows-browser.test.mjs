import { test } from "node:test";
import assert from "node:assert/strict";
import { availableBrowsers, BrowserLogin, launchIsolatedBrowser } from "../browser-login.mjs";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chrome = "D:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const edge = "D:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

test("Windows 从 64 位和 32 位安装目录、用户目录及 App Paths 发现 Chrome / Edge", async () => {
  const userEdge = "D:\\用户\\本地\\Microsoft\\Edge\\Application\\msedge.exe";
  const registered = "E:\\浏览器\\Google Chrome\\chrome.exe";
  const installed = new Set([chrome, edge]);
  const env = {
    ProgramW6432: "D:\\Program Files",
    PROGRAMFILES: "D:\\Program Files (x86)",
    "ProgramFiles(x86)": "D:\\Program Files (x86)",
    LocalAppData: "D:\\用户\\本地",
  };
  let registryCalls = 0;
  const deps = {
    usable: async (file) => installed.has(file),
    readAppPaths: async () => {
      registryCalls++;
      return { chrome: [registered], edge: [] };
    },
  };
  const scan = () => availableBrowsers("win32", "D:\\用户", env, deps);
  assert.deepEqual((await scan()).map(({ path }) => path), [chrome, edge]);
  assert.equal(registryCalls, 0);
  installed.clear();
  installed.add(userEdge);
  installed.add(registered);
  assert.deepEqual((await scan()).map(({ path }) => path), [registered, userEdge]);
  assert.equal(registryCalls, 1);
});

test("Windows 忽略相对路径、网络共享和 App Paths 中带参数的项", async () => {
  const candidates = [];
  const found = await availableBrowsers("win32", "C:\\Users\\fixture", {}, {
    usable: async (file) => (candidates.push(file), false),
    readAppPaths: async () => ({
      chrome: ["chrome.exe", "\\\\HOST\\share\\chrome.exe", '"C:\\App\\chrome.exe" --arg'],
      edge: [],
    }),
  });
  assert.deepEqual(found, []);
  assert(candidates.length > 0);
  assert(candidates.every((file) => /^[A-Z]:\\/i.test(file) && !file.includes('"')));
});

test("自动选择在第一个浏览器启动失败后用全新资料打开另一个", async () => {
  const root = await mkdtemp(join(tmpdir(), "dw-fallback-"));
  const tried = [];
  const flow = new BrowserLogin({
    tmpRoot: root,
    importAccount: async () => assert.fail("must not import"),
    discover: async () => [
      { id: "chrome", name: "Chrome", path: chrome },
      { id: "edge", name: "Edge", path: edge },
    ],
    launch: async (browser, profile) => {
      tried.push({ id: browser.id, profile });
      if (browser.id === "chrome")
        throw Object.assign(new Error("启动失败"), { status: 503 });
      return { cookies: async () => [], dispose: async () => {} };
    },
  });
  try {
    assert.equal((await flow.start()).state, "waiting");
    assert.deepEqual(tried.map(({ id }) => id), ["chrome", "edge"]);
    assert.notEqual(tried[0].profile, tried[1].profile);
    assert.equal((await readdir(root)).length, 1);
    await flow.cancel();
    assert.deepEqual(await readdir(root), []);
  } finally {
    await flow.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows 宿主没有额外匿名管道时清理进程并报通信故障", async () => {
  const child = new EventEmitter();
  child.stdio = [null, null, null, null, null];
  let killed = false;
  child.kill = () => { killed = true; child.emit("exit", 0); };
  await assert.rejects(launchIsolatedBrowser({ path: chrome }, "C:\\tmp\\fixture", {
    platform: "win32",
    spawnProcess() { queueMicrotask(() => child.emit("spawn")); return child; },
  }), /已找到浏览器，但独立登录通信未建立/);
  assert(killed);
});
