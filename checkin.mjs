// SPDX-License-Identifier: AGPL-3.0-only
import { readFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fail } from "./protocol.mjs";
// 活动组常量：网页会话的 launch 经常下发空串，此时用它在服务端再试一次。
export const FALLBACK_GROUP = "pc_incentive_task_mvp_v3";
const day = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
export function dailyTasks(value, group) {
  const rows = [],
    seen = new Set();
  function collect(v, g, depth) {
    if (depth > 8 || !v || typeof v !== "object") return;
    g = v.campaign_group_code || v.campaign_code || g;
    for (const key of ["tasks", "campaigns", "milestones"])
      for (const r of v[key] || []) {
        if (
          typeof r?.campaign_code !== "string" ||
          typeof r.daily_checkin?.checked_in_today !== "boolean"
        )
          continue;
        const own = r.campaign_group_code || g,
          id = own + ":" + r.campaign_code;
        if (seen.has(id)) continue;
        seen.add(id);
        const status = Number(r.task_status),
          direct = Number(r.reward_mode) === 2 || key === "milestones",
          claimable = status === 2 || (direct && [1, 4].includes(status)),
          body = claimable
            ? direct
              ? {
                  task_id: "",
                  campaign_group_code: own,
                  campaign_item_code: r.campaign_code,
                }
              : r.task_id
                ? { task_id: r.task_id }
                : null
            : null;
        rows.push({
          key: r.campaign_code,
          group: own,
          checked: r.daily_checkin.checked_in_today,
          body,
          credit: Number(r.daily_checkin.reward?.reward_amount) || undefined,
          streak: Number(r.daily_checkin.continuous_days) || undefined,
        });
      }
    collect(v.campaign_group, g, depth + 1);
    for (const c of v.campaign_groups || []) collect(c, g, depth + 1);
  }
  collect(value?.data || value, group, 0);
  return rows;
}
async function atomic(path, value) {
  const tmp = path + "." + randomUUID() + ".tmp",
    f = await open(tmp, "wx", 0o600);
  try {
    await f.writeFile(JSON.stringify(value));
    await f.sync();
  } catch (e) {
    await f.close();
    await unlink(tmp).catch(() => {});
    throw e;
  }
  await f.close();
  try {
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}
export function createCheckin({ root, api, clock = day } = {}) {
  const pending = new Map();
  async function detail(secret, group, signal) {
    return api.post(
      secret,
      group === "pc_incentive_task_mvp_v3"
        ? "/alice/ug/campaign/v3/detail/"
        : "/alice/ug/campaign/list/",
      { campaign_group_code: group },
      { signal },
    );
  }
  // 前端 DailyCheckIn 只发 {scene}，成功判据是 data.checked_in。
  async function signIn(secret, group, signal) {
    const r = await api.post(
      secret,
      "/alice/ug/campaign/landing/checkin",
      { scene: group },
      { signal },
    );
    const d = r?.data || {},
      streak = Number(d.continuous_days) || undefined,
      credit = Number(d.reward_amount) || undefined;
    return {
      checked: d.checked_in === true || Number(d.continuous_days) > 0,
      streak,
      credit,
      message: typeof r?.msg === "string" ? r.msg : "",
    };
  }
  // 把「没拿到活动组」和「上游拒绝」分开说清楚，别让用户以为是账号没资格。
  function reason(error, fallback, group) {
    const detail =
      typeof error?.message === "string" && error.message
        ? "（" + error.message.slice(0, 120) + "）"
        : "";
    return fallback
      ? "豆包未放行网页端签到" +
          detail +
          "；launch 未下发活动组，已用 " +
          group +
          " 兜底重试，签到可能只能在豆包电脑版内完成"
      : "豆包未放行网页端签到" + detail;
  }
  async function run(secret, { signal } = {}) {
    const key = createHash("sha256")
        .update(secret.userId + ":" + (secret.enterpriseType || "0"))
        .digest("hex"),
      today = clock(),
      path = join(root, key + ".json");
    await mkdir(root, { recursive: true, mode: 0o700 });
    let ledger = { day: today };
    try {
      const previous = JSON.parse(await readFile(path, "utf8"));
      if (previous.day === today) ledger = previous;
    } catch (e) {
      if (e.code !== "ENOENT")
        throw fail(409, "签到记录读取异常，未提交领取，请保留记录并检查。");
    }
    let group = ledger.group;
    if (!group) {
      const launch = await api.post(
        secret,
        "/alice/user/launch",
        {},
        { signal },
      );
      group = launch.data?.ug_campaign_info?.campaign_group_code;
    }
    // launch 里的 campaign_group_code 在网页会话下经常是空串。
    // 直接判「未开放」会把上游真实原因盖掉，所以先落到常量上再试。
    let fallback = false;
    if (typeof group !== "string" || !group) {
      group = FALLBACK_GROUP;
      fallback = true;
    }
    let tasks = [],
      detailError;
    try {
      tasks = dailyTasks(await detail(secret, group, signal), group);
    } catch (e) {
      if (e.signIn) throw e;
      detailError = e;
    }
    if (tasks.length !== 1) {
      // v3/detail 与 campaign/list 在网页会话下都拿不到任务列表，
      // 但前端侧栏卡片签到只提交 {scene}，不依赖任务列表，直接走同一条路径。
      let direct;
      try {
        direct = await signIn(secret, group, signal);
      } catch (e) {
        if (e.signIn) throw e;
        return { outcome: "inactive", message: reason(e, fallback, group) };
      }
      if (direct.checked) {
        await atomic(path, { day: today, group, item: "daily_signin", confirmed: true });
        return {
          outcome: "done",
          ...(direct.streak ? { streak: direct.streak } : {}),
          ...(direct.credit ? { credit: direct.credit } : {}),
          message: fallback
            ? "已通过签到接口确认，活动组取自常量。"
            : "今日签到已由上游确认。",
        };
      }
      return {
        outcome: "inactive",
        message:
          reason(detailError, fallback, group) +
          (direct.message ? "；上游回执：" + direct.message.slice(0, 80) : ""),
      };
    }
    const task = tasks[0];
    if (task.checked) {
      await atomic(path, {
        day: today,
        group,
        item: task.key,
        confirmed: true,
      });
      return {
        outcome: "done",
        ...(task.streak ? { streak: task.streak } : {}),
        message: "今日签到已由上游确认。",
      };
    }
    if (ledger.pending || ledger.confirmed)
      return {
        outcome: "failed",
        message: "今日领取结果待核对；仅查询，没有重复提交。",
      };
    if (!task.body)
      return { outcome: "ineligible", message: "今日任务尚未满足领取条件。" };
    if (clock() !== today)
      return {
        outcome: "failed",
        message: "北京时间已跨日，请重新查询今日任务。",
      };
    // Atomic daily reservation across app / CLI hosts. Keep it even after an
    // uncertain result or a crash: another host may query, but never re-submit.
    let reservation;
    try {
      reservation = await open(
        join(root, key + "." + today + ".claim"),
        "wx",
        0o600,
      );
    } catch (e) {
      if (e.code === "EEXIST")
        return {
          outcome: "failed",
          message: "今日领取已有提交记录；仅查询，没有重复提交。",
        };
      throw fail(409, "签到提交记录创建异常，未提交领取。");
    }
    try {
      await reservation.writeFile(
        JSON.stringify({
          day: today,
          group,
          item: task.key,
          reservedAt: Date.now(),
        }),
      );
      await reservation.sync();
    } finally {
      await reservation.close();
    }
    await atomic(path, {
      day: today,
      group,
      item: task.key,
      pending: true,
      submittedAt: Date.now(),
    });
    let error;
    try {
      await api.post(
        secret,
        "/alice/ug/campaign/item/reward/claim/",
        task.body,
        { signal },
      );
    } catch (e) {
      error = e;
    }
    if (error?.status === 429)
      return {
        outcome: "captcha",
        message: "上游要求人工检查，今日不会再次自动提交。",
      };
    if (error?.signIn) throw error;
    if (clock() !== today)
      return {
        outcome: "failed",
        message: "本次领取跨日，记录已保留，请核对。",
      };
    const fresh = dailyTasks(await detail(secret, group, signal), group).find(
      (t) => t.key === task.key && t.group === task.group,
    );
    if (fresh?.checked) {
      await atomic(path, {
        day: today,
        group,
        item: task.key,
        confirmed: true,
      });
      return {
        outcome: "claimed",
        ...(fresh.credit ? { credit: fresh.credit } : {}),
        ...(fresh.streak ? { streak: fresh.streak } : {}),
        message: "签到已领取并回查确认。",
      };
    }
    return {
      outcome: "failed",
      message: "上游尚未确认领取结果，记录已保留，后续仅查询。",
    };
  }
  return {
    run(secret, options) {
      const key = secret.userId + ":" + secret.enterpriseType;
      if (pending.has(key)) return pending.get(key);
      const task = run(secret, options).finally(() => pending.delete(key));
      pending.set(key, task);
      return task;
    },
  };
}
