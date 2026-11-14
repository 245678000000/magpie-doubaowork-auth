import { test } from "node:test";
import assert from "node:assert/strict";
import {
  availableBrowsers,
  BrowserLogin,
  browserArgs,
  launchIsolatedBrowser,
} from "../browser-login.mjs";
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

const doubao = "D:\\用户\\本地\\Doubao\\Application\\app\\Doubao.exe";

test("Windows 从默认用户目录发现豆包内置浏览器，且排在 Chrome / Edge 之后", async () => {
  const installed = new Set([chrome, edge, doubao]);
  const env = {
    ProgramW6432: "D:\\Program Files",
    PROGRAMFILES: "D:\\Program Files (x86)",
    "ProgramFiles(x86)": "D:\\Program Files (x86)",
    LocalAppData: "D:\\用户\\本地",
  };
  const found = await availableBrowsers("win32", "D:\\用户", env, {
    usable: async (file) => installed.has(file),
    readAppPaths: async () => ({ chrome: [], edge: [] }),
  });
  assert.deepEqual(found.map(({ id }) => id), ["chrome", "edge", "doubao"]);
  assert.equal(found[2].path, doubao);
  assert.equal(found[2].name, "豆包内置浏览器");
});

test("DW_DOUBAO_BIN 优先于默认安装路径", async () => {
  const portable = "E:\\Portable\\Doubao\\Application\\app\\Doubao.exe";
  const fallback =
    "C:\\Users\\fixture\\AppData\\Local\\Doubao\\Application\\app\\Doubao.exe";
  const found = await availableBrowsers(
    "win32",
    "C:\\Users\\fixture",
    { LocalAppData: "C:\\Users\\fixture\\AppData\\Local", DW_DOUBAO_BIN: portable },
    {
      usable: async (file) => file === portable || file === fallback,
      readAppPaths: async () => ({ chrome: [], edge: [] }),
    },
  );
  assert.deepEqual(found, [{ id: "doubao", name: "豆包内置浏览器", path: portable }]);
});

test("豆包转发器 Doubao_browser_proxy.exe 因文件名不符被拒绝", async () => {
  const proxy =
    "C:\\Users\\fixture\\AppData\\Local\\Doubao\\Application\\app\\Doubao_browser_proxy.exe";
  const found = await availableBrowsers(
    "win32",
    "C:\\Users\\fixture",
    { DW_DOUBAO_BIN: proxy },
    {
      usable: async (file) => file === proxy,
      readAppPaths: async () => ({ chrome: [], edge: [] }),
    },
  );
  assert.deepEqual(found, []);
});

test("DW_DOUBAO_BIN 同样拒绝相对路径、网络共享和带参数的引号写法", async () => {
  for (const bad of [
    "Doubao.exe",
    "\\\\HOST\\share\\Doubao.exe",
    '"C:\\App\\Doubao.exe" --saman-browser-entry',
  ]) {
    const probed = [];
    const found = await availableBrowsers(
      "win32",
      "C:\\Users\\fixture",
      { DW_DOUBAO_BIN: bad },
      {
        usable: async (file) => {
          probed.push(file);
          return false;
        },
        readAppPaths: async () => ({ chrome: [], edge: [] }),
      },
    );
    assert.deepEqual(found, []);
    assert(!probed.includes(bad), `无效路径不应进入探测: ${bad}`);
  }
});

test("Chrome / Edge 参数逐字不变，豆包只在首位多一个内部开关", () => {
  const base = [
    "--remote-debugging-pipe",
    "--user-data-dir=D:\\tmp\\p",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-mode",
    "--new-window",
    "about:blank",
  ];
  assert.deepEqual(browserArgs("D:\\tmp\\p", { blank: true }), base);
  assert.deepEqual(browserArgs("D:\\tmp\\p", { blank: true, id: "chrome" }), base);
  assert.deepEqual(browserArgs("D:\\tmp\\p", { blank: true, id: "edge" }), base);
  assert.deepEqual(
    browserArgs("D:\\tmp\\p", { blank: true, id: "doubao" }),
    ["--saman-browser-entry", ...base],
  );
  const login = [
    "--remote-debugging-pipe",
    "--user-data-dir=D:\\tmp\\p",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-mode",
    "--new-window",
    "https://www.doubao.com/chat/",
  ];
  assert.deepEqual(browserArgs("D:\\tmp\\p"), login);
  assert.deepEqual(browserArgs("D:\\tmp\\p", { id: "doubao" }), [
    "--saman-browser-entry",
    ...login,
  ]);
});

test("指定 doubao 时只启动豆包，不回落 Chrome / Edge", async () => {
  const root = await mkdtemp(join(tmpdir(), "dw-doubao-only-"));
  const tried = [];
  const flow = new BrowserLogin({
    tmpRoot: root,
    platform: "win32",
    importAccount: async () => assert.fail("must not import"),
    discover: async () => [
      { id: "chrome", name: "Chrome", path: chrome },
      { id: "edge", name: "Edge", path: edge },
      { id: "doubao", name: "豆包内置浏览器", path: doubao },
    ],
    launch: async (browser) => {
      tried.push(browser.id);
      throw Object.assign(new Error("启动失败"), { status: 503 });
    },
  });
  try {
    await flow.start("doubao");
    assert.deepEqual(tried, ["doubao"]);
    assert.equal(flow.status().state, "error");
    assert(!JSON.stringify(flow.status()).includes("SENSITIVE"));
    assert.deepEqual(await readdir(root), []);
  } finally {
    await flow.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("豆包的实际启动命令在首位注入内部开关，其余参数不变", async () => {
  const child = new EventEmitter();
  child.stdio = [null, null, null, null, null];
  let killed = false;
  child.kill = () => {
    killed = true;
    child.emit("exit", 0);
  };
  let argv = [];
  await assert.rejects(
    launchIsolatedBrowser(
      { id: "doubao", name: "豆包内置浏览器", path: doubao },
      "C:\\tmp\\fixture",
      {
        platform: "win32",
        spawnProcess(_path, args) {
          argv = args;
          queueMicrotask(() => child.emit("spawn"));
          return child;
        },
      },
    ),
    /已找到浏览器，但独立登录通信未建立/,
  );
  assert.equal(argv[0], "--saman-browser-entry");
  assert(argv.includes("--remote-debugging-pipe"));
  assert(argv.includes("--user-data-dir=C:\\tmp\\fixture"));
  assert(!argv.some((a) => a.includes("--remote-debugging-port")));
  assert(killed);
});

test("非 Windows 平台显式选择豆包内置浏览器时立即返回 400", async () => {
  const root = await mkdtemp(join(tmpdir(), "dw-platform-"));
  const flow = new BrowserLogin({
    tmpRoot: root,
    importAccount: async () => assert.fail("must not import"),
    platform: "linux",
  });
  try {
    await assert.rejects(
      flow.start("doubao"),
      (e) => e.status === 400 && /仅支持 Windows/.test(e.message),
    );
  } finally {
    await flow.dispose();
    await rm(root, { recursive: true, force: true });
  }
});