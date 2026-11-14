// Real browsers, no accounts or public pages: verify both transports and cleanup.
import assert from "node:assert/strict";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availableBrowsers, launchIsolatedBrowser } from "../browser-login.mjs";
import { protectWindowsProfile } from "../windows-browser.mjs";

assert(process.versions.bun, "Run with the Magpie-family Bun runtime");
const browsers = await availableBrowsers();
for (const id of process.platform === "win32" ? ["chrome", "edge"] : ["chrome"]) {
  const browser = browsers.find((b) => b.id === id);
  assert(browser, `Test runner is missing ${id}`);
  for (const transport of ["pipe", "port"]) {
    const profile = await mkdtemp(join(tmpdir(), "dw-isolation-smoke-"));
    let handle;
    try {
      if (process.platform === "win32") await protectWindowsProfile(profile);
      else await chmod(profile, 0o700);
      console.log(`Starting ${process.platform} ${browser.name} ${transport} (blank private profile)`);
      handle = await launchIsolatedBrowser(browser, profile, { blank: true, transport });
      assert.deepEqual(await handle.cookies(), []);
      assert.deepEqual(await handle.identity(), {});
      console.log(`${process.platform} ${browser.name} ${transport}: isolated handshake and empty account data verified`);
    } finally {
      await handle?.dispose();
      await rm(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 });
    }
    console.log(`${browser.name} ${transport}: browser closed and temporary profile removed`);
  }
}
