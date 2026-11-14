// Real Doubao desktop build, under the same Bun runtime family as Magpie. No
// accounts, public pages, or user profiles are involved in this smoke test.
// The vendor client is never installed in public CI, so a missing Doubao prints
// SKIP and exits 0; the test only fails when a browser was found but cannot be
// driven over the anonymous CDP pipes.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availableBrowsers, launchIsolatedBrowser } from "../browser-login.mjs";
import { protectWindowsProfile } from "../windows-browser.mjs";

if (process.platform !== "win32") {
  console.log("SKIP doubao-browser-smoke: 仅 Windows 需要");
  process.exit(0);
}
assert(process.versions.bun, "Run this smoke test with Bun");
const browser = (await availableBrowsers()).find((b) => b.id === "doubao");
if (!browser) {
  console.log(
    "SKIP doubao-browser-smoke: 未检测到豆包桌面端（DW_DOUBAO_BIN 或默认安装路径）",
  );
  process.exit(0);
}
const profile = await mkdtemp(join(tmpdir(), "dw-doubao-smoke-"));
const tempRoot = tmpdir().toLowerCase();
assert(profile.toLowerCase().startsWith(tempRoot), "Unexpected profile root");
assert(
  !profile.toLowerCase().includes("doubao\\user data"),
  "Smoke test must never use the daily Doubao profile",
);
let handle;
try {
  await protectWindowsProfile(profile);
  handle = await launchIsolatedBrowser(browser, profile, { blank: true });
  assert.deepEqual(await handle.cookies(), []);
  console.log(`${browser.name}: found at ${browser.path}`);
  console.log("isolated window and CDP handshake verified");
  console.log("DOUBAO_SMOKE_OK");
} finally {
  await handle?.dispose();
  await rm(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
}
