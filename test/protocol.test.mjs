import { test } from "node:test";
import assert from "node:assert/strict";
import {
  endpoint,
  credentials,
  readAuth,
  saveAuth,
  parseCatalog,
  createApi,
  quotaView,
} from "../protocol.mjs";
const secret = {
  cookieHeader: "sessionid=FIXTURE_SESSION; web_id=456",
  deviceId: "123",
  webId: "456",
  userId: "U",
  enterpriseType: "0",
  name: "测试账号",
};
test("凭据仅从当前账号解析，地址固定官方源，保存不嵌入模型管理 Key", () => {
  const auth = saveAuth(secret);
  assert.equal(auth.type, "success");
  assert.equal(
    readAuth({ ...auth, type: "oauth" }).cookieHeader,
    secret.cookieHeader,
  );
  const u = new URL(endpoint(secret, "/alice/user/launch"));
  assert.equal(u.origin, "https://www.doubao.com");
  assert.equal(u.searchParams.get("device_id"), "123");
  assert.equal(u.searchParams.get("web_id"), "456");
  assert.throws(
    () => endpoint(secret, "https://foreign.test/"),
    (e) => e.status === 400,
  );
  for (const value of [
    { cookieHeader: "bad" },
    { cookieHeader: "sessionid=x\r\nsecret" },
    {
      cookies: [
        { name: "sessionid", value: "x", domain: ".foreign.test", path: "/" },
      ],
    },
  ])
    assert.throws(() => credentials(value));
});
test("实时模型菜单按模式区分 ID，不编造静态模型", () => {
  const models = parseCatalog({
    data: {
      entry_list: [
        {
          active_switch_conf: {
            use_menu_conf_v2: true,
            menu_conf_v2: {
              mode_list: {
                item_list: [{ mode_id: "3", agent_mode: 2, name: "对话" }],
              },
              model_list: {
                item_list: [
                  {
                    model_item_key: "flash",
                    name: "Flash",
                    default_mode: "3",
                    menu_type: 4,
                    model_extra_params: '{"provider_id":"vendor"}',
                  },
                ],
              },
            },
          },
        },
      ],
    },
  });
  assert.equal(Object.keys(models).length, 1);
  assert.equal(models.flash.agentMode, 2);
  assert.equal(models.flash.extra.provider_id, "vendor");
  assert.deepEqual(parseCatalog({}), {});
});
test("请求只发官方固定路径，重定向与网络异常不泄漏凭据", async () => {
  const calls = [];
  const api = createApi({
    fetchImpl: async (url, o) => {
      calls.push([url, o]);
      return new Response(
        JSON.stringify({ code: 0, data: { assistant_bot_id: "BOT" } }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  const r = await api.post(secret, "/alice/user/launch", {});
  assert.equal(r.data.assistant_bot_id, "BOT");
  assert.equal(calls[0][1].redirect, "error");
  assert.equal(calls[0][1].headers.get("cookie"), secret.cookieHeader);
  const broken = createApi({
    fetchImpl: async () => {
      throw Error(secret.cookieHeader);
    },
  });
  await assert.rejects(
    broken.post(secret, "/alice/user/launch", {}),
    (e) => !e.message.includes("FIXTURE_SESSION"),
  );
});
test("额度未知时不伪造百分比，按奖励额度实际剩余显示", () => {
  const v = quotaView({
    data: {
      incentive_quota_section: {
        window_limit_groups: [
          {
            window_limits: [
              { window_type: 3, total_amount: 600, used_amount: 100 },
            ],
          },
        ],
      },
    },
  });
  assert.equal(v.windows[0].balance, 500);
  assert.equal(v.windows[0].used, undefined);
  assert.equal(quotaView({ data: {} }).windows.length, 0);
});
