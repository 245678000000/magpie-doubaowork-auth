// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { fail } from "./protocol.mjs";
import { decodeEvents } from "./stream.mjs";
export function buildRequest(bot, model, body, { promptTools = true } = {}) {
  if (
    !body ||
    !Array.isArray(body.messages) ||
    !body.messages.length ||
    body.messages.length > 1000 ||
    Buffer.byteLength(JSON.stringify(body)) > 2 * 1024 * 1024
  )
    throw fail(400, "请提供大小适中的 messages 对话。");
  if (body.response_format && body.response_format.type !== "text")
    throw fail(400, "本版仅支持 text 输出格式，尚无原生 JSON Schema 输出约束。");
  const history = body.messages.map((m) => {
    if (
      !m ||
      !["system", "developer", "assistant", "user", "tool"].includes(m.role)
    )
      throw fail(400, "消息角色格式不正确。");
    let content = m.content;
    if (Array.isArray(content)) {
      if (content.some((p) => p?.type !== "text" || typeof p.text !== "string"))
        throw fail(400, "本版豆包工作插件只接收文本内容。");
      content = content.map((p) => p.text).join("\n");
    } else if (
      content !== null &&
      content !== undefined &&
      typeof content !== "string"
    )
      throw fail(400, "消息正文格式不正确。");
    return {
      role: m.role,
      content: content ?? null,
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.name ? { name: m.name } : {}),
    };
  });
  const tools = body.tools ?? [];
  if (!Array.isArray(tools) || tools.length > 128)
    throw fail(400, "工具定义格式不正确。");
  const names = new Set();
  for (const t of tools) {
    const name = t?.function?.name;
    if (
      t?.type !== "function" ||
      typeof name !== "string" ||
      !name ||
      names.has(name)
    )
      throw fail(400, "工具需要唯一的 function.name。");
    names.add(name);
  }
  const choice = body.tool_choice ?? "auto";
  let forced = false;
  if (choice === "none") names.clear();
  else if (choice === "required") {
    if (!names.size) throw fail(400, "required 需要至少一个已声明工具。");
    forced = true;
  } else if (typeof choice === "object") {
    const name = choice?.function?.name;
    if (choice.type !== "function" || !names.has(name))
      throw fail(400, "请选择已声明的 function 工具。");
    names.clear();
    names.add(name);
    forced = true;
  } else if (choice !== "auto") throw fail(400, "tool_choice 格式不正确。");
  if (names.size && !promptTools)
    throw fail(400, "请先开启本插件的实验性提示词工具桥，或使用纯文本请求。");
  const marker = "magpie_doubaowork_tools_" + randomUUID().replaceAll("-", "");
  const bridge = {
    marker,
    active: names.size > 0,
    message(text) {
      const trimmed = text
        .trim()
        .replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/, "$1");
      let v;
      try {
        v = JSON.parse(trimmed);
      } catch {}
      if (v && Object.hasOwn(v, marker)) {
        const calls = v[marker];
        if (
          !Array.isArray(calls) ||
          !calls.length ||
          calls.length > 20 ||
          (body.parallel_tool_calls === false && calls.length > 1)
        )
          throw fail(502, "豆包工作返回的工具调用格式不符合约定。");
        return {
          role: "assistant",
          content: null,
          tool_calls: calls.map((c) => {
            if (
              !names.has(c?.name) ||
              !c.arguments ||
              typeof c.arguments !== "object" ||
              Array.isArray(c.arguments)
            )
              throw fail(502, "豆包工作返回了未声明的工具或异常参数。");
            return {
              id: "call_" + randomUUID().replaceAll("-", ""),
              type: "function",
              function: {
                name: c.name,
                arguments: JSON.stringify(c.arguments),
              },
            };
          }),
        };
      }
      if (text.includes(marker) || forced)
        throw fail(502, "豆包工作尚未返回完整的客户端工具调用。");
      return { role: "assistant", content: text };
    },
  };
  const instruction = bridge.active
    ? `The following JSON is the complete client conversation, preserving roles and tool results. Client tools are described here: ${JSON.stringify(tools)}. Do not execute substitute desktop or cloud tools. To request client tools, return only a JSON object with key ${JSON.stringify(marker)} and an array of {"name":"declared name","arguments":{...}}. Allowed names: ${JSON.stringify([...names])}. Tool use is ${forced ? "required" : "optional"}. Parallel calls are ${body.parallel_tool_calls === false ? "disabled" : "allowed"}. Otherwise answer in text.\n`
    : "";
  const prompt = instruction + JSON.stringify(history),
    id = randomUUID(),
    now = Date.now();
  const payload = {
    client_meta: {
      local_conversation_id:
        "local_" +
        Array.from(
          randomUUID().replaceAll("-", "").slice(0, 16),
          (c) => parseInt(c, 16) % 10,
        ).join(""),
      conversation_id: "",
      bot_id: bot,
      last_section_id: "",
      last_message_index: null,
    },
    messages: [
      {
        local_message_id: id,
        content_block: [
          {
            block_type: 10000,
            content: {
              text_block: {
                text: prompt,
                icon_url: "",
                icon_url_dark: "",
                summary: "",
              },
              pc_event_block: "",
            },
            block_id: randomUUID(),
            parent_id: "",
            meta_info: [],
            append_fields: [],
          },
        ],
        message_status: 0,
      },
    ],
    option: {
      create_time_ms: now,
      need_create_conversation: true,
      conversation_init_option: { need_ack_conversation: true },
      need_deep_think: model.deepThink,
      is_audio: false,
      answer_with_suggest: false,
      tts_switch: false,
      is_regen: false,
      is_replace: false,
      unique_key: randomUUID(),
      start_seq: 0,
      sse_recv_event_options: { support_chunk_delta: true },
      recovery_option: {
        is_recovery: false,
        req_create_time_sec: Math.floor(now / 1000),
        append_sse_event_scene: 0,
      },
      message_storage_type: 0,
    },
    user_context: [],
    ext: {
      use_deep_think: String(model.deepThink),
      sub_conv_firstmet_type: "1",
      commerce_credit_config_enable: "0",
    },
  };
  if (model.agentMode || model.modeId) {
    const aggregate = {
        mode_id: model.modeId || "3",
        model_item_key: model.id,
        agent_mode: String(model.agentMode),
      },
      config = { model_item_key: model.id, model_extra_params: model.extra };
    if (model.extra?.provider_id)
      aggregate.provider_id = model.extra.provider_id;
    if (body.reasoning_effort) {
      const effort = { low: 3, medium: 4, high: 5, xhigh: 6, max: 7 }[
        body.reasoning_effort
      ];
      if (!effort) throw fail(400, "思考档位不在该插件支持范围内。");
      config.reasoning_effort = effort;
      aggregate.reasoning_effort = String(effort);
    }
    Object.assign(payload.option, {
      agent_mode: model.agentMode,
      model_config: config,
      aggregate_params: aggregate,
    });
    payload.ext.agent_mode = String(model.agentMode);
    if ([1, 2].includes(model.agentMode)) {
      const task = {
        action: 0,
        thread_local_message_id: [id],
        client_option: {
          enable_sandbox: false,
          os:
            process.platform === "darwin"
              ? "macos"
              : process.platform === "win32"
                ? "windows"
                : "linux",
          shared_folder_path: [],
        },
        runtime_type: 2,
        agent_task_param: { runtime_type: 2 },
        agent_task_param_change: {
          runtime_changed: true,
          device_changed: false,
          sandbox_auth_type_changed: false,
        },
        need_modify_conversation: false,
        task_input_json: '{"project_context":{}}',
      };
      payload.option.general_task_param = task;
      payload.ext.general_task_param = JSON.stringify(task);
      payload.ext.is_finish = "1";
    }
  } else if (body.reasoning_effort)
    throw fail(400, "该豆包模式没有思考档位选择。");
  return { payload, bridge };
}
const jsonResponse = (v) =>
  new Response(JSON.stringify(v), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
export async function createCompletion(
  api,
  secret,
  body,
  { signal, promptTools = true, idleMs } = {},
) {
  const catalog = await api.catalog(secret, { signal }),
    model = catalog.models[body.model];
  if (!model)
    throw fail(404, "该账号当前模型目录没有这个模型，请刷新目录后重选。");
  const { payload, bridge } = buildRequest(catalog.bot, model, body, {
    promptTools,
  });
  const controller = new AbortController(),
    combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
  const response = await api.post(secret, "/chat/completion", payload, {
      signal: combined,
      stream: true,
    }),
    iterator = decodeEvents(response, { signal: combined, idleMs })[
      Symbol.asyncIterator
    ]();
  const id = "chatcmpl_" + randomUUID().replaceAll("-", ""),
    created = Math.floor(Date.now() / 1000),
    base = { id, created, model: body.model };
  const chunk = (delta, finish_reason = null) =>
    "data: " +
    JSON.stringify({
      ...base,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason }],
    }) +
    "\n\n";
  if (body.stream === false || bridge.active) {
    let text = "",
      reasoning = "";
    for (;;) {
      const r = await iterator.next();
      if (r.done) break;
      text += r.value.content || "";
      reasoning += r.value.reasoning_content || "";
    }
    if (!text) throw fail(502, "豆包工作结束了请求，但没有返回文本回答。");
    const message = bridge.active
      ? bridge.message(text)
      : { role: "assistant", content: text };
    if (reasoning) message.reasoning_content = reasoning;
    const reason = message.tool_calls ? "tool_calls" : "stop";
    if (body.stream === false)
      return jsonResponse({
        ...base,
        object: "chat.completion",
        choices: [{ index: 0, message, finish_reason: reason }],
      });
    const delta = { ...message };
    if (delta.tool_calls)
      delta.tool_calls = delta.tool_calls.map((c, index) => ({ ...c, index }));
    return new Response(chunk(delta) + chunk({}, reason) + "data: [DONE]\n\n", {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      },
    });
  }
  const first = await iterator.next();
  if (first.done) throw fail(502, "豆包工作没有返回文本回答。");
  let initial = first,
    started = false,
    hasText = false;
  return new Response(
    new ReadableStream({
      async pull(c) {
        try {
          const next = initial || (await iterator.next());
          initial = null;
          if (next.done) {
            if (!hasText) throw fail(502, "豆包工作没有返回回答正文。");
            c.enqueue(
              new TextEncoder().encode(chunk({}, "stop") + "data: [DONE]\n\n"),
            );
            c.close();
            return;
          }
          const delta = { ...next.value };
          if (!started) {
            delta.role = "assistant";
            started = true;
          }
          if (delta.content) hasText = true;
          c.enqueue(new TextEncoder().encode(chunk(delta)));
        } catch (e) {
          controller.abort();
          c.error(e);
        }
      },
      async cancel() {
        controller.abort();
        await iterator.return?.();
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      },
    },
  );
}
