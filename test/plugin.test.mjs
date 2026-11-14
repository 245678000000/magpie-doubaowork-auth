import { test } from "node:test";
import assert from "node:assert/strict";
import plugin, { _internal } from "../index.mjs";
import { saveAuth } from "../protocol.mjs";
const auth = {
  ...saveAuth({
    cookieHeader: "sessionid=FIXTURE_A",
    userId: "A",
    enterpriseType: "0",
    name: "甲",
  }),
  type: "oauth",
};
test("Magpie 原生钩子，默认无虚构模型，账号凭据逐请求读取且不转发网关头", async () => {
  const seen = [];
  const api = {
    catalog: async (s) => {
      seen.push(s.userId);
      return {
        bot: "B",
        models: {
          flash: {
            id: "flash",
            name: "Flash",
            agentMode: 0,
            deepThink: 0,
            extra: {},
          },
        },
      };
    },
    post: async () =>
      new Response(
        'event: CHUNK_DELTA\ndata: {"text":"OK"}\n\nevent: SSE_REPLY_END\ndata: {}\n\n',
      ),
    usage: async (s) => ({ user: s.name, windows: [] }),
  };
  const hooks = _internal.createHooks(
    { directory: "/fixture" },
    {},
    { api, login: {}, checkin: {} },
  );
  const cfg = {};
  await hooks.config(cfg);
  assert.deepEqual(cfg.provider["doubaowork-direct"].models, {});
  assert.equal(hooks.auth.provider, "doubaowork-direct");
  const list = await hooks.provider.models({ models: {} }, { auth });
  assert.equal(list.flash.name, "Flash");
  assert.equal(list.flash.capabilities.attachment, false);
  let current = auth;
  const loaded = await hooks.auth.loader(async () => current);
  const b = {
    model: "flash",
    messages: [{ role: "user", content: "OK" }],
    stream: false,
  };
  const r = await loaded.fetch(
    "https://www.doubao.com/magpie/v1/chat/completions",
    {
      body: JSON.stringify(b),
      headers: { Authorization: "Bearer A_GATEWAY_KEY" },
    },
  );
  assert.equal(r.status, 200);
  assert.equal((await r.json()).choices[0].message.content, "OK");
  assert(seen.every((x) => x === "A"));
  current = {
    ...saveAuth({
      cookieHeader: "sessionid=FIXTURE_B",
      userId: "B",
      name: "乙",
    }),
    type: "oauth",
  };
  await loaded.fetch("https://www.doubao.com/magpie/v1/chat/completions", {
    body: JSON.stringify(b),
  });
  assert.equal(seen.at(-1), "B");
  const rejected = await loaded.fetch("https://foreign.test/chat/completions", {
    body: JSON.stringify(b),
  });
  assert.equal(rejected.status, 400);
});
test("失效登录返回原生 expired 标记，目录失联保留旧模型", async () => {
  const e = Object.assign(Error("会话失效"), {
      status: 401,
      signIn: "expired",
    }),
    r = _internal.errorResponse(e);
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("X-Magpie-Sign-In"), "expired");
  const hooks = _internal.createHooks(
    {},
    {},
    {
      api: {
        catalog: async () => {
          throw Error("NETWORK_PRIVATE");
        },
      },
      login: {},
      checkin: {},
    },
  );
  const old = { models: { known: { id: "known" } } };
  assert.deepEqual(await hooks.provider.models(old, { auth }), old.models);
  const exported = await import("../index.mjs");
  assert.deepEqual(
    Object.keys(exported).filter((k) => typeof exported[k] === "function"),
    ["default"],
  );
});
test("原生插件开关即时生效：关闭工具桥和双重签到 opt-in", async () => {
  const values = { prompt_tools: true, checkin_enabled: false };
  let claims = 0;
  const hooks = _internal.createHooks(
    { magpie: { option: (_provider, key) => values[key] } },
    {},
    {
      login: {},
      checkin: {
        run: async () => {
          claims++;
          return { outcome: "done" };
        },
      },
      api: {
        catalog: async () => ({
          bot: "B",
          models: {
            flash: { id: "flash", name: "Flash", deepThink: 0, extra: {} },
          },
        }),
      },
    },
  );
  assert.deepEqual(
    hooks.auth.options.map((o) => [o.key, o.default]),
    [
      ["browser_loopback", false],
      ["prompt_tools", true],
      ["checkin_enabled", false],
    ],
  );
  assert.equal(
    (await hooks.provider.models({}, { auth })).flash.tool_call,
    true,
  );
  values.prompt_tools = false;
  assert.equal(
    (await hooks.provider.models({}, { auth })).flash.tool_call,
    false,
  );
  assert.equal(
    (await hooks.auth.checkin(async () => auth)).outcome,
    "inactive",
  );
  assert.equal(claims, 0);
  values.checkin_enabled = true;
  assert.equal((await hooks.auth.checkin(async () => auth)).outcome, "done");
  assert.equal(claims, 1);
});

test("客户端只接收规范错误分类与数字上游码，不携带挑战内容", async () => {
  const { vendorError } = await import("../protocol.mjs");
  const e = vendorError(200, {
    error_code: 710022004,
    extra: {
      decision: JSON.stringify({
        type: "verify",
        challenge: "FIXTURE_PRIVATE_CHALLENGE",
      }),
    },
  });
  const r = _internal.errorResponse(e),
    body = await r.json();
  assert.equal(r.status, 429);
  assert.equal(body.error.code, "verification_required");
  assert.equal(body.error.upstream_code, 710022004);
  assert(!JSON.stringify(body).includes("FIXTURE_PRIVATE_CHALLENGE"));
});


test("Chrome++ loopback login stays opt-in and is read live from the native switch", async () => {
  const calls = [], values = {};
  const hooks = _internal.createHooks({ directory: "/fixture", magpie: { option: (_provider, key) => values[key] } }, {}, {
    api: {}, checkin: {}, login: { start: async (options) => { calls.push(options); return {}; } },
  });
  await hooks.auth.methods[0].authorize();
  assert.equal(calls[0].transport, "pipe");
  values.browser_loopback = true;
  await hooks.auth.methods[0].authorize();
  assert.equal(calls[1].transport, "port");
  values.browser_loopback = false;
  await hooks.auth.methods[0].authorize();
  assert.equal(calls[2].transport, "pipe");
});
