// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { win32 as path } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const envValue = (env, name) =>
  env[name] ?? Object.entries(env).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

export const windowsChoices = [
  {
    id: "chrome",
    name: "Google Chrome",
    exe: "chrome.exe",
    dir: ["Google", "Chrome", "Application"],
    env: "DW_CHROME_BIN",
    appPaths: true,
  },
  {
    id: "edge",
    name: "Microsoft Edge",
    exe: "msedge.exe",
    dir: ["Microsoft", "Edge", "Application"],
    env: "DW_EDGE_BIN",
    appPaths: true,
  },
  // Doubao ships a Chromium runtime under app\; it only behaves as a browser
  // when started with --saman-browser-entry. The sibling Doubao_browser_proxy.exe
  // is a forwarder and drops the inherited CDP pipes, so the exact basename matters.
  {
    id: "doubao",
    name: "豆包内置浏览器",
    exe: "Doubao.exe",
    dir: ["Doubao", "Application", "app"],
    env: "DW_DOUBAO_BIN",
  },
];

function localPath(value) {
  if (typeof value !== "string" || value.length > 32767) return null;
  const file = value.trim().replace(/^"([^"]+)"$/, "$1").replaceAll("/", "\\");
  if (!/^[a-z]:\\/i.test(file) || /[<>:"|?*\x00-\x1f]/.test(file.slice(2))) return null;
  return path.normalize(file);
}

export function windowsInstallPaths(home, env) {
  const drive = envValue(env, "SystemDrive");
  const systemDrive = /^[a-z]:$/i.test(drive ?? "") ? drive : "C:";
  return [
    envValue(env, "ProgramW6432"),
    envValue(env, "ProgramFiles") || systemDrive + "\\Program Files",
    envValue(env, "ProgramFiles(x86)") || systemDrive + "\\Program Files (x86)",
    envValue(env, "LOCALAPPDATA") || path.join(home, "AppData", "Local"),
  ].map(localPath).filter(Boolean);
}

export function windowsExecutable(value, exe) {
  const file = localPath(value);
  return file && path.basename(file).toLowerCase() === exe.toLowerCase() ? file : null;
}

async function powershell(script, env, extra = {}, timeoutMs = 10000) {
  const system = localPath(envValue(env, "SystemRoot")) ?? "C:\\Windows";
  const executable = path.join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return (await exec(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    shell: false,
    env: { ...env, ...extra },
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 32 * 1024,
    encoding: "utf8",
  })).stdout.trim();
}

// App Paths can contain Unicode or environment variables. Read its default
// value through .NET instead of parsing the localized output of reg.exe.
export async function readWindowsAppPaths(env = process.env) {
  if (process.platform !== "win32") return {};
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
foreach ($entry in @('chrome.exe','msedge.exe')) {
  foreach ($hive in @('CurrentUser','LocalMachine')) {
    foreach ($view in @('Registry64','Registry32')) {
      $base = $null; $key = $null
      try {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view)
        $key = $base.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\' + $entry)
        if ($null -ne $key) {
          $value = $key.GetValue('')
          if ($value -is [string]) {
            [Console]::WriteLine($entry + ':' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value)))
          }
        }
      } catch {} finally {
        if ($null -ne $key) { $key.Dispose() }
        if ($null -ne $base) { $base.Dispose() }
      }
    }
  }
}`;
  const output = await powershell(script, env).catch(() => "");
  const result = { chrome: [], edge: [] };
  for (const line of output.split(/\r?\n/)) {
    const m = /^(chrome|msedge)\.exe:([A-Za-z0-9+/]+={0,2})$/.exec(line);
    if (m) result[m[1] === "chrome" ? "chrome" : "edge"].push(Buffer.from(m[2], "base64").toString("utf8"));
  }
  return result;
}

// POSIX mode bits are not a Windows ACL. Restrict the fresh profile before
// Chromium sees it; its children inherit this DACL. Never modify the normal
// browser profile, the Magpie config directory, or machine-wide settings.
export async function protectWindowsProfile(profile) {
  const info = await lstat(profile);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error("Unexpected profile path");
  const script = `
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
$p = $env:DW_TEMP_BROWSER_PROFILE
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl = [System.IO.Directory]::GetAccessControl($p)
$acl.SetSecurityDescriptorSddlForm(('D:P(A;OICI;FA;;;' + $me + ')(A;OICI;FA;;;SY)'), [System.Security.AccessControl.AccessControlSections]::Access)
[System.IO.Directory]::SetAccessControl($p, $acl)
[Console]::WriteLine('OK')`;
  // Windows PowerShell's first launch can take several seconds while the
  // runtime / Defender warms up. Still fail closed if ACL setup does not finish.
  if (await powershell(script, process.env, { DW_TEMP_BROWSER_PROFILE: profile }, 20000) !== "OK") throw Error("Profile ACL not applied");
}
