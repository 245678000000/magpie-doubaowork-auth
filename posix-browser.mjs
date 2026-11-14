import { posix } from "node:path";

// Only executable locations, never profiles. PATH entries must be absolute.
export async function posixBrowsers(platform, home, env, works) {
  const choices = [
    { id: "chrome", name: "Google Chrome", variable: "DW_CHROME_BIN", app: "Google Chrome.app", bin: "Google Chrome", linux: ["google-chrome", "google-chrome-stable", "chrome"] },
    { id: "edge", name: "Microsoft Edge", variable: "DW_EDGE_BIN", app: "Microsoft Edge.app", bin: "Microsoft Edge", linux: ["microsoft-edge", "microsoft-edge-stable"] },
    { id: "chromium", name: "Chromium", variable: "DW_CHROMIUM_BIN", app: "Chromium.app", bin: "Chromium", linux: ["chromium", "chromium-browser"] },
  ];
  if (!["linux", "darwin"].includes(platform)) return [];
  const dirs = [...new Set(["/usr/bin", "/usr/local/bin", "/opt/google/chrome", "/opt/microsoft/msedge", "/snap/bin", ...(env.PATH || "").split(":").slice(0, 64)])]
    .filter((dir) => posix.isAbsolute(dir) && !/[\x00-\x1f\x7f]/.test(dir));
  const found = [];
  for (const choice of choices) {
    const valid = (file) => typeof file === "string" && posix.isAbsolute(file) && !/[\x00-\x1f\x7f]/.test(file) &&
      (platform === "darwin" ? posix.basename(file) === choice.bin : choice.linux.includes(posix.basename(file)));
    const candidates = [env[choice.variable], ...(platform === "darwin"
      ? ["/Applications", posix.join(home, "Applications")].map((dir) => posix.join(dir, choice.app, "Contents/MacOS", choice.bin))
      : dirs.flatMap((dir) => choice.linux.map((bin) => posix.join(dir, bin))))];
    for (const file of new Set(candidates)) {
      if (valid(file) && await works(file)) {
        found.push({ id: choice.id, name: choice.name, path: file });
        break;
      }
    }
  }
  return found;
}

export function checkLinuxEnvironment({ env = process.env, uid = process.getuid?.() } = {}) {
  if (uid === 0) throw Error("Linux 图形登录请以普通用户运行 Magpie；浏览器沙箱保持开启，不使用 root 启动登录窗口。");
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) throw Error("Linux 登录需要图形会话。请在桌面启动 Magpie，或先配置 Xvfb 并传入实际 DISPLAY；插件不猜测显示编号。");
}
