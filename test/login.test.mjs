import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLoginManager } from "../login.mjs";
class FakeBrowser {
  constructor(options) {
    this.options = options;
    this.state = { state: "idle", active: false };
  }
  async start() {
    this.state = { state: "waiting", active: true, message: "等待登录" };
  }
  status() {
    return this.state;
  }
  async dispose() {
    this.state = { state: "cancelled", active: false, message: "已取消" };
  }
  async cancel() {
    return this.dispose();
  }
}
test("独立登录门户不回显 Cookie，取消与来源校验可靠，双开被明确提示", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dw-login-"));
  const manager = createLoginManager({
    root: dir,
    api: {},
    Browser: FakeBrowser,
  });
  try {
    const flow = await manager.start();
    assert(new URL(flow.url).hostname === "127.0.0.1");
    const html = await fetch(flow.url);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /独立浏览器/);
    const { Script } = await import("node:vm");
    new Script(await (await fetch(flow.url + "flow.js")).text());
    await assert.rejects(manager.start(), (e) => e.status === 409);
    assert.equal((await fetch(flow.url + "status")).status, 403);
    const status = await (
      await fetch(flow.url + "status", { headers: { "X-Doubao-Login": "1" } })
    ).json();
    assert.equal(status.state, "waiting");
    assert.equal(status.access, undefined);
    assert.equal(
      (
        await fetch(flow.url + "cancel", {
          method: "POST",
          headers: { Origin: "https://foreign.test", "X-Doubao-Login": "1" },
        })
      ).status,
      403,
    );
    const controller = new AbortController(),
      result = flow.callback(undefined, { signal: controller.signal });
    controller.abort();
    assert.equal((await result).type, "failed");
    await assert.rejects(fetch(flow.url));
  } finally {
    await manager.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
test("登录成功只向回调交付一次凭据，门户及临时浏览器及时关闭", async () => {
  let browser;
  class LoginBrowser extends FakeBrowser {
    constructor(o) {
      super(o);
      browser = this;
    }
    async complete() {
      await this.options.importAccount([
        {
          name: "sessionid",
          value: "FIXTURE_COOKIE",
          domain: ".doubao.com",
          path: "/",
        },
      ]);
      this.state = { state: "success", active: false, message: "已接入" };
    }
  }
  const dir = await mkdtemp(join(tmpdir(), "dw-login-success-")),
    manager = createLoginManager({
      root: dir,
      Browser: LoginBrowser,
      metadata: async () => ({ deviceId: "FIXTURE_DEVICE" }),
      api: {
        identify: async (secret) => ({
          ...secret,
          userId: "FIXTURE_USER",
          name: "测试账号",
        }),
      },
    });
  try {
    const flow = await manager.start();
    await browser.complete();
    const status = await (
      await fetch(flow.url + "status", { headers: { "X-Doubao-Login": "1" } })
    ).text();
    assert(!status.includes("FIXTURE_COOKIE"));
    assert(!status.includes("FIXTURE_USER"));
    const result = await flow.callback();
    assert.equal(result.type, "success");
    assert.equal(result.uid, "FIXTURE_USER:0");
    assert.equal(browser.state.state, "cancelled");
    assert.equal((await flow.callback()).type, "failed");
    await assert.rejects(fetch(flow.url));
    const next = await manager.start();
    assert(next.url !== flow.url);
  } finally {
    await manager.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
test("外层取消立即清理窗口，之后可以重新登录", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dw-login-parent-")),
    manager = createLoginManager({ root: dir, api: {}, Browser: FakeBrowser });
  try {
    const controller = new AbortController(),
      flow = await manager.start({ signal: controller.signal }),
      result = flow.callback();
    controller.abort();
    assert.equal((await result).type, "failed");
    await assert.rejects(fetch(flow.url));
    const next = await manager.start();
    assert(new URL(next.url).port);
  } finally {
    await manager.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("登录确认只允许同源 POST，确认前不读取或保存账号", async () => {
  let identifies = 0;
  class ManualBrowser extends FakeBrowser {
    async start(_id, context) {
      assert.equal(context.manual, true);
      this.state = {
        id: "FLOW_FIXTURE",
        state: "awaiting_confirmation",
        active: true,
        message: "等待本人确认",
      };
    }
    async confirm(id) {
      assert.equal(id, "FLOW_FIXTURE");
      await this.options.importAccount([
        {
          name: "sessionid",
          value: "FIXTURE_COOKIE",
          domain: ".doubao.com",
          path: "/",
        },
      ]);
      this.state = { state: "success", active: false, message: "已接入" };
    }
  }
  const dir = await mkdtemp(join(tmpdir(), "dw-confirm-")),
    manager = createLoginManager({
      root: dir,
      Browser: ManualBrowser,
      metadata: async () => ({}),
      api: {
        identify: async (secret) => {
          identifies++;
          return { ...secret, userId: "FIXTURE_USER", name: "测试账号" };
        },
      },
    });
  try {
    const flow = await manager.start(),
      origin = new URL(flow.url).origin;
    assert.equal(identifies, 0);
    assert((await (await fetch(flow.url)).text()).includes("接入 Magpie"));
    for (const headers of [
      { "X-Doubao-Login": "1" },
      { "X-Doubao-Login": "1", Origin: "https://foreign.test" },
    ])
      assert.equal(
        (await fetch(flow.url + "confirm", { method: "POST", headers })).status,
        403,
      );
    assert.equal(identifies, 0);
    const result = flow.callback();
    assert.equal(
      (
        await fetch(flow.url + "confirm", {
          method: "POST",
          headers: { "X-Doubao-Login": "1", Origin: origin },
        })
      ).status,
      200,
    );
    assert.equal((await result).type, "success");
    assert.equal(identifies, 1);
  } finally {
    await manager.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
