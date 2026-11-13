// SPDX-License-Identifier: AGPL-3.0-only
import { fail, vendorError } from "./protocol.mjs";
const MAX_EVENT = 2 * 1024 * 1024,
  MAX_OUTPUT = 16 * 1024 * 1024;
class Decoder {
  constructor() {
    this.done = false;
    this.blocks = new Map();
    this.thinking = new Set();
    this.size = 0;
  }
  blocksOf(rows, append) {
    const out = [];
    for (const b of Array.isArray(rows) ? rows : []) {
      if (Number(b?.block_type) !== 10000) continue;
      const t = b?.content?.text_block;
      if (typeof t?.text !== "string") continue;
      const id = String(b.block_id || "default"),
        tagged = [t.icon_url, t.icon_url_dark].some(
          (s) =>
            typeof s === "string" && s.toLowerCase().includes("deep_think"),
        );
      if (tagged) this.thinking.add(id);
      else if (
        Object.hasOwn(t, "icon_url") ||
        Object.hasOwn(t, "icon_url_dark")
      )
        this.thinking.delete(id);
      const reasoning = tagged || this.thinking.has(id),
        key = (reasoning ? "r:" : "t:") + id,
        prior = this.blocks.get(key) || "";
      let delta = t.text;
      if (!append) {
        if (!delta.startsWith(prior))
          throw fail(502, "豆包工作修订了已输出的内容，请重新核对本次回答。");
        delta = delta.slice(prior.length);
      }
      this.blocks.set(key, append ? prior + t.text : t.text);
      this.size += delta.length;
      if (this.size > MAX_OUTPUT) throw fail(502, "豆包工作输出超过大小限制。");
      if (delta)
        out.push({ [reasoning ? "reasoning_content" : "content"]: delta });
    }
    return out;
  }
  frame(event, raw) {
    if (this.done) return [];
    let v;
    try {
      v = JSON.parse(raw);
    } catch {
      throw fail(502, "豆包工作流式事件格式异常。");
    }
    if (
      /ERR|^error$|^gateway-error$/.test(event) ||
      (v?.error && v.error !== false) ||
      Number(v?.code ?? v?.error_code ?? 0) !== 0
    )
      throw vendorError(200, v);
    if (event === "SSE_REPLY_END") {
      this.done = true;
      return [];
    }
    if (event === "STREAM_MSG_NOTIFY")
      return this.blocksOf(v?.content?.content_block, true);
    if (event === "FULL_MSG_NOTIFY" && Number(v?.message?.user_type) === 2)
      return this.blocksOf(v.message.content_block, false);
    if (event === "CHUNK_DELTA" && typeof v?.text === "string")
      return this.blocksOf(
        [
          {
            block_id: "delta",
            block_type: 10000,
            content: { text_block: { text: v.text } },
          },
        ],
        true,
      );
    if (event === "STREAM_CHUNK") {
      const result = [];
      for (const p of v?.patch_op || [])
        if (Number(p.patch_object) === 1)
          result.push(
            ...this.blocksOf(
              p.patch_value?.content_block,
              Number(p.patch_type) === 1,
            ),
          );
      return result;
    }
    return [];
  }
}
export async function* decodeEvents(response, { signal, idleMs = 60000 } = {}) {
  const reader = response.body?.getReader();
  if (!reader) throw fail(502, "豆包工作没有返回流式响应。");
  const text = new TextDecoder("utf-8", { fatal: true }),
    decoder = new Decoder();
  let buffer = "",
    bytes = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (!decoder.done) {
      if (signal?.aborted) throw fail(499, "请求已取消。");
      let timer;
      const packet = await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(fail(504, "豆包工作流式响应等待超时。")),
            idleMs,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      if (packet.done) {
        if (signal?.aborted) throw fail(499, "请求已取消。");
        throw fail(502, "豆包工作在正式结束标记之前断开了响应。");
      }
      bytes += packet.value.byteLength;
      if (bytes > MAX_OUTPUT * 4) throw fail(502, "豆包工作响应超过大小限制。");
      try {
        buffer += text.decode(packet.value, { stream: true });
      } catch {
        throw fail(502, "豆包工作返回了异常编码。");
      }
      for (;;) {
        const m = /\r?\n\r?\n/.exec(buffer);
        if (!m) break;
        const block = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        if (block.length > MAX_EVENT)
          throw fail(502, "豆包工作流式事件超过大小限制。");
        let event = "",
          data = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trimStart();
          else if (line.startsWith("data:"))
            data.push(line.slice(5).replace(/^ /, ""));
        }
        if (data.length)
          for (const delta of decoder.frame(event, data.join("\n")))
            yield delta;
        if (decoder.done) break;
      }
      if (buffer.length > MAX_EVENT)
        throw fail(502, "豆包工作流式事件超过大小限制。");
    }
  } catch (e) {
    if (e.status) throw e;
    throw fail(
      signal?.aborted ? 499 : 502,
      signal?.aborted ? "请求已取消。" : "豆包工作流式连接已中断。",
    );
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
