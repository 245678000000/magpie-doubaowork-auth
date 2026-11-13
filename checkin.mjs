// SPDX-License-Identifier: AGPL-3.0-only
import { readFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fail } from "./protocol.mjs";
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
    if (typeof group !== "string" || !group)
      return { outcome: "inactive", message: "当前账号未开放每日签到。" };
    const tasks = dailyTasks(await detail(secret, group, signal), group);
    if (tasks.length !== 1)
      return {
        outcome: "inactive",
        message: tasks.length
          ? "每日任务不唯一，未提交领取。"
          : "当前活动未下发每日签到任务。",
      };
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
