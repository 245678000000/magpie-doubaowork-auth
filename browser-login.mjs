import { spawn } from "node:child_process";
import { posixBrowsers, checkLinuxEnvironment } from "./posix-browser.mjs";
import { SocketClient, waitDevToolsAddress } from "./cdp-port.mjs";
import { access, mkdir, mkdtemp, chmod, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import { win32 as winPath } from "node:path";
import {
  envValue,
  windowsChoices,
  windowsInstallPaths,
  windowsExecutable,
  readWindowsAppPaths,
  protectWindowsProfile,
} from "./windows-browser.mjs";

const LOGIN_URL = "https://www.doubao.com/chat/";
// The web session keeps its own device and web identifiers in localStorage and
// sends them on every completion request. Read the same values back after login
// instead of guessing them; the expression is fixed and never interpolated.
export const IDENTITY_EXPRESSION = `(function(){if(location.protocol!=="https:"||!["doubao.com","www.doubao.com"].includes(location.hostname)||(location.port&&location.port!=="443"))return "{}";function read(key){try{return JSON.parse(localStorage.getItem(key)||"{}")||{}}catch(e){return {}}}var w=read("samantha_web_web_id"),d=read("client_device_info");return JSON.stringify({webId:w.web_id||"",deviceId:d.deviceId||"",clientVersion:d.clientVersion||"",chromiumVersion:d.chromiumVersion||"",channel:d.appChannel||d.channel||"",userAgent:d.userAgent||""})})()`;
const identityField = (value, max) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  !/[\x00-\x1f\x7f]/.test(value)
    ? value
    : "";
export function sessionIdentity(raw) {
  let value = raw;
  if (typeof raw === "string") {
    if (raw.length > 4096) return {};
    try {
      value = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, max, pattern] of [
    ["deviceId", 64, /^[a-zA-Z0-9_-]{1,64}$/],
    ["webId", 64, /^[a-zA-Z0-9_-]{1,64}$/],
    ["clientVersion", 32],
    ["chromiumVersion", 32],
    ["channel", 32],
    ["userAgent", 256],
  ]) {
    const text = identityField(value[key], max);
    if (text && (!pattern || pattern.test(text))) out[key] = text;
  }
  return out;
}
const ACTIVE = new Set([
  "starting",
  "waiting",
  "awaiting_confirmation",
  "importing",
]);
const failure = (status, message) =>
  Object.assign(new Error(message), { status });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Discover executable locations only. Never inspect the user's regular browser profile.
export async function availableBrowsers(
  platform = process.platform,
  home = homedir(),
  env = process.env,
  {
    usable = async (file) =>
      (await stat(file)).isFile() &&
      (platform === "win32" || (await access(file, constants.X_OK), true)),
    readAppPaths = readWindowsAppPaths,
  } = {},
) {
  const works = (file) =>
    Promise.resolve()
      .then(() => usable(file))
      .catch(() => false);
  if (platform === "win32") {
    const roots = windowsInstallPaths(home, env);
    const first = async (choice, candidates) => {
      const seen = new Set();
      for (const raw of candidates) {
        const file = windowsExecutable(raw, choice.exe);
        if (!file || seen.has(file.toLowerCase())) continue;
        seen.add(file.toLowerCase());
        if (await works(file))
          return { id: choice.id, name: choice.name, path: file };
      }
      return null;
    };
    const found = await Promise.all(
      windowsChoices.map((b) =>
        first(b, [
          envValue(env, b.env),
          ...roots.map((root) => winPath.join(root, ...b.dir, b.exe)),
        ]),
      ),
    );
    if (found.some((browser, i) => !browser && windowsChoices[i].appPaths)) {
      const registered = await readAppPaths(env);
      return (
        await Promise.all(
          windowsChoices.map(
            (b, i) => found[i] ?? first(b, registered[b.id] ?? []),
          ),
        )
      ).filter(Boolean);
    }
    return found.filter(Boolean);
  }
  return posixBrowsers(platform, home, env, works);
}
export function isDoubaoPage(raw) {
  try {
    const u = new URL(raw);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      (!u.port || u.port === "443") &&
      ["doubao.com", "www.doubao.com"].includes(u.hostname)
    );
  } catch {
    return false;
  }
}
// Project only cookies for the official Doubao root, with a valid session marker.
export function doubaoCookies(input, now = Date.now() / 1000) {
  if (!Array.isArray(input)) return [];
  const rows = input
    .filter(
      (c) =>
        c &&
        ["doubao.com", "www.doubao.com"].includes(
          String(c.domain || "").replace(/^\./, ""),
        ) &&
        c.path === "/" &&
        typeof c.name === "string" &&
        c.name.length > 0 &&
        c.name.length <= 256 &&
        !/[\s\x00-\x1f\x7f=;,]/.test(c.name) &&
        typeof c.value === "string" &&
        c.value.length <= 16384 &&
        !/[\x00-\x1f\x7f;]/.test(c.value) &&
        !c.partitionKey &&
        (c.expires === undefined ||
          c.expires === -1 ||
          c.expires === 0 ||
          (Number.isFinite(c.expires) && c.expires > now)),
    )
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: "/",
    }));
  if (rows.length > 200 || Buffer.byteLength(JSON.stringify(rows)) > 65536)
    return [];
  return rows.some(
    (c) => ["sessionid", "sessionid_ss"].includes(c.name) && c.value.length > 0,
  )
    ? rows
    : [];
}
export function browserArgs(profile, { blank = false, id = "", transport = "pipe" } = {}) {
  const args = [
    "--remote-debugging-pipe",
    "--user-data-dir=" + profile,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-mode",
    "--new-window",
    blank ? "about:blank" : LOGIN_URL,
  ];
  if (transport === "port") args.splice(0, 1,
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--enable-automation");
  // Doubao.exe is the desktop client; --saman-browser-entry is what turns it into
  // the embedded Chromium browser. Documented as best-effort: a vendor rename or
  // flag change makes the handshake fail loudly instead of silently reusing the app.
  if (id === "doubao") args.unshift("--saman-browser-entry");
  return args;
}

// CDP over inherited anonymous pipes (fd 3/4), not a listening debugging port.
// Messages are UTF-8 JSON framed by NUL; protocol errors never include payload text.
export class PipeClient {
  constructor(
    input,
    output,
    { timeoutMs = 7000, maxBytes = 2 * 1024 * 1024 } = {},
  ) {
    this.input = input;
    this.output = output;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
    this.pending = new Map();
    this.sequence = 0;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    output.on("data", (chunk) => this.receive(chunk));
    output.on("close", () => this.close());
    output.on("error", () => this.close());
    input.on("error", () => this.close());
  }
  receive(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > this.maxBytes) {
      this.close();
      return;
    }
    let end;
    while ((end = this.buffer.indexOf(0)) >= 0) {
      const frame = this.buffer.subarray(0, end);
      this.buffer = this.buffer.subarray(end + 1);
      if (!frame.length) continue;
      let data;
      try {
        data = JSON.parse(frame.toString("utf8"));
      } catch {
        this.close();
        return;
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        this.close();
        return;
      }
      const waiter = this.pending.get(data.id);
      if (!waiter) continue;
      clearTimeout(waiter.timeout);
      this.pending.delete(data.id);
      if (data.error) waiter.reject(Error("浏览器登录通信失败。"));
      else waiter.resolve(data.result || {});
    }
  }
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(Error("浏览器登录窗口已断开。"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(Error("浏览器响应超时。"));
      }, this.timeoutMs);
      timeout.unref?.();
      this.pending.set(id, { resolve, reject, timeout });
      const packet =
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }) + "\0";
      try {
        this.input.write(packet, (error) => {
          if (error) this.close();
        });
      } catch {
        this.close();
      }
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.buffer = Buffer.alloc(0);
    for (const w of this.pending.values()) {
      clearTimeout(w.timeout);
      w.reject(Error("浏览器登录窗口已断开。"));
    }
    this.pending.clear();
    this.input.destroy();
    this.output.destroy();
  }
}

export async function launchIsolatedBrowser(
  browser,
  profile,
  { spawnProcess = spawn, platform = process.platform, blank = false,
    transport = "pipe", env = process.env, uid = process.getuid?.(),
    portAddress = waitDevToolsAddress, PortClient = SocketClient } = {},
) {
  if (!["pipe", "port"].includes(transport)) throw failure(400, "浏览器通信选项无效。");
  if (platform === "linux") {
    try { checkLinuxEnvironment({ env, uid }); }
    catch (error) { throw failure(409, error.message); }
  }
  const portMode = transport === "port";
  let verifiedProfile = !portMode;
  const child = spawnProcess(
    browser.path,
    browserArgs(profile, { blank, id: browser.id, transport }),
    {
      stdio: portMode ? ["ignore", "ignore", "ignore"] : ["ignore", "ignore", "ignore", "pipe", "pipe"],
      shell: false,
      detached: false,
    },
  );
  let client;
  let exited = false, started = false;
  const exit = new Promise((resolve) => {
    child.once("exit", () => {
      exited = true;
      if (!portMode) client?.close();
      resolve();
    });
    child.once("error", () => {
      exited = true;
      if (!portMode) client?.close();
      resolve();
    });
  });
  let attachment = null;
  async function dispose() {
    if (portMode && started && !verifiedProfile) {
      client?.close();
      throw Error("临时资料目录核验未完成，请手动关闭本次窗口后重试。");
    }
    if ((portMode || !exited) && client && !client.closed)
      await Promise.race([
        client.send("Browser.close").catch(() => {}),
        pause(700),
      ]);
    if (!exited) await Promise.race([exit, pause(1200)]);
    if (!exited) {
      child.kill("SIGTERM");
      await Promise.race([exit, pause(1200)]);
    }
    if (!exited) {
      child.kill("SIGKILL");
      await Promise.race([exit, pause(1200)]);
    }
    if (portMode && client && !client.socketClosed)
      await Promise.race([client.disconnected, pause(1200)]);
    const socketClosed = !portMode || !client || client.socketClosed;
    client?.close();
    if (!socketClosed || !exited) throw Error("临时登录窗口仍在关闭，请稍后再试。");
  }
  try {
    // `spawn` precedes normal exit; a short-lived forwarding parent is valid
    // in explicit port mode. The events.once promise already rejects on error.
    await once(child, "spawn");
    started = true;
    if (portMode) {
      client = new PortClient(await portAddress(profile), {
        timeoutMs: platform === "win32" ? 10000 : 7000,
      });
      await client.ready;
      const { arguments: args = [] } = await client.send("Browser.getBrowserCommandLine");
      // A wrapper can override user-data-dir; never close or read that browser.
      if (!Array.isArray(args) || args.filter((arg) => typeof arg === "string" && arg.startsWith("--user-data-dir=")).length !== 1 ||
          !args.includes("--user-data-dir=" + profile) || args.includes("--user-data-dir")) throw Error("Browser profile mismatch");
      verifiedProfile = true;
      // The wrapper must also preserve loopback-only, random-port semantics.
      for (const [key, expected] of [["--remote-debugging-address", "127.0.0.1"], ["--remote-debugging-port", "0"]]) {
        const flags = args.filter((arg) => typeof arg === "string" && (arg === key || arg.startsWith(key + "=")));
        if (flags.length !== 1 || flags[0] !== key + "=" + expected)
          throw Error("Browser debugging flags changed");
      }
    } else {
      const input = child.stdio?.[3], output = child.stdio?.[4];
      if (!input?.write || !output?.on || exited) throw Error("Missing browser pipes");
      client = new PipeClient(input, output, { timeoutMs: platform === "win32" ? 10000 : 7000 });
    }
    const version = await client.send("Browser.getVersion");
    if (typeof version.product !== "string" || !version.product)
      throw Error("Invalid browser handshake");
  } catch {
    try {
      await dispose();
    } catch {
      throw Object.assign(
        failure(503, "独立窗口未能清理。请关闭这次打开的登录窗口再重试。"),
        { cleanupPending: true },
      );
    }
    throw failure(
      503,
      platform === "win32"
        ? "已找到浏览器，但独立登录通信未建立。请更新 Magpie 和 Chrome / Edge / 豆包；Chrome++ 等转发器可显式开启插件选项“本机随机端口兼容登录”；单位管理设备请检查开发者工具策略。"
        : "已找到浏览器，但独立登录通信未建立。请更新 Magpie 和 Chrome / Edge；如受单位策略管理，请检查是否允许浏览器开发者工具。",
    );
  }
  async function pageSession() {
    const { targetInfos = [] } = await client.send("Target.getTargets");
    const pages = targetInfos.filter((p) => p.type === "page");
    if (!pages.length) throw Error("登录窗口已关闭。");
    const page = pages.find((p) => isDoubaoPage(p.url));
    if (!page) return null;
    if (attachment?.targetId !== page.targetId) {
      if (attachment)
        await client
          .send("Target.detachFromTarget", {
            sessionId: attachment.sessionId,
          })
          .catch(() => {});
      const { sessionId } = await client.send("Target.attachToTarget", {
        targetId: page.targetId,
        flatten: true,
      });
      attachment = { targetId: page.targetId, sessionId };
    }
    return attachment.sessionId;
  }
  return {
    async cookies() {
      const sessionId = await pageSession();
      if (!sessionId) return [];
      const { cookies = [] } = await client.send(
        "Network.getCookies",
        { urls: [LOGIN_URL] },
        sessionId,
      );
      return cookies;
    },
    async identity() {
      const sessionId = await pageSession();
      if (!sessionId) return {};
      const { result } = await client.send(
        "Runtime.evaluate",
        { expression: IDENTITY_EXPRESSION, returnByValue: true },
        sessionId,
      );
      return sessionIdentity(result?.value);
    },
    dispose,
  };
}

// One active login per panel; no arbitrary executable, URL, profile or callback input.
export class BrowserLogin {
  constructor({
    tmpRoot,
    importAccount,
    discover = availableBrowsers,
    launch = launchIsolatedBrowser,
    protectProfile = (profile) =>
      process.platform === "win32"
        ? protectWindowsProfile(profile)
        : chmod(profile, 0o700),
    pollMs = 2000,
    ttlMs = 10 * 60_000,
    platform = process.platform,
    now = Date.now,
  }) {
    this.tmpRoot = tmpRoot;
    this.importAccount = importAccount;
    this.discover = discover;
    this.launch = launch;
    this.protectProfile = protectProfile;
    this.pollMs = pollMs;
    this.ttlMs = ttlMs;
    this.platform = platform;
    this.now = now;
    this.current = null;
    this.disposed = false;
    this.state = {
      id: "",
      state: "idle",
      message: "在浏览器完成登录后，将自动接入 Magpie。",
      browserName: "",
      startedAt: 0,
      expiresAt: 0,
    };
  }
  status() {
    return {
      ...this.state,
      active: ACTIVE.has(this.state.state) || this.current !== null,
    };
  }
  async options() {
    return (await this.discover()).map(({ id, name }) => ({ id, name }));
  }
  update(session, state, message, extra = {}) {
    if (this.current === session)
      this.state = { ...this.state, state, message, ...extra };
  }
  async start(browserId, context = {}) {
    if (this.disposed) throw failure(503, "登录服务正在停止。");
    if (browserId === "doubao" && this.platform !== "win32")
      throw failure(
        400,
        "豆包内置浏览器仅支持 Windows。请改用 Chrome / Edge，或在插件选项中恢复自动选择。",
      );
    if (this.current) {
      if (
        (this.current.context.destination || "local") !==
        (context.destination || "local")
      )
        throw failure(409, "已有另一种保存目标的登录会话，请先完成或取消它。");
      return this.status();
    }
    const session = {
      context,
      id: randomUUID(),
      cancelled: false,
      timer: null,
      handle: null,
      profile: null,
      finishing: null,
      busy: false,
      stable: "",
      ready: null,
    };
    this.current = session;
    const startedAt = this.now();
    this.state = {
      id: session.id,
      destination: context.destination || "local",
      state: "starting",
      message: "正在准备独立浏览器会话…",
      browserName: "",
      startedAt,
      expiresAt: startedAt + this.ttlMs,
    };
    session.ready = this.prepare(session, browserId);
    await session.ready;
    return this.status();
  }
  async prepare(session, browserId) {
    try {
      const browsers = await this.discover();
      const candidates =
        browserId === undefined
          ? browsers
          : browsers.filter((b) => b.id === browserId);
      if (!candidates.length)
        throw failure(
          409,
          browserId === undefined
            ? this.platform === "win32"
              ? "未检测到 Chrome、Edge 或豆包内置浏览器。请安装其中一个后重试；Windows 自定义安装请查看插件 README。"
              : "未检测到 Chrome、Edge 或 Chromium。自定义安装请设置 DW_CHROME_BIN / DW_EDGE_BIN / DW_CHROMIUM_BIN。"
            : "未检测到所选浏览器。请安装它，或在插件选项中恢复自动选择。",
        );
      if (session.cancelled) return;
      await mkdir(this.tmpRoot, { recursive: true, mode: 0o700 });
      let last;
      for (const browser of candidates) {
        if (session.cancelled) return;
        this.state.browserName = browser.name;
        session.profile = await mkdtemp(join(this.tmpRoot, "doubao-login-"));
        try {
          await this.protectProfile(session.profile);
        } catch {
          throw failure(
            503,
            "临时登录目录的权限设置未完成，请检查 Magpie 运行目录后重试。",
          );
        }
        if (session.cancelled) return;
        try {
          session.handle = await this.launch(browser, session.profile, {
            platform: this.platform,
            transport: session.context.transport === "port" ? "port" : "pipe",
          });
        } catch (error) {
          if (error?.cleanupPending) {
            session.cleanupPending = true;
            throw error;
          }
          last = error;
          await rm(session.profile, {
            recursive: true,
            force: true,
            maxRetries: 4,
            retryDelay: 150,
          });
          session.profile = null;
          continue;
        }
        if (session.cancelled) return;
        this.update(
          session,
          "waiting",
          "请在新打开的 " +
            browser.name +
            " 窗口登录豆包，再回到确认页接入 Magpie，无需复制 Cookie。",
        );
        this.schedule(session);
        return;
      }
      throw last;
    } catch (error) {
      this.update(
        session,
        "error",
        error.status
          ? error.message
          : "浏览器登录启动失败，请检查桌面会话与 Chrome / Edge / 豆包安装。",
      );
      await this.finish(session);
    } finally {
      if (session.cancelled) await this.finish(session);
    }
  }
  schedule(session) {
    if (this.current !== session || session.cancelled) return;
    session.timer = setTimeout(() => {
      void this.inspect(session);
    }, this.pollMs);
    session.timer.unref?.();
  }
  async inspect(session) {
    if (this.current !== session || session.cancelled || session.busy) return;
    session.busy = true;
    try {
      if (this.now() >= this.state.expiresAt) {
        this.update(
          session,
          "expired",
          "本次登录已超时，请重新打开浏览器登录。",
        );
        await this.finish(session);
        return;
      }
      const cookies = doubaoCookies(await session.handle.cookies());
      if (this.current !== session || session.cancelled) return;
      if (!cookies.length) {
        session.stable = "";
        this.schedule(session);
        return;
      }
      const fingerprint = createHash("sha256")
        .update(
          cookies
            .filter((c) => ["sessionid", "sessionid_ss"].includes(c.name))
            .map((c) => c.name + "=" + c.value)
            .sort()
            .join(";"),
        )
        .digest("hex");
      if (fingerprint !== session.stable) {
        session.stable = fingerprint;
        this.schedule(session);
        return;
      }
      if (session.context.manual && session.confirmed !== fingerprint) {
        this.update(
          session,
          "awaiting_confirmation",
          "已检测到登录。请先在独立窗口完成官网验证，再回到登录进度页点击“接入 Magpie”。",
        );
        this.schedule(session);
        return;
      }
      this.update(
        session,
        "importing",
        "检测到豆包登录，正在核验账号并保存到本机…",
      );
      // Exactly one import attempt. A timeout is uncertain, not a reason to retry silently.
      let identity = {},
        identityMissing = true;
      try {
        identity = (await session.handle.identity?.()) || {};
        identityMissing = !(identity.deviceId && identity.webId);
      } catch {
        identity = {};
      }
      if (
        identityMissing &&
        this.current === session &&
        !session.cancelled
      )
        this.update(
          session,
          "importing",
          "未从浏览器读取到完整的设备标识，正在回退本机客户端 Local State…",
          { identityMissing: true },
        );
      if (this.current !== session || session.cancelled) return;
      let result;
      try {
        result = await this.importAccount(cookies, {
          ...session.context,
          identity,
        });
      } catch {
        this.update(
          session,
          "error",
          session.context.destination === "cloud"
            ? "账号接入或同步结果待核对。请先检查本机和云端列表；确认结果后再操作。"
            : "账号接入结果待核对。请先刷新账号列表；确认未接入后，再重新登录。",
        );
        await this.finish(session);
        return;
      }
      if (
        !result ||
        typeof result.name !== "string" ||
        typeof result.updated !== "boolean"
      )
        throw Error("账号核验结果异常。");
      this.update(
        session,
        "success",
        result.cloudSynced
          ? "登录已完成，账号已自动接入云端。"
          : result.updated
            ? "已更新这个账号的登录状态；账号总数保持不变。"
            : "新账号已接入，账号列表会自动刷新。",
        {
          accountName: result.name.slice(0, 64),
          updated: result.updated,
          cloudSynced: result.cloudSynced === true,
          cloudOrigin: result.cloudOrigin || "",
          identityMissing,
        },
      );
      await this.finish(session);
    } catch {
      this.update(
        session,
        "error",
        "浏览器会话已断开，请重新打开登录。已有账号不受影响。",
      );
      await this.finish(session);
    } finally {
      session.busy = false;
    }
  }
  async finish(session) {
    if (session.finishing) return session.finishing;
    clearTimeout(session.timer);
    session.stable = "";
    session.finishing = (async () => {
      let closed = !session.cleanupPending;
      if (session.handle)
        try {
          await session.handle.dispose();
        } catch {
          closed = false;
        }
      if (session.profile && closed)
        await rm(session.profile, {
          recursive: true,
          force: true,
          maxRetries: 4,
          retryDelay: 150,
        }).catch(() => {
          closed = false;
        });
      if (!closed && this.current === session)
        this.state = {
          ...this.state,
          message:
            this.state.message + " 临时会话清理未完成，请关闭专用窗口后检查。",
          cleanupPending: true,
        };
      if (this.current === session) this.current = null;
    })();
    return session.finishing;
  }
  async confirm(id) {
    const session = this.current;
    if (
      !session ||
      session.id !== id ||
      !session.context.manual ||
      this.state.state !== "awaiting_confirmation" ||
      !session.stable
    )
      throw failure(409, "当前没有可以确认的独立登录，请等待登录检测完成。");
    if (session.busy) throw failure(409, "正在检查登录状态，请稍后点击接入。");
    session.confirmed = session.stable;
    clearTimeout(session.timer);
    await this.inspect(session);
    return this.status();
  }
  async cancel({ shutdown = false } = {}) {
    const session = this.current;
    if (!session) return this.status();
    if (this.state.state === "importing" && !shutdown)
      throw failure(409, "账号正在核验，请等待本次结果后再关闭。");
    session.cancelled = true;
    clearTimeout(session.timer);
    this.update(
      session,
      "cancelled",
      "本次浏览器登录已取消，已有账号不受影响。",
    );
    await session.ready;
    await this.finish(session);
    return this.status();
  }
  async dispose() {
    this.disposed = true;
    await this.cancel({ shutdown: true });
  }
}
