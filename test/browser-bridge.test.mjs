import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtemp, stat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserLogin,
  PipeClient,
  doubaoCookies,
  isDoubaoPage,
  browserArgs,
  availableBrowsers,
} from "../browser-login.mjs";
const cookie = {
  name: "sessionid",
  value: "FIXTURE_SESSION",
  domain: ".doubao.com",
  path: "/",
  expires: -1,
};
const options = [
  { id: "chrome", name: "Google Chrome", path: "/fixture/chrome" },
];
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
async function setup(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "dw-browser-test-"));
  let imports = 0,
    closes = 0,
    profile = "";
  let cookies = [];
  const login = new BrowserLogin({
    tmpRoot: root,
    pollMs: 60_000,
    discover: async () => options,
    launch: async (_b, p) => {
      profile = p;
      return {
        cookies: async () => cookies,
        dispose: async () => {
          closes++;
        },
      };
    },
    importAccount: async (rows) => {
      assert.deepEqual(rows, doubaoCookies([cookie]));
      imports++;
      return { name: "测试账号", updated: false };
    },
    ...overrides,
  });
  return {
    root,
    login,
    setCookies: (c) => (cookies = c),
    get imports() {
      return imports;
    },
    get closes() {
      return closes;
    },
    get profile() {
      return profile;
    },
    inspect: async () => {
      const session = login.current;
      clearTimeout(session?.timer);
      if (session) await login.inspect(session);
    },
    done: async () => {
      await login.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test("只接受豆包 HTTPS 页面与根路径 Cookie", () => {
  for (const url of ["https://www.doubao.com/chat/", "https://doubao.com/"])
    assert(isDoubaoPage(url));
  for (const url of [
    "http://www.doubao.com/",
    "https://doubao.com.evil.test/",
    "https://other.doubao.com/",
    "https://x@www.doubao.com/",
    "https://www.doubao.com:9443",
    "not-url",
  ])
    assert(!isDoubaoPage(url));
  for (const extra of [
    { domain: ".evil.test" },
    { path: "/other" },
    { expires: 1 },
    { value: "" },
    { partitionKey: {} },
    { value: "bad\r\n" },
    { name: "bad;name" },
  ])
    assert.deepEqual(doubaoCookies([{ ...cookie, ...extra }]), []);
  assert.deepEqual(
    doubaoCookies([
      { ...cookie, httpOnly: true, secure: true, secret: "discard" },
    ]),
    [
      {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: "/",
      },
    ],
  );
  assert.deepEqual(
    doubaoCookies(Array.from({ length: 201 }, () => cookie)),
    [],
  );
});
test("临时资料目录与匿名管道，无调试监听端口或沙箱关闭参数", async () => {
  const args = browserArgs("/tmp/fixture");
  assert(args.includes("--remote-debugging-pipe"));
  assert(args.includes("--user-data-dir=/tmp/fixture"));
  assert(
    !args.some((a) =>
      /remote-debugging-port|no-sandbox|disable-web-security/.test(a),
    ),
  );
  assert.deepEqual(await availableBrowsers("fixture"), []);
});
test("管道按 NUL 分帧，支持分片中文响应，过滤远端错误详情", async () => {
  const input = new PassThrough(),
    output = new PassThrough(),
    client = new PipeClient(input, output);
  const p = client.send("Fixture.method", {}, "session-fixture");
  const packet = input.read().toString();
  assert(packet.endsWith("\0"));
  assert.equal(JSON.parse(packet.slice(0, -1)).sessionId, "session-fixture");
  const response = Buffer.from(
    JSON.stringify({ id: 1, result: { name: "中文测试" } }) + "\0",
  );
  for (const byte of response) output.write(Buffer.from([byte]));
  assert.deepEqual(await p, { name: "中文测试" });
  const q = client.send("Fixture.error");
  input.read();
  output.write(
    JSON.stringify({ id: 2, error: { message: "SENSITIVE" } }) + "\0",
  );
  await assert.rejects(q, (e) => !e.message.includes("SENSITIVE"));
  client.close();
});
test("畸形和超大管道消息关闭连接且不展示载荷", async () => {
  for (const frame of ["null\0", "[]\0", "invalid-json\0", "x".repeat(40)]) {
    const input = new PassThrough(),
      output = new PassThrough(),
      client = new PipeClient(input, output, { maxBytes: 30 });
    const p = client.send("Fixture.test");
    input.read();
    output.write(frame);
    await assert.rejects(p, /已断开/);
    assert(client.closed);
  }
});
test("浏览器登录单实例；稳定会话只接入一次；清理临时资料", async () => {
  const f = await setup();
  try {
    const [a, b] = await Promise.all([
      f.login.start("chrome"),
      f.login.start("chrome"),
    ]);
    assert.equal(a.id, b.id);
    const profileInfo = await stat(f.profile);
    assert(profileInfo.isDirectory());
    if (process.platform !== "win32")
      assert.equal(profileInfo.mode & 0o777, 0o700);
    assert.equal(f.login.status().state, "waiting");
    f.setCookies([cookie]);
    await f.inspect();
    assert.equal(f.imports, 0);
    await f.inspect();
    assert.equal(f.imports, 1);
    assert.equal(f.login.status().state, "success");
    assert.equal(f.login.status().active, false);
    assert.equal(f.closes, 1);
    assert(!JSON.stringify(f.login.status()).includes(cookie.value));
    assert.deepEqual(await readdir(f.root), []);
    await f.inspect();
    assert.equal(f.imports, 1);
  } finally {
    await f.done();
  }
});
test("重复账号报告更新而非新增；取消后下一次是全新会话", async () => {
  const f = await setup({
    importAccount: async () => ({ name: "旧账号", updated: true }),
  });
  try {
    const a = await f.login.start();
    await f.login.cancel();
    assert.equal(f.login.status().state, "cancelled");
    assert.equal(f.closes, 1);
    assert.deepEqual(await readdir(f.root), []);
    const b = await f.login.start();
    assert.notEqual(a.id, b.id);
    f.setCookies([cookie]);
    await f.inspect();
    await f.inspect();
    assert.equal(f.login.status().updated, true);
    assert.match(f.login.status().message, /保持不变/);
  } finally {
    await f.done();
  }
});
test("10 分钟超时与手动关窗均释放临时会话，不提交账号", async () => {
  let now = 1000;
  const f = await setup({ now: () => now });
  try {
    await f.login.start();
    now += 600_001;
    await f.inspect();
    assert.equal(f.login.status().state, "expired");
    assert.equal(f.imports, 0);
    assert.deepEqual(await readdir(f.root), []);
  } finally {
    await f.done();
  }
  const g = await setup({
    launch: async () => ({
      cookies: async () => {
        throw Error("SENSITIVE");
      },
      dispose: async () => {},
    }),
  });
  try {
    await g.login.start();
    await g.inspect();
    assert.equal(g.login.status().state, "error");
    assert(!JSON.stringify(g.login.status()).includes("SENSITIVE"));
    assert.deepEqual(await readdir(g.root), []);
  } finally {
    await g.done();
  }
});
test("导入结果不确定时停止、不重复提交、不回显凭据", async () => {
  let count = 0;
  const f = await setup({
    importAccount: async () => {
      count++;
      throw Error("SENSITIVE");
    },
  });
  try {
    await f.login.start();
    f.setCookies([cookie]);
    await f.inspect();
    await f.inspect();
    await f.inspect();
    assert.equal(count, 1);
    assert.equal(f.login.status().state, "error");
    assert.match(f.login.status().message, /待核对/);
    assert(!JSON.stringify(f.login.status()).includes("SENSITIVE"));
    assert.equal(f.closes, 1);
  } finally {
    await f.done();
  }
});
test("启动中取消会等待资源就绪再清理；核验时避免误取消", async () => {
  const gate = deferred(),
    launched = deferred();
  let closes = 0;
  const f = await setup({
    launch: async () => {
      launched.resolve();
      await gate.promise;
      return {
        cookies: async () => [],
        dispose: async () => {
          closes++;
        },
      };
    },
  });
  try {
    const start = f.login.start();
    await Promise.race([launched.promise, start]);
    const cancel = f.login.cancel();
    gate.resolve();
    await Promise.all([start, cancel]);
    assert.equal(f.login.status().state, "cancelled");
    assert.equal(closes, 1);
    assert.deepEqual(await readdir(f.root), []);
  } finally {
    gate.resolve();
    await f.done();
  }
  const importGate = deferred(),
    importing = deferred(),
    g = await setup({
      importAccount: async () => {
        importing.resolve();
        await importGate.promise;
        return { name: "甲", updated: false };
      },
    });
  try {
    await g.login.start();
    g.setCookies([cookie]);
    await g.inspect();
    const inspecting = g.inspect();
    await Promise.race([importing.promise, inspecting]);
    await assert.rejects(g.login.cancel(), (e) => e.status === 409);
    importGate.resolve();
    await inspecting;
    assert.equal(g.login.status().state, "success");
  } finally {
    importGate.resolve();
    await g.done();
  }
});
test("未安装浏览器、非法选择、启动失败都有明确结果", async () => {
  for (const settings of [
    { discover: async () => [] },
    {
      launch: async () => {
        throw Error("SENSITIVE");
      },
    },
  ]) {
    const f = await setup(settings);
    try {
      await f.login.start();
      assert.equal(f.login.status().state, "error");
      assert(!JSON.stringify(f.login.status()).includes("SENSITIVE"));
      assert.deepEqual(await readdir(f.root), []);
    } finally {
      await f.done();
    }
  }
  const f = await setup();
  try {
    await f.login.start("/arbitrary/executable");
    assert.equal(f.login.status().state, "error");
    assert.deepEqual(await readdir(f.root), []);
  } finally {
    await f.done();
  }
});
test("云端登录上下文传入接入回调，成功状态与失败状态均脱敏", async () => {
  let calls = 0;
  const f = await setup({
    importAccount: async (_cookies, context) => {
      calls++;
      assert.deepEqual(context, { destination: "cloud" });
      return {
        name: "测试账号",
        updated: false,
        cloudSynced: true,
        cloudOrigin: "https://cloud.example.test",
      };
    },
  });
  try {
    await f.login.start("chrome", { destination: "cloud" });
    f.setCookies([cookie]);
    await f.inspect();
    await f.inspect();
    assert.equal(calls, 1);
    assert.equal(f.login.status().cloudSynced, true);
    assert.match(f.login.status().message, /自动接入云端/);
  } finally {
    await f.done();
  }
  const g = await setup({
    importAccount: async () => {
      throw Error("FIXTURE_PRIVATE_COOKIE");
    },
  });
  try {
    await g.login.start("chrome", { destination: "cloud" });
    g.setCookies([cookie]);
    await g.inspect();
    await g.inspect();
    assert.equal(g.login.status().state, "error");
    assert.match(g.login.status().message, /待核对/);
    assert(
      !JSON.stringify(g.login.status()).includes("FIXTURE_PRIVATE_COOKIE"),
    );
  } finally {
    await g.done();
  }
});
test("进行中的浏览器会话固定保存目标，跨目标启动会明确提示", async () => {
  const f = await setup();
  try {
    await f.login.start("chrome", { destination: "local" });
    assert.equal(f.login.status().destination, "local");
    await assert.rejects(
      f.login.start("chrome", { destination: "cloud" }),
      (e) => e.status === 409,
    );
    assert.equal(f.login.status().destination, "local");
  } finally {
    await f.done();
  }
});

test("需要用户确认的登录：稳定 Cookie 先保留窗口，确认后才接入", async () => {
  const f = await setup();
  try {
    await f.login.start(undefined, { manual: true });
    f.setCookies([cookie]);
    await f.inspect();
    await f.inspect();
    assert.equal(f.login.status().state, "awaiting_confirmation");
    assert.equal(f.imports, 0);
    assert.equal(f.closes, 0);
    await assert.rejects(
      f.login.confirm("not_this_flow"),
      (e) => e.status === 409,
    );
    await f.login.confirm(f.login.status().id);
    assert.equal(f.imports, 1);
    assert.equal(f.closes, 1);
    assert.equal(f.login.status().state, "success");
  } finally {
    await f.done();
  }
});
