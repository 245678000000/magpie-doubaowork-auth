import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCheckin } from "../checkin.mjs";
const detail = (checked) => ({
  data: {
    campaign_code: "pc_incentive_task_mvp_v3",
    tasks: [
      {
        campaign_code: "daily",
        reward_mode: 2,
        task_status: 1,
        daily_checkin: {
          checked_in_today: checked,
          reward: { reward_amount: 200 },
        },
      },
    ],
  },
});
test("签到只提交一次，未知结果落盘，后续调用仅回查", async () => {
  const root = await mkdtemp(join(tmpdir(), "dw-checkin-"));
  let claims = 0;
  const api = {
    post: async (_s, path) => {
      if (path.endsWith("/launch"))
        return {
          data: {
            ug_campaign_info: {
              campaign_group_code: "pc_incentive_task_mvp_v3",
            },
          },
        };
      if (path.endsWith("/claim/")) {
        claims++;
        throw Error("NETWORK");
      }
      return detail(false);
    },
  };
  try {
    const run = createCheckin({ root, api, clock: () => "2026-11-13" }),
      s = { userId: "A", enterpriseType: "0" };
    assert.equal((await run.run(s)).outcome, "failed");
    assert.equal((await run.run(s)).outcome, "failed");
    assert.equal(claims, 1);
    const { readdir } = await import("node:fs/promises");
    const info = await stat(join(root, (await readdir(root))[0]));
    assert(info.isFile());
    if (process.platform !== "win32") assert.equal(info.mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("已签到与未满足条件不发领取请求", async () => {
  const root = await mkdtemp(join(tmpdir(), "dw-checkin-"));
  try {
    let claims = 0;
    const run = createCheckin({
      root,
      api: {
        post: async (_s, p) => {
          if (p.endsWith("/launch"))
            return {
              data: {
                ug_campaign_info: {
                  campaign_group_code: "pc_incentive_task_mvp_v3",
                },
              },
            };
          if (p.endsWith("/claim/")) claims++;
          return detail(true);
        },
      },
    });
    assert.equal(
      (await run.run({ userId: "A", enterpriseType: "0" })).outcome,
      "done",
    );
    assert.equal(claims, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("两个独立宿主并发签到，也只提交一次", async () => {
  const root = await mkdtemp(join(tmpdir(), "dw-checkin-multi-"));
  let claims = 0;
  const api = {
    post: async (_s, p) => {
      if (p.endsWith("/launch"))
        return {
          data: {
            ug_campaign_info: {
              campaign_group_code: "pc_incentive_task_mvp_v3",
            },
          },
        };
      if (p.endsWith("/claim/")) {
        claims++;
        await new Promise((r) => setTimeout(r, 25));
        return { code: 0 };
      }
      return detail(false);
    },
  };
  try {
    const a = createCheckin({ root, api }),
      b = createCheckin({ root, api }),
      s = { userId: "A", enterpriseType: "0" };
    const results = await Promise.all([a.run(s), b.run(s)]);
    assert.equal(claims, 1);
    assert(results.every((r) => r.outcome === "failed"));
    assert.equal((await createCheckin({ root, api }).run(s)).outcome, "failed");
    assert.equal(claims, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
