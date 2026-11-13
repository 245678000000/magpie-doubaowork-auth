// Real Chrome and Edge, under the same Bun runtime family as Magpie. No
// accounts, public pages, or user profiles are involved in this smoke test.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availableBrowsers, launchIsolatedBrowser } from "../browser-login.mjs";
import { protectWindowsProfile } from "../windows-browser.mjs";

assert.equal(process.platform, "win32");
assert(process.versions.bun, "Run this smoke test with Bun");
const browsers = await availableBrowsers();
for (const id of ["chrome", "edge"]) {
  const browser = browsers.find((b) => b.id === id);
  assert(browser, `Windows test runner is missing ${id}`);
  const profile = await mkdtemp(join(tmpdir(), "dw-win-smoke-"));
  let handle;
  try {
    await protectWindowsProfile(profile);
    handle = await launchIsolatedBrowser(browser, profile, { blank: true });
    assert.deepEqual(await handle.cookies(), []);
    console.log(`${browser.name}: found, isolated window and CDP handshake verified`);
  } finally {
    await handle?.dispose();
    await rm(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
  }
}
