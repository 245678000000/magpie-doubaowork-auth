// SPDX-License-Identifier: AGPL-3.0-only
import { join } from "node:path";
import { homedir } from "node:os";
import { createApi, readAuth, PROVIDER, ORIGIN, fail } from "./protocol.mjs";
import { createCompletion } from "./completion.mjs";
import { createLoginManager } from "./login.mjs";
import { createCheckin } from "./checkin.mjs";
function errorResponse(error) {
  const status = Number(error?.status) || 502;
  const reason = [
    "verification_required",
    "rate_limited",
    "session_expired",
    "upstream_error",
  ].includes(error?.reason)
    ? error.reason
    : null;
  return new Response(
    JSON.stringify({
      error: {
        message: error?.status
          ? error.message
          : "豆包工作插件请求未完成，请检查连接或重新登录。",
        type: status === 401 ? "authentication_error" : "provider_error",
        code:
          reason || (status === 401 ? "session_expired" : "doubaowork_error"),
        ...(Number.isSafeInteger(error?.upstreamCode) && error.upstreamCode > 0
          ? { upstream_code: error.upstreamCode }
          : {}),
      },
    }),
    {
      status: status >= 400 && status <= 599 ? status : 502,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...(error?.signIn === "expired"
          ? { "X-Magpie-Sign-In": "expired" }
          : {}),
      },
    },
  );
}
function modelsView(
  catalog,
  { contextLimit = 32768, outputLimit = 4096, promptTools = true } = {},
) {
  const positive = (n, fallback, max) =>
    Number.isInteger(n) && n > 0 && n <= max ? n : fallback;
  return Object.fromEntries(
    Object.entries(catalog.models).map(([id, m]) => {
      const context = positive(
          Number(m.extra?.context_window ?? m.extra?.max_input_tokens),
          positive(contextLimit, 32768, 2000000),
          2000000,
        ),
        output = positive(outputLimit, 4096, 128000);
      return [
        id,
        {
          id,
          name: m.name,
          npm: "@ai-sdk/openai-compatible",
          api: {
            id,
            url: ORIGIN + "/magpie/v1",
            npm: "@ai-sdk/openai-compatible",
          },
          limit: { context, output: Math.min(output, context) },
          reasoning: m.deepThink !== 0 || !!m.modeId,
          tool_call: promptTools,
          toolCallEmulated: promptTools,
          modalities: { input: ["text"], output: ["text"] },
          capabilities: {
            reasoning: m.deepThink !== 0 || !!m.modeId,
            toolcall: promptTools,
            attachment: false,
            input: {
              text: true,
              image: false,
              audio: false,
              video: false,
              pdf: false,
            },
            output: {
              text: true,
              image: false,
              audio: false,
              video: false,
              pdf: false,
            },
          },
        },
      ];
    }),
  );
}
function createHooks(input = {}, options = {}, dependencies = {}) {
  const api = dependencies.api || createApi(),
    root = join(
      input.directory ||
        join(
          process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
          "magpie",
        ),
      PROVIDER,
    );
  const flag = (key, fallback) => {
    const value = input.magpie?.option?.(PROVIDER, key);
    return typeof value === "boolean" ? value : fallback;
  };
  const promptTools = () => flag("prompt_tools", options.promptTools !== false);
  const login = dependencies.login || createLoginManager({ root, api }),
    checkin =
      dependencies.checkin ||
      createCheckin({ root: join(root, "checkins"), api });
  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: "豆包工作 · 独立版",
        npm: "@ai-sdk/openai-compatible",
        api: ORIGIN + "/magpie/v1",
        models: {},
      };
    },
    auth: {
      provider: PROVIDER,
      maxConcurrency: 1,
      options: [
        {
          key: "prompt_tools",
          label: "实验性客户端工具桥",
          description:
            "将客户端工具声明随文本发给豆包，并解析返回的调用；这不是上游原生函数调用。插件本身不执行工具。",
          default: true,
        },
        {
          key: "checkin_enabled",
          label: "允许每日签到",
          description:
            "默认关闭。开启后仍需在 Magpie 每日签到中选中该账号；未知领取结果只回查，不重复提交。",
          confirm:
            "开启后，Magpie 每日签到可为你选中的豆包工作账号提交领取请求。",
          default: false,
        },
      ],
      methods: [
        {
          type: "oauth",
          label: "独立浏览器登录豆包工作",
          async authorize(_inputs, { signal } = {}) {
            return login.start({
              signal,
              browserId: ["chrome", "edge"].includes(options.browser)
                ? options.browser
                : undefined,
            });
          },
        },
      ],
      async loader(getAuth) {
        readAuth(await getAuth());
        return {
          baseURL: ORIGIN + "/magpie/v1",
          apiKey: "MAGPIE_DOUBAO_PLUGIN_INTERNAL",
          async fetch(input, init = {}) {
            try {
              const u = new URL(
                typeof input === "string" || input instanceof URL
                  ? input
                  : input.url,
              );
              if (
                u.pathname !== "/magpie/v1/chat/completions" ||
                u.origin !== ORIGIN
              )
                throw fail(400, "本插件只接收 Chat Completions 请求。");
              if (init.method && init.method.toUpperCase() !== "POST")
                throw fail(405, "请使用 POST 请求。");
              const raw = init.body;
              if (typeof raw !== "string" && !(raw instanceof Uint8Array))
                throw fail(400, "请求正文需要 JSON。");
              if (Buffer.byteLength(raw) > 2 * 1024 * 1024)
                throw fail(413, "请求正文超过大小限制。");
              let body;
              try {
                body = JSON.parse(
                  typeof raw === "string" ? raw : new TextDecoder().decode(raw),
                );
              } catch {
                throw fail(400, "请求正文 JSON 格式不正确。");
              }
              if (!body || typeof body !== "object" || Array.isArray(body))
                throw fail(400, "请求正文格式不正确。");
              const secret = readAuth(await getAuth());
              return await createCompletion(api, secret, body, {
                signal: init.signal,
                promptTools: promptTools(),
              });
            } catch (e) {
              return errorResponse(e);
            }
          },
        };
      },
      async usage(getAuth) {
        try {
          return await api.usage(readAuth(await getAuth()));
        } catch (e) {
          if (e.signIn) throw e;
          return {
            error: e.status ? e.message : "额度查询未完成，请稍后刷新。",
            windows: [],
          };
        }
      },
      async checkin(getAuth) {
        if (!flag("checkin_enabled", options.checkinEnabled === true))
          return {
            outcome: "inactive",
            message:
              "豆包工作插件签到默认关闭；开启插件选项并选择 Magpie 每日签到后生效。",
          };
        return checkin.run(readAuth(await getAuth()));
      },
    },
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (auth?.type !== "oauth") return provider.models || {};
        try {
          return modelsView(await api.catalog(readAuth(auth)), {
            promptTools: promptTools(),
            contextLimit: options.contextLimit,
            outputLimit: options.outputLimit,
          });
        } catch (e) {
          if (e.signIn) throw e;
          return provider.models || {};
        }
      },
    },
  };
}
export default async function DoubaoWorkPlugin(input, options) {
  return createHooks(input, options);
}
export const _internal = { createHooks, modelsView, errorResponse };
