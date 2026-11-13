import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, chmod, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { once } from "node:events";

const LOGIN_URL = "https://www.doubao.com/chat/";
const ACTIVE = new Set(["starting", "waiting", "importing"]);
const failure = (status, message) =>
  Object.assign(new Error(message), { status });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Discover executable locations only. Never inspect the user's regular browser profile.
export async function availableBrowsers(
  platform = process.platform,
  home = homedir(),
) {
  if (platform !== "darwin") return [];
  const choices = [
    ["chrome", "Google Chrome", "Google Chrome.app", "Google Chrome"],
    ["edge", "Microsoft Edge", "Microsoft Edge.app", "Microsoft Edge"],
  ];
  const result = [];
  for (const [id, name, app, bin] of choices) {
    for (const apps of ["/Applications", join(home, "Applications")]) {
      const path = join(apps, app, "Contents/MacOS", bin);
      if (
        await access(path, constants.X_OK).then(
          () => true,
          () => false,
        )
      ) {
        result.push({ id, name, path });
        break;
      }
    }
  }
  return result;
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
export function browserArgs(profile) {
  return [
    "--remote-debugging-pipe",
    "--user-data-dir=" + profile,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-mode",
    "--new-window",
    LOGIN_URL,
  ];
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
  { spawnProcess = spawn } = {},
) {
  const child = spawnProcess(browser.path, browserArgs(profile), {
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    shell: false,
    detached: false,
  });
  const client = new PipeClient(child.stdio[3], child.stdio[4]);
  let exited = false;
  const exit = new Promise((resolve) => {
    child.once("exit", () => {
      exited = true;
      client.close();
      resolve();
    });
    child.once("error", () => {
      exited = true;
      client.close();
      resolve();
    });
  });
  let attachment = null;
  async function dispose() {
    if (!exited && !client.closed)
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
    client.close();
    if (!exited) throw Error("临时登录窗口仍在关闭，请稍后再试。");
  }
  try {
    await Promise.race([
      once(child, "spawn"),
      exit.then(() => {
        throw Error("浏览器启动失败。");
      }),
    ]);
    await client.send("Browser.getVersion");
  } catch {
    await dispose();
    throw failure(
      503,
      "浏览器启动失败，请检查 Chrome / Edge 安装，或使用备用窗口。",
    );
  }
  return {
    async cookies() {
      const { targetInfos = [] } = await client.send("Target.getTargets");
      const pages = targetInfos.filter((p) => p.type === "page");
      if (!pages.length) throw Error("登录窗口已关闭。");
      const page = pages.find((p) => isDoubaoPage(p.url));
      if (!page) return [];
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
      const { cookies = [] } = await client.send(
        "Network.getCookies",
        { urls: [LOGIN_URL] },
        attachment.sessionId,
      );
      return cookies;
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
    pollMs = 2000,
    ttlMs = 10 * 60_000,
    now = Date.now,
  }) {
    this.tmpRoot = tmpRoot;
    this.importAccount = importAccount;
    this.discover = discover;
    this.launch = launch;
    this.pollMs = pollMs;
    this.ttlMs = ttlMs;
    this.now = now;
    this.current = null;
    this.disposed = false;
    this.state = {
      id: "",
      state: "idle",
      message: "在浏览器完成登录后，将自动接入本机网关。",
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
      const browser =
        browserId === undefined
          ? browsers[0]
          : browsers.find((b) => b.id === browserId);
      if (!browser)
        throw failure(
          409,
          "未找到所选浏览器。请安装 Chrome / Edge，或使用备用独立窗口。",
        );
      if (session.cancelled) return;
      this.state.browserName = browser.name;
      await mkdir(this.tmpRoot, { recursive: true, mode: 0o700 });
      session.profile = await mkdtemp(join(this.tmpRoot, "doubao-login-"));
      await chmod(session.profile, 0o700);
      if (session.cancelled) return;
      session.handle = await this.launch(browser, session.profile);
      if (session.cancelled) return;
      this.update(
        session,
        "waiting",
        "请在新打开的 " +
          browser.name +
          " 窗口登录豆包。完成后会自动接入，无需复制 Cookie。",
      );
      this.schedule(session);
    } catch (error) {
      this.update(
        session,
        "error",
        error.status
          ? error.message
          : "浏览器登录启动失败，请重试或使用备用窗口。",
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
      this.update(
        session,
        "importing",
        "检测到豆包登录，正在核验账号并保存到本机…",
      );
      // Exactly one import attempt. A timeout is uncertain, not a reason to retry silently.
      let result;
      try {
        result = await this.importAccount(cookies, session.context);
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
      let closed = true;
      if (session.handle)
        try {
          await session.handle.dispose();
        } catch {
          closed = false;
        }
      if (session.profile && closed)
        await rm(session.profile, { recursive: true, force: true }).catch(
          () => {
            closed = false;
          },
        );
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
