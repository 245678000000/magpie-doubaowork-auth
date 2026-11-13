import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeEvents } from "../stream.mjs";
const event = (name, v) =>
  "event: " + name + "\ndata: " + JSON.stringify(v) + "\n\n";
const block = (text) => ({
  block_id: "b",
  block_type: 10000,
  content: { text_block: { text } },
});
function response(text) {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new Response(
    new ReadableStream({
      pull(c) {
        if (i === bytes.length) c.close();
        else c.enqueue(bytes.slice(i, (i += Math.min(3, bytes.length - i))));
      },
    }),
  );
}
test("分片中文 SSE、增量与快照去重，结束标记必须真实存在", async () => {
  const raw =
    event("STREAM_MSG_NOTIFY", {
      content: { content_block: [block("你好")] },
    }) +
    event("FULL_MSG_NOTIFY", {
      message: { user_type: 2, content_block: [block("你好世界")] },
    }) +
    event("SSE_REPLY_END", {});
  const values = [];
  for await (const d of decodeEvents(response(raw))) values.push(d);
  assert.deepEqual(values, [{ content: "你好" }, { content: "世界" }]);
  await assert.rejects(async () => {
    for await (const _ of decodeEvents(
      response(event("CHUNK_DELTA", { text: "partial" })),
    )) {
    }
  }, /结束/);
});
test("首帧人机验证归类 429，不把业务错误当成功正文", async () => {
  await assert.rejects(
    async () => {
      for await (const _ of decodeEvents(
        response(
          event("STREAM_ERROR", {
            error_code: 710022004,
            error_msg: "SENSITIVE_PAYLOAD",
          }),
        ),
      )) {
      }
    },
    (e) => e.status === 429 && !e.message.includes("SENSITIVE_PAYLOAD"),
  );
});
test("思考与正文分开；修订已输出文本时停止，不拼接伪造结果", async () => {
  const thinking = {
    ...block("思考"),
    block_id: "r",
    content: { text_block: { text: "思考", icon_url: "deep_think" } },
  };
  const raw =
    event("STREAM_MSG_NOTIFY", {
      content: { content_block: [thinking, block("答复")] },
    }) +
    event("FULL_MSG_NOTIFY", {
      message: { user_type: 2, content_block: [block("另一份")] },
    });
  const got = [];
  await assert.rejects(async () => {
    for await (const d of decodeEvents(response(raw))) got.push(d);
  }, /修订/);
  assert.deepEqual(got, [{ reasoning_content: "思考" }, { content: "答复" }]);
});
