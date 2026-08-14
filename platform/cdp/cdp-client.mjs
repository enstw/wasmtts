// 共用 CDP client：啟動由 find-browser.mjs 找到的無頭 Chromium、等待 DevTools
// endpoint、開啟 WebSocket，並提供 runner 所需的三個基本操作。導覽穩定時間、
// waitFor loop、截圖、結束與清理等差異較大的邏輯刻意留在各 runner；若把
// 1200 ms 與 1500 ms 的等待差異藏進 helper，量測邊界容易在未察覺時漂移。
//
// 需要 Node 22 以上版本，以使用原生 fetch／WebSocket。

import { spawn } from "node:child_process";
import { findBrowser } from "./find-browser.mjs";

// launch({ port, profile, args, gpu, onFail }) →
//   { proc, send, evalJs, close, sessionId, targetId }
//
// - args：額外 browser flags（--window-size、autoplay policy 等）
// - gpu：預設 false，只有明確測 WebGPU 的 runner 才不加入 --disable-gpu
// - onFail：browser 無法啟動時執行的清理工作（例如關閉靜態 server）；屆時
//   browser process 已先被終止
// - send：原始 CDP 呼叫，供需要 Emulation.*、
//   Page.addScriptToEvaluateOnNewDocument 或截圖等進階能力的 suite 使用
export async function launch({ port, profile, args = [], gpu = false, onFail } = {}) {
  const { bin, env } = findBrowser();
  const proc = spawn(bin, [
    "--headless=new", `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, "--no-first-run", ...(gpu ? [] : ["--disable-gpu"]),
    "--no-sandbox", "--disable-dev-shm-usage", ...args,
  ], { stdio: "ignore", env });

  // 60 秒上限：免費 GitHub runner 高負載時冷啟動可超過 20 秒（2026-08-14 曾兩次
  // 連續逾時導致 kaldifst-wasm gate 假性失敗）；polling 在 endpoint 就緒時立即
  // 返回，加大上限不影響健康情況的量測時間。
  const deadline = Date.now() + 60000;
  let wsUrl;
  while (true) {
    try {
      wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
      break;
    } catch {
      if (Date.now() > deadline) {
        proc.kill();
        onFail?.();
        throw new Error("browser never came up");
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  const sock = new WebSocket(wsUrl);
  await new Promise((r) => (sock.onopen = r));
  let id = 0;
  const pending = new Map();
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
      sock.send(JSON.stringify({ id: i, method, params, sessionId }));
    });

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);

  const evalJs = async (expression) => {
    const { result, exceptionDetails } = await send(
      "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (exceptionDetails) throw new Error("page threw: " + (exceptionDetails.exception?.description ?? exceptionDetails.text));
    return result.value;
  };

  const close = async () => {
    if (sock.readyState === WebSocket.OPEN) {
      try { await send("Target.closeTarget", { targetId }); } catch {}
      sock.close();
      await new Promise((resolve) => {
        if (sock.readyState === WebSocket.CLOSED) return resolve();
        const timer = setTimeout(resolve, 2000);
        sock.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
    if (proc.exitCode === null && proc.signalCode === null) proc.kill();
    await new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
      const timer = setTimeout(() => { proc.kill("SIGKILL"); resolve(); }, 3000);
      proc.once("close", () => { clearTimeout(timer); resolve(); });
    });
  };

  return { proc, send, evalJs, close, sessionId, targetId, bin };
}
