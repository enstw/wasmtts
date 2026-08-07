// CDP runner 共用的 Chromium 探測器。解析順序：
//
//   1. BROWSER_BIN（明確覆寫）
//   2. browser-cdp skill 配置的 wrapper（~/.cache/headless-chromium/chrome）
//      若存在，代表已特別配置並驗證可用，且已內建 library path 與 sandbox
//      flags；優先於可能損壞的系統安裝（例如 container 內的 snap chromium）
//   3. 一般桌面安裝（Brave／Chrome／chromium）
//   4. ~/.cache/ms-playwright 下的 chromium-headless-shell；若環境無法安裝
//      libnss3／libnspr4，也支援旁邊 extra-libs/ 的 LD_LIBRARY_PATH shim
//
// 回傳 { bin, env }；把 env 傳給 spawn() 才能套用 library shim。找不到任何
// browser 時直接失敗；可用以下方式安裝：
//   pnpm dlx playwright install chromium-headless-shell
// 若是受限或 container 環境（沒有 root、snap 損壞），則使用 browser-cdp skill
// 的 scripts/provision.sh 配置。

import { statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function findBrowser() {
  const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
  const ls = (dir) => { try { return readdirSync(dir); } catch { return []; } };
  const env = { ...process.env };

  const known =
    process.env.BROWSER_BIN ??
    [
      join(homedir(), ".cache", "headless-chromium", "chrome"),
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/chromium",
      "/usr/bin/google-chrome",
    ].find(isFile);
  if (known) return { bin: known, env };

  const pw = join(homedir(), ".cache", "ms-playwright");
  const shell = ls(pw)
    .filter((d) => d.startsWith("chromium_headless_shell-"))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((d) => join(pw, d, "chrome-linux", "headless_shell"))
    .find(isFile);
  if (shell) {
    const libRoot = join(pw, "extra-libs", "usr", "lib");
    const libs = ls(libRoot).map((d) => join(libRoot, d));
    if (libs.length)
      env.LD_LIBRARY_PATH = [...libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
    return { bin: shell, env };
  }

  console.error("no Chromium found; set BROWSER_BIN, run: pnpm dlx playwright install chromium-headless-shell, or provision one with the browser-cdp skill's provision.sh");
  process.exit(1);
}
