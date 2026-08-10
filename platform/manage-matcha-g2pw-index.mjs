#!/usr/bin/env node

// 管理可續跑的 g2pW WebGPU 全文掃描；本機狀態與 log 均不提交。

import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const statePrefix = path.resolve(root, 'platform/results/matcha-g2pw-manager.local');
const configFile = `${statePrefix}.json`;
const pidFile = `${statePrefix}.pid`;
const logFile = `${statePrefix}.log`;
const defaultDatabase = path.resolve(root, 'platform/results/matcha-g2p-index.local.sqlite');

function usage() {
  return `用法：
  pnpm g2pw-index run <novel.zip> [index 參數]
  pnpm g2pw-index resume
  pnpm g2pw-index status
  pnpm g2pw-index logs [行數]
  pnpm g2pw-index stop`;
}

function readConfig() {
  return fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : null;
}

function readPid() {
  if (!fs.existsSync(pidFile)) return null;
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function databaseFromArgs(args) {
  const index = args.indexOf('--database');
  return index >= 0 && args[index + 1] ? path.resolve(args[index + 1]) : defaultDatabase;
}

function totalFromArgs(args) {
  const index = args.indexOf('--total-sentences');
  return index >= 0 && args[index + 1] ? Number(args[index + 1]) : null;
}

function start(config) {
  const currentPid = readPid();
  if (isAlive(currentPid)) throw new Error(`掃描已在執行（PID ${currentPid}）`);
  fs.mkdirSync(path.dirname(statePrefix), {recursive: true});
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  const output = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'worker'], {
    cwd: root, detached: true, stdio: ['ignore', output, output],
  });
  child.unref();
  fs.closeSync(output);
  fs.writeFileSync(pidFile, `${child.pid}\n`);
  console.log(JSON.stringify({started: true, pid: child.pid, database: databaseFromArgs(config.args), logFile}, null, 2));
}

async function waitForHost(child) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`mobile-host 提前結束：${child.exitCode}`);
    try { if ((await fetch('http://127.0.0.1:8765/platform/g2pw-webgpu-benchmark.html')).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('mobile-host 在 30 秒內未就緒');
}

async function worker() {
  const config = readConfig();
  if (!config) throw new Error('找不到 resume 設定');
  let host;
  try {
    try {
      const response = await fetch('http://127.0.0.1:8765/platform/g2pw-webgpu-benchmark.html');
      if (!response.ok) throw new Error();
    } catch {
      host = spawn('pnpm', ['host:mobile'], {cwd: root, stdio: ['ignore', 'inherit', 'inherit']});
      await waitForHost(host);
    }
    const runner = spawn(process.execPath, ['platform/index-matcha-g2pw-webgpu.mjs', '--', ...config.args], {
      cwd: root, stdio: ['ignore', 'inherit', 'inherit'],
    });
    const forwardInterrupt = () => runner.exitCode === null && runner.kill('SIGINT');
    const forwardTermination = () => runner.exitCode === null && runner.kill('SIGTERM');
    process.on('SIGINT', forwardInterrupt);
    process.on('SIGTERM', forwardTermination);
    const code = await new Promise((resolve) => runner.once('close', resolve));
    process.exitCode = code ?? 1;
  } finally {
    if (host?.exitCode === null) host.kill('SIGTERM');
    try { if (readPid() === process.pid) fs.unlinkSync(pidFile); } catch {}
  }
}

function status(args) {
  const config = readConfig();
  const pid = readPid();
  const database = config ? databaseFromArgs(config.args) : defaultDatabase;
  let run = null;
  if (fs.existsSync(database)) {
    const db = new DatabaseSync(database, {readOnly: true});
    try { run = db.prepare(`SELECT id, status, last_sentence_id, created_at, completed_at
      FROM runs ORDER BY id DESC LIMIT 1`).get() ?? null; } finally { db.close(); }
  }
  const explicitTotal = totalFromArgs(args);
  const totalSentences = explicitTotal ?? (config ? totalFromArgs(config.args) : null);
  const completed = run ? run.last_sentence_id + 1 : 0;
  console.log(JSON.stringify({process: {pid, alive: isAlive(pid)}, database, run,
    progress: {completed, totalSentences,
      percent: totalSentences ? Number((completed * 100 / totalSentences).toFixed(2)) : null}, logFile}, null, 2));
}

const [command, ...args] = process.argv.slice(2);
if (command === 'worker') await worker();
else if (command === 'run') {
  if (!args.length) throw new Error(usage());
  start({args, savedAt: new Date().toISOString()});
} else if (command === 'resume') {
  const config = readConfig();
  if (!config) throw new Error(`找不到先前設定。\n${usage()}`);
  start(config);
} else if (command === 'status') status(args);
else if (command === 'logs') {
  const count = Number(args[0] ?? 20);
  if (!fs.existsSync(logFile)) console.log('尚無 log');
  else console.log(fs.readFileSync(logFile, 'utf8').trimEnd().split('\n').slice(-count).join('\n'));
} else if (command === 'stop') {
  const pid = readPid();
  if (!isAlive(pid)) console.log('管理中的掃描未執行');
  else { process.kill(pid, 'SIGINT'); console.log(`已要求 PID ${pid} 在目前 batch 後停止`); }
} else throw new Error(usage());
