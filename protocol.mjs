// SPDX-License-Identifier: AGPL-3.0-only
// Protocol adapter informed by Agent2Providers, with EchoBird MIT attribution in NOTICE.md.
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
export const ORIGIN = "https://www.doubao.com";
export const PROVIDER = "doubaowork-direct";
export const fail = (status, message) =>
  Object.assign(new Error(message), {
    status,
    ...(status === 401 ? { signIn: "expired" } : {}),
  });
const str = (v) =>
  typeof v === "string"
    ? v
    : typeof v === "number" && Number.isFinite(v)
      ? String(v)
      : "";
const plain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const clean = (v) =>
  str(v)
    .replace(/[\x00-\x1f\x7f]/g, "")
    .slice(0, 100);
const allowedMetadata = [
  "deviceId",
  "webId",
  "fingerprint",
  "userId",
  "enterpriseType",
  "name",
  "email",
  "avatar",
  "clientVersion",
  "userAgent",
  "channel",
  "chromiumVersion",
];
export function credentials(value) {
  if (!plain(value)) throw fail(401, "请重新登录豆包工作。");
  let header = value.cookieHeader,
    source = value.cookies;
  if (Array.isArray(source))
    header = source
      .filter(
        (c) =>
          ["doubao.com", "www.doubao.com"].includes(
            str(c?.domain).replace(/^\./, ""),
          ) &&
          c.path === "/" &&
          (!c.expires || c.expires < 0 || c.expires > Date.now() / 1000),
      )
      .map((c) => c.name + "=" + c.value)
      .join("; ");
  if (
    typeof header !== "string" ||
    !header ||
    header.length > 65536 ||
    /[\x00-\x1f\x7f]/.test(header)
  )
    throw fail(401, "豆包登录快照不完整，请重新登录。");
  const cookies = new Map();
  for (const p of header.split(";")) {
    const i = p.indexOf("="),
      name = p.slice(0, i).trim(),
      val = p.slice(i + 1).trim();
    if (i < 1 || !name || /[=;,\s]/.test(name) || /[;\x00-\x1f\x7f]/.test(val))
      throw fail(400, "登录快照含格式异常的 Cookie。");
    cookies.set(name, val);
  }
  if (!cookies.get("sessionid") && !cookies.get("sessionid_ss"))
    throw fail(401, "登录快照中没有有效豆包会话，请重新登录。");
  const result = {
    cookieHeader: header,
    deviceId: cookies.get("device_id") || "",
    webId: cookies.get("web_id") || "",
    fingerprint: cookies.get("s_v_web_id") || cookies.get("fp") || "",
  };
  for (const k of allowedMetadata)
    if (
      typeof value[k] === "string" &&
      value[k].length <= 1024 &&
      !/[\x00-\x1f\x7f]/.test(value[k])
    )
      result[k] = value[k];
  return result;
}
export function saveAuth(value) {
  const secret = credentials(value);
  if (!secret.userId) throw fail(401, "豆包工作尚未确认账号身份。");
  return {
    type: "success",
    access: "dwc1." + Buffer.from(JSON.stringify(secret)).toString("base64url"),
    refresh: "",
    expires: 0,
    accountId: clean(secret.name) || secret.userId,
    uid: secret.userId + ":" + (secret.enterpriseType || "0"),
  };
}
export function readAuth(auth) {
  try {
    if (
      auth?.type !== "oauth" ||
      typeof auth.access !== "string" ||
      !auth.access.startsWith("dwc1.") ||
      auth.access.length > 100000
    )
      throw Error();
    const secret = credentials(
      JSON.parse(
        Buffer.from(auth.access.slice(5), "base64url").toString("utf8"),
      ),
    );
    if (!secret.userId) throw Error();
    return secret;
  } catch {
    throw fail(401, "请先在 Magpie 登录豆包工作账号。");
  }
}
export const credentialKey = (s) =>
  createHash("sha256").update(s.cookieHeader).digest("hex");
export function endpoint(secret, path) {
  if (
    !/^\/(?:alice\/|chat\/completion$)/.test(path) ||
    path.includes("?") ||
    path.includes("#") ||
    path.includes("..")
  )
    throw fail(400, "请求路径不在豆包工作接口范围内。");
  const q = new URLSearchParams({
    aid: "1044603",
    real_aid: "1044603",
    device_platform: "web",
    version_code: "20800",
    samantha_web: "1",
    web_platform: "desktop",
    doubao_device_platform: "desktop",
    client_platform: "pc_client",
    pkg_type: "release_version",
    runtime: "web",
    runtime_version: "3.42.2",
    pc_version: secret.clientVersion || "2.33.5",
    doubao_pc_version: secret.clientVersion || "2.33.5",
    "use-olympus-account": "1",
    language: "zh",
    region: "CN",
    sys_region: "CN",
  });
  for (const [k, v] of [
    ["web_id", secret.webId],
    ["chromium_version", secret.chromiumVersion],
    ["channel", secret.channel],
    ["device_id", secret.deviceId],
    ["fp", secret.deviceId ? "verify_" + secret.deviceId : secret.fingerprint],
  ])
    if (v) q.set(k, v);
  return ORIGIN + path + "?" + q.toString();
}
export function vendorError(status, value = {}) {
  const detail = plain(value?.error_detail)
    ? value.error_detail
    : plain(value?.error)
      ? value.error
      : value;
  const code = Number(
      detail?.code ?? detail?.error_code ?? value?.code ?? value?.error_code,
    ),
    message = str(
      detail?.error_msg ||
        detail?.message ||
        detail?.msg ||
        value?.error_msg ||
        value?.message,
    ).toLowerCase();
  let decision =
    value?.extra?.decision ?? value?.decision ?? detail?.extra?.decision;
  try {
    if (typeof decision === "string" && decision.length < 65536)
      decision = JSON.parse(decision);
  } catch {
    decision = null;
  }
  const withCode = (error, reason) =>
    Object.assign(error, {
      reason,
      ...(Number.isSafeInteger(code) && code > 0 ? { upstreamCode: code } : {}),
    });
  const suffix =
    Number.isSafeInteger(code) && code > 0 ? "（上游代码 " + code + "）" : "";
  // The business code is only an envelope. Never label it CAPTCHA unless
  // the upstream explicitly says so; never echo its challenge or raw text.
  if (plain(decision) && decision.type === "verify")
    return withCode(
      fail(
        429,
        "豆包上游明确要求人工验证" +
          suffix +
          "。请重新登录本插件，在独立窗口手动完成官网验证后点击“接入 Magpie”；官方客户端可用不代表该独立会话已通过验证。",
      ),
      "verification_required",
    );
  if (
    status === 401 ||
    code === 710012001 ||
    /not logged in|login required/.test(message)
  )
    return withCode(
      fail(401, "豆包工作登录已失效，请重新登录。"),
      "session_expired",
    );
  if (status === 429 || code === 710022004)
    return withCode(
      fail(
        429,
        "豆包上游拒绝了这次请求" +
          suffix +
          "。若这个账号缺少设备标识（device_id / web_id），请重新登录本插件，让登录窗口从会话中采集后再试；否则请稍后重试。",
      ),
      "rate_limited",
    );
  return withCode(
    fail(
      status >= 400 && status <= 599 ? status : 502,
      "豆包工作请求未成功" +
        (Number.isFinite(code) && code ? "（状态 " + code + "）" : "") +
        "，请在官方页面核对。",
    ),
    "upstream_error",
  );
}
async function jsonLimited(response) {
  let text = "";
  const reader = response.body?.getReader();
  if (!reader) throw fail(502, "豆包工作未返回响应。");
  const decode = new TextDecoder("utf-8", { fatal: true });
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      text += decode.decode(r.value, { stream: true });
      if (text.length > 8 * 1024 * 1024)
        throw fail(502, "豆包工作响应超过大小限制。");
    }
    text += decode.decode();
    return JSON.parse(text);
  } catch (e) {
    await reader.cancel().catch(() => {});
    if (e.status) throw e;
    throw fail(502, "豆包工作响应格式异常。");
  } finally {
    reader.releaseLock();
  }
}
export async function deviceMetadata(home = homedir()) {
  // Read only a device identifier, never the desktop client's Cookie database.
  // The desktop build has used more than one product folder name, so try the
  // known ones in order instead of assuming a single install layout.
  const roots =
    process.platform === "win32"
      ? [
          join(
            process.env.LOCALAPPDATA || join(home, "AppData", "Local"),
            "DoubaoWork",
            "User Data",
          ),
          join(
            process.env.LOCALAPPDATA || join(home, "AppData", "Local"),
            "Doubao",
            "User Data",
          ),
        ]
      : [
          join(home, "Library", "Application Support", "DoubaoWork"),
          join(home, "Library", "Application Support", "Doubao"),
        ];
  for (const base of roots) {
    try {
      const p = join(base, "Local State");
      if ((await stat(p)).size > 8 * 1024 * 1024) continue;
      const s = JSON.parse(await readFile(p, "utf8")),
        id = str(s?.aha?.device?.device_id);
      if (/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return { deviceId: id };
    } catch {
      // Try the next known layout.
    }
  }
  return {};
}
export function parseCatalog(value) {
  const grouped = new Map();
  function add(row, mode) {
    const id = str(row?.model_item_key || row?.item_id);
    if (
      !id ||
      id.length > 160 ||
      ["__proto__", "constructor", "prototype"].includes(id)
    )
      return;
    const modeId = str(mode?.mode_id || row.default_mode);
    let extra = row.model_extra_params;
    try {
      if (typeof extra === "string") extra = JSON.parse(extra);
    } catch {
      extra = {};
    }
    const deep = Number(row.menu_type ?? row.item_id ?? id) || 0;
    const m = {
      id,
      name: clean(row.name) || id,
      extra: plain(extra) ? extra : {},
      agentMode: Number(mode?.agent_mode ?? row.agent_mode) || 0,
      modeId,
      modeName: clean(mode?.name),
      deepThink: modeId === "2" && deep === 4 ? 3 : deep,
    };
    const list = grouped.get(id) || [];
    const i = list.findIndex(
      (x) => x.modeId === m.modeId && x.agentMode === m.agentMode,
    );
    if (i < 0) list.push(m);
    else list[i] = m;
    grouped.set(id, list);
  }
  const permits = (row, m) => {
    const id = str(row.model_item_key || row.item_id);
    return (
      (!Array.isArray(row.conversation_mode_list) ||
        row.conversation_mode_list.some((x) => str(x) === str(m.mode_id))) &&
      (!Array.isArray(m.support_models) ||
        m.support_models.some(
          (x) => str(x?.model_item_key || x?.item_id || x) === id,
        ))
    );
  };
  for (const entry of value?.data?.entry_list || []) {
    const c = entry.active_switch_conf || {};
    if (c.use_menu_conf_v2 !== true) {
      for (const row of c.menu_conf?.item_list || []) add(row);
      continue;
    }
    const v = c.menu_conf_v2 || {},
      modes = v.mode_list?.item_list || [];
    for (const row of v.model_list?.item_list || []) {
      const fits = modes.filter((m) => permits(row, m)),
        m =
          fits.find((m) => str(m.mode_id) === str(row.default_mode)) ||
          fits.find(
            (m) =>
              str(m.mode_id) ===
              str(v.default_select_mode_map?.new_chat?.mode_id),
          ) ||
          fits.find((m) => Number(m.agent_mode) === 2) ||
          fits[0];
      if (modes.length && !m) continue;
      add(row, m);
    }
    for (const m of modes)
      for (const row of m.model_list?.item_list || []) add(row, m);
  }
  const result = {};
  for (const [id, variants] of grouped)
    for (const m of variants) {
      const key =
        variants.length > 1
          ? encodeURIComponent(m.modeId || "agent-" + m.agentMode) +
            "::" +
            encodeURIComponent(id)
          : id;
      result[key] = {
        ...m,
        name:
          m.name +
          (variants.length > 1 ? " · " + (m.modeName || m.modeId) : ""),
      };
    }
  return result;
}
export function quotaView(value, entry = {}) {
  const d = value?.data || value || {},
    windows = [];
  const limits = (s) =>
    (s?.window_limit_groups || []).flatMap((g) =>
      (g.window_limits || []).map((l) => ({ g, l })),
    );
  const usable = (s) =>
    s?.usage_exhausted !== true &&
    limits(s).some(({ l }) => [1, 2, 4].includes(Number(l.window_type)));
  const personal = d.member_info?.hasActiveSubscription === true,
    enterprise =
      d.member_info?.hasEnterpriseSubscription === true &&
      (!personal ||
        usable(d.enterprise_window_limit_section) ||
        !usable(d.window_limit_section));
  const section = enterprise
    ? d.enterprise_window_limit_section
    : personal
      ? d.window_limit_section
      : null;
  const num = (v) =>
    v !== undefined &&
    v !== null &&
    v !== "" &&
    Number.isFinite(Number(v)) &&
    Number(v) >= 0
      ? Number(v)
      : undefined;
  for (const { g, l } of [
    ...limits(section).filter(({ l }) =>
      [1, 2, 4].includes(Number(l.window_type)),
    ),
    ...(!enterprise
      ? limits(d.quota_package_section).filter(
          ({ l }) => Number(l.window_type) === 3,
        )
      : []),
  ]) {
    const type = Number(l.window_type),
      name =
        clean(g.feature_group_name) +
        " " +
        ({ 1: "5 小时", 2: "近 7 天", 4: "每月" }[type] || "订阅额度"),
      unlimited =
        l.unlimited === true || (type === 1 && l.exemption?.active === true),
      used = num(l.used_percent),
      amount = num(l.used_amount),
      limit = num(l.total_amount),
      reset = num(unlimited ? l.exemption?.end_time : l.end_time);
    windows.push({
      name: name.trim(),
      ...(unlimited
        ? { display: "不限", aside: true }
        : used !== undefined
          ? { used }
          : amount !== undefined && limit !== undefined
            ? { amount, limit, unit: "额度" }
            : { display: "额度未返回" }),
      ...(reset ? { resetsAt: reset } : {}),
      ...(type === 1 ? { span: 18000 } : type === 2 ? { span: 604800 } : {}),
    });
  }
  if (!enterprise) {
    const bonus = limits(d.incentive_quota_section).find(
      ({ l }) => Number(l.window_type) === 3,
    )?.l;
    if (bonus) {
      const total = num(bonus.total_amount),
        used = num(bonus.used_amount),
        balance =
          total !== undefined && used !== undefined
            ? Math.max(0, total - used)
            : undefined;
      windows.push({
        name: "奖励额度",
        ...(balance !== undefined
          ? { balance, display: "剩 " + balance + " 额度" }
          : { display: "余额未返回" }),
        ...(num(bonus.end_time) ? { runsOutAt: num(bonus.end_time) } : {}),
      });
    }
  }
  const plan =
    entry?.data?.membership_display_name ||
    entry?.data?.current_subscription?.display?.short_name ||
    d.membership_display_name ||
    d.current_subscription?.display?.short_name ||
    "";
  return { ...(plan ? { plan: clean(plan) } : {}), windows };
}
export function createApi({ fetchImpl = fetch } = {}) {
  const cache = new Map(),
    pending = new Map();
  const headers = (s) =>
    new Headers({
      Cookie: s.cookieHeader,
      Origin: ORIGIN,
      Referer: ORIGIN + "/chat/",
      "User-Agent":
        s.userAgent ||
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
      "Agw-Js-Conv": "str",
      "Content-Type": "application/json",
    });
  async function request(s, path, body, { signal, stream = false } = {}) {
    let response;
    try {
      response = await fetchImpl(endpoint(s, path), {
        method: "POST",
        redirect: "error",
        headers: headers(s),
        body: JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([
              signal,
              AbortSignal.timeout(stream ? 10 * 60_000 : 25000),
            ])
          : AbortSignal.timeout(stream ? 10 * 60_000 : 25000),
      });
    } catch (e) {
      if (signal?.aborted) throw fail(499, "请求已取消。");
      throw fail(502, "豆包工作网络请求未完成，请检查连接后再试。");
    }
    if (
      stream &&
      response.ok &&
      response.headers.get("content-type")?.startsWith("text/event-stream")
    )
      return response;
    let value;
    try {
      value = await jsonLimited(response);
    } catch (error) {
      if ([401, 429].includes(response.status))
        throw vendorError(response.status);
      throw error;
    }
    if (!response.ok || Number(value.code ?? value.error_code ?? 0) !== 0)
      throw vendorError(response.status, value);
    if (stream) throw vendorError(response.status, value);
    return value;
  }
  return {
    post: request,
    async identify(s, { signal } = {}) {
      const u = new URL(ORIGIN + "/passport/account/info/v2/");
      for (const [k, v] of Object.entries({
        account_sdk_source: "web",
        sdk_version: "2.2.5",
        aid: "582478",
        real_aid: "582478",
        device_platform: "web",
        samantha_web: "1",
        "use-olympus-account": "1",
      }))
        u.searchParams.set(k, v);
      let response;
      try {
        response = await fetchImpl(u.href, {
          redirect: "error",
          headers: headers(s),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(25000)])
            : AbortSignal.timeout(25000),
        });
      } catch {
        throw fail(
          signal?.aborted ? 499 : 502,
          "账号身份核验未完成，请检查连接。",
        );
      }
      const value = await jsonLimited(response);
      if (
        !response.ok ||
        (value.message && value.message !== "success") ||
        Number(value.error_code ?? 0) !== 0
      )
        throw vendorError(
          response.status === 200 ? 401 : response.status,
          value,
        );
      const d = value.data || value,
        userId = str(d.user_id_str);
      if (!userId) throw fail(401, "豆包工作未确认账号身份，请重新登录。");
      return {
        ...s,
        userId,
        enterpriseType: str(d.passport_enterprise_user_type) || "0",
        name: clean(d.name) || userId,
        email: clean(d.email),
        avatar: str(d.avatar_url),
      };
    },
    async catalog(s, { signal, force = false } = {}) {
      const key = credentialKey(s),
        old = cache.get(key);
      if (!force && old && Date.now() - old.at < 300000) return old;
      if (pending.has(key)) return pending.get(key);
      const task = (async () => {
        const launch = await request(s, "/alice/user/launch", {}, { signal }),
          bot = str(launch.data?.assistant_bot_id || launch.assistant_bot_id);
        if (!bot) throw fail(502, "豆包工作未返回助手信息。");
        const raw = await request(
            s,
            "/alice/slot/action_bar_v3/brief_list",
            { language_code: "zh", bot_id: bot },
            { signal },
          ),
          models = parseCatalog(raw);
        if (!Object.keys(models).length)
          throw fail(502, "豆包工作模型目录为空或已变化，请稍后刷新。");
        const catalog = { bot, models, at: Date.now() };
        if (cache.size >= 64) cache.delete(cache.keys().next().value);
        cache.set(key, catalog);
        return catalog;
      })();
      pending.set(key, task);
      try {
        return await task;
      } finally {
        pending.delete(key);
      }
    },
    async usage(s, { signal } = {}) {
      const overview = await request(
        s,
        "/alice/commerce/sale/subscription/overview/",
        { product_line: "membership" },
        { signal },
      );
      let entry = {};
      try {
        entry = await request(
          s,
          "/alice/commerce/sale/subscription/entry/config/",
          {},
          { signal },
        );
      } catch (e) {
        if (e.signIn) throw e;
      }
      return { ...quotaView(overview, entry), user: s.name || s.userId };
    },
  };
}
