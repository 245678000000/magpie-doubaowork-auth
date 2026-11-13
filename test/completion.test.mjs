import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRequest, createCompletion } from "../completion.mjs";
const model = {
  id: "flash",
  name: "Flash",
  agentMode: 2,
  modeId: "3",
  deepThink: 4,
  extra: { provider_id: "vendor" },
};
const body = {
  model: "flash",
  messages: [
    { role: "system", content: "fixture system" },
    { role: "user", content: "OK" },
  ],
  stream: true,
};
const frame = (name, v) => `event: ${name}\ndata: ${JSON.stringify(v)}\n\n`;
test("请求保留完整角色历史，每次新会话；只使用云运行环境，不挂本机目录", () => {
  const { payload } = buildRequest("BOT", model, body);
  assert.equal(payload.client_meta.bot_id, "BOT");
  assert.equal(payload.option.model_config.model_item_key, "flash");
  assert.equal(payload.option.general_task_param.runtime_type, 2);
  assert.deepEqual(
    payload.option.general_task_param.client_option.shared_folder_path,
    [],
  );
  const text = payload.messages[0].content_block[0].content.text_block.text;
  assert(text.includes("fixture system"));
  assert(text.includes("system"));
  assert.notEqual(
    payload.client_meta.local_conversation_id,
    buildRequest("BOT", model, body).payload.client_meta.local_conversation_id,
  );
  assert.throws(
    () =>
      buildRequest("BOT", model, {
        ...body,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: "https://example.test/img" },
              },
            ],
          },
        ],
      }),
    (e) => e.status === 400,
  );
});
test("SSE 与非流式回复均等到真实结束；截断流不发送 DONE", async () => {
  const api = {
    catalog: async () => ({ bot: "BOT", models: { flash: model } }),
    post: async () =>
      new Response(
        frame("CHUNK_DELTA", { text: "OK" }) + frame("SSE_REPLY_END", {}),
        { headers: { "content-type": "text/event-stream" } },
      ),
  };
  const r = await createCompletion(api, {}, body);
  assert.equal(r.status, 200);
  const text = await r.text();
  assert(text.includes("OK"));
  assert(text.includes("[DONE]"));
  const single = await (
    await createCompletion(api, {}, { ...body, stream: false })
  ).json();
  assert.equal(single.choices[0].message.content, "OK");
  assert.equal(single.choices[0].finish_reason, "stop");
  assert.equal(single.usage, undefined);
  api.post = async () =>
    new Response(frame("CHUNK_DELTA", { text: "partial" }));
  const truncated = await createCompletion(api, {}, body);
  await assert.rejects(truncated.text());
});
test("提示词工具桥只返回已声明工具，未执行任何客户端工具", () => {
  const r = buildRequest("BOT", model, {
    ...body,
    tools: [
      {
        type: "function",
        function: { name: "fixture_tool", parameters: { type: "object" } },
      },
    ],
    tool_choice: "required",
  });
  const answer = r.bridge.message(
    JSON.stringify({
      [r.bridge.marker]: [{ name: "fixture_tool", arguments: { x: 1 } }],
    }),
  );
  assert.equal(answer.tool_calls[0].function.name, "fixture_tool");
  assert.throws(
    () =>
      r.bridge.message(
        JSON.stringify({
          [r.bridge.marker]: [{ name: "other", arguments: {} }],
        }),
      ),
    (e) => e.status === 502,
  );
  assert.throws(
    () => r.bridge.message("plain text"),
    (e) => e.status === 502,
  );
});
