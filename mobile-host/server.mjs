import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = process.env.WASM_TTS_HOST ?? '0.0.0.0';
const port = Number(process.env.WASM_TTS_PORT ?? 8765);
const scoreOnly = process.env.WASM_TTS_SCORE_ONLY === '1';
const scoreEndpoint = '/mobile-host/frequency-ab-score';
const scoreFile = path.resolve(
  process.env.WASM_TTS_SCORE_FILE ?? path.join(root, '.cache', 'frequency-ab-scores.jsonl'),
);
const scoreVariants = ['A', 'B', 'C', 'D'];
const scoreVariantSet = new Set(scoreVariants);
const listeningDevices = new Set(['headphones', 'speaker', 'other']);
const scoreOnlyFiles = new Set([
  '/mobile-host/frequency-ab-score.html',
  '/mobile-host/frequency-ab-score.css',
  '/mobile-host/frequency-ab-score.mjs',
  '/frameworks/matcha/samples/frequency-ab/frequency-ab.json',
  '/frameworks/matcha/samples/frequency-ab/A.wav',
  '/frameworks/matcha/samples/frequency-ab/B.wav',
  '/frameworks/matcha/samples/frequency-ab/C.mp3',
  '/frameworks/matcha/samples/frequency-ab/D.wav',
]);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`WASM_TTS_PORT 無效：${process.env.WASM_TTS_PORT}`);
}
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.txt': 'text/plain', '.bin': 'application/octet-stream', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };

function respondJson(response, status, value) {
  response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
  response.end(`${JSON.stringify(value)}\n`);
}

function parseByteRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (!match) return {invalid: true};
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return {invalid: true};

  let start;
  let end;
  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return {invalid: true};
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
  }
  if (
    !Number.isInteger(start)
    || !Number.isInteger(end)
    || start < 0
    || start >= size
    || end < start
  ) {
    return {invalid: true};
  }
  return {start, end: Math.min(end, size - 1)};
}

function serveFile(request, response, target, stat) {
  const range = parseByteRange(request.headers.range, stat.size);
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('Content-Type', mime[path.extname(target)] ?? 'application/octet-stream');
  if (range?.invalid) {
    response.setHeader('Content-Range', `bytes */${stat.size}`);
    response.writeHead(416).end();
    return;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? stat.size - 1;
  response.setHeader('Content-Length', Math.max(0, end - start + 1));
  if (range) response.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  response.writeHead(range ? 206 : 200);
  if (request.method === 'HEAD' || stat.size === 0) {
    response.end();
    return;
  }
  fs.createReadStream(target, {start, end})
    .on('error', (error) => response.destroy(error))
    .pipe(response);
}

function readJsonBody(request, maximumBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let tooLarge = false;
    request.on('data', (chunk) => {
      length += chunk.length;
      if (length > maximumBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) {
        reject(Object.assign(new Error('payload 太大'), {status: 413}));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('JSON 格式錯誤'), {status: 400}));
      }
    });
    request.on('error', reject);
  });
}

function firstForwardedValue(value) {
  const normalized = Array.isArray(value) ? value[0] : value;
  return normalized?.split(',')[0].trim() ?? '';
}

function hasSameOriginHost(request) {
  if (!request.headers.origin) return true;
  let origin;
  try {
    origin = new URL(request.headers.origin);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(origin.protocol)) return false;
  const allowedHosts = new Set([
    request.headers.host,
    firstForwardedValue(request.headers['x-forwarded-host']),
  ].filter(Boolean));
  return allowedHosts.has(origin.host);
}

function textField(value, label, maximumLength, {required = false} = {}) {
  if (value === undefined || value === null) {
    if (required) throw Object.assign(new Error(`${label} 為必填`), {status: 400});
    return '';
  }
  if (typeof value !== 'string') {
    throw Object.assign(new Error(`${label} 必須是文字`), {status: 400});
  }
  const normalized = value.trim();
  if (required && !normalized) {
    throw Object.assign(new Error(`${label} 為必填`), {status: 400});
  }
  if (normalized.length > maximumLength) {
    throw Object.assign(new Error(`${label} 超過 ${maximumLength} 字`), {status: 400});
  }
  return normalized;
}

function timestampField(value, label) {
  const timestamp = textField(value, label, 40, {required: true});
  if (Number.isNaN(Date.parse(timestamp))) {
    throw Object.assign(new Error(`${label} 不是有效時間`), {status: 400});
  }
  return timestamp;
}

function exactVariants(value, label) {
  if (
    !Array.isArray(value)
    || value.length !== scoreVariants.length
    || new Set(value).size !== scoreVariants.length
    || value.some((variant) => !scoreVariantSet.has(variant))
  ) {
    throw Object.assign(new Error(`${label} 必須完整包含 A、B、C、D`), {status: 400});
  }
  return [...value];
}

function validateScoreSubmission(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('payload 必須是物件'), {status: 400});
  }
  if (value.schemaVersion !== 1) {
    throw Object.assign(new Error('不支援的 schemaVersion'), {status: 400});
  }
  const sessionId = textField(value.sessionId, 'sessionId', 80, {required: true});
  const participantLabel = textField(value.participantLabel, '受試者代號', 80);
  const listeningDevice = textField(value.listeningDevice, '播放設備', 20, {required: true});
  if (!listeningDevices.has(listeningDevice)) {
    throw Object.assign(new Error('播放設備無效'), {status: 400});
  }
  const presentationOrder = exactVariants(value.presentationOrder, 'presentationOrder');
  const playedVariants = exactVariants(value.playedVariants, 'playedVariants');
  if (!scoreVariantSet.has(value.bestVariant)) {
    throw Object.assign(new Error('bestVariant 無效'), {status: 400});
  }
  if (!Array.isArray(value.ratings) || value.ratings.length !== scoreVariants.length) {
    throw Object.assign(new Error('ratings 必須有四筆'), {status: 400});
  }
  const ratingVariants = exactVariants(value.ratings.map((rating) => rating?.variant), 'ratings');
  const ratings = value.ratings.map((rating) => {
    const presentationIndex = Number(rating.presentationIndex);
    if (
      !Number.isInteger(presentationIndex)
      || presentationIndex < 1
      || presentationIndex > scoreVariants.length
      || presentationOrder[presentationIndex - 1] !== rating.variant
    ) {
      throw Object.assign(new Error(`${rating.variant} 的 presentationIndex 無效`), {status: 400});
    }
    const scores = {};
    for (const name of ['boxiness', 'clarity', 'naturalness']) {
      const score = Number(rating[name]);
      if (!Number.isInteger(score) || score < 1 || score > 5) {
        throw Object.assign(new Error(`${rating.variant} 的 ${name} 必須是 1–5 整數`), {status: 400});
      }
      scores[name] = score;
    }
    return {
      variant: rating.variant,
      presentationIndex,
      ...scores,
      notes: textField(rating.notes, `${rating.variant} 備註`, 500),
    };
  });
  if (ratingVariants.some((variant, index) => variant !== value.ratings[index].variant)) {
    throw Object.assign(new Error('ratings 順序無效'), {status: 400});
  }

  const stimulusSet = value.stimulusSet;
  if (!stimulusSet || typeof stimulusSet !== 'object' || Array.isArray(stimulusSet)) {
    throw Object.assign(new Error('stimulusSet 無效'), {status: 400});
  }
  const stimulusHashes = {};
  for (const variant of scoreVariants) {
    const hash = textField(stimulusSet.sha256?.[variant], `${variant} SHA-256`, 64, {required: true});
    if (!/^[0-9a-f]{64}$/u.test(hash)) {
      throw Object.assign(new Error(`${variant} SHA-256 無效`), {status: 400});
    }
    stimulusHashes[variant] = hash;
  }

  return {
    schemaVersion: 1,
    sessionId,
    participantLabel,
    listeningDevice,
    startedAt: timestampField(value.startedAt, 'startedAt'),
    submittedAt: timestampField(value.submittedAt, 'submittedAt'),
    presentationOrder,
    playedVariants,
    bestVariant: value.bestVariant,
    ratings,
    overallNotes: textField(value.overallNotes, '整體備註', 1000),
    stimulusSet: {
      generatedAt: timestampField(stimulusSet.generatedAt, 'stimulusSet.generatedAt'),
      sha256: stimulusHashes,
    },
  };
}

async function scoreCount() {
  try {
    const content = await fs.promises.readFile(scoreFile, 'utf8');
    return content.split('\n').filter(Boolean).length;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

async function handleScoreRequest(request, response) {
  if (request.method === 'GET') {
    respondJson(response, 200, {count: await scoreCount()});
    return;
  }
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'GET, POST');
    respondJson(response, 405, {error: '只支援 GET／POST'});
    return;
  }
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    respondJson(response, 415, {error: 'Content-Type 必須是 application/json'});
    return;
  }
  if (!hasSameOriginHost(request)) {
    respondJson(response, 403, {error: '只接受同源評分'});
    return;
  }
  const submission = validateScoreSubmission(await readJsonBody(request));
  const stored = {
    submissionId: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    ...submission,
  };
  await fs.promises.mkdir(path.dirname(scoreFile), {recursive: true});
  await fs.promises.appendFile(scoreFile, `${JSON.stringify(stored)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  respondJson(response, 201, {
    ok: true,
    submissionId: stored.submissionId,
    count: await scoreCount(),
  });
}

http.createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (pathname === scoreEndpoint) {
    try {
      await handleScoreRequest(request, response);
    } catch (error) {
      const status = error.status ?? 500;
      if (status >= 500) console.error(`評分保存失敗：${error.stack ?? error.message}`);
      else console.warn(`評分拒絕（HTTP ${status}）：${error.message}`);
      if (!response.headersSent) {
        respondJson(response, status, {error: error.message ?? '保存失敗'});
      }
    }
    return;
  }
  if (scoreOnly && pathname === '/') {
    response.writeHead(302, {Location: '/mobile-host/frequency-ab-score.html'}).end();
    return;
  }
  if (scoreOnly && !scoreOnlyFiles.has(pathname)) {
    response.writeHead(404).end();
    return;
  }
  if (request.method === 'POST' && pathname === '/mobile-host/telemetry') {
    const chunks = [];
    let length = 0;
    request.on('data', (chunk) => {
      length += chunk.length;
      if (length <= 64 * 1024) chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        console.log(`[iPhone ${event.session ?? '?'}] ${JSON.stringify(event)}`);
        response.writeHead(204).end();
      } catch (error) {
        response.writeHead(400, {'Content-Type': 'text/plain'}).end(error.message);
      }
    });
    return;
  }
  const file = path.resolve(root, `.${pathname}`);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403).end();
    return;
  }
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.setHeader('Allow', 'GET, HEAD');
    response.writeHead(405).end();
    return;
  }
  fs.stat(file, (statError, stat) => {
    const target = !statError && stat.isDirectory() ? path.join(file, 'index.html') : file;
    fs.stat(target, (error, targetStat) => {
      if (error) {
        response.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
        return;
      }
      if (!targetStat.isFile()) {
        response.writeHead(404).end();
        return;
      }
      serveFile(request, response, target, targetStat);
    });
  });
}).listen(port, host, () => {
  console.log(`WASM TTS 測試 host 正在監聽 http://${host}:${port}`);
  if (scoreOnly) {
    console.log(`評分頁專用模式：http://${host}:${port}/mobile-host/frequency-ab-score.html`);
  } else {
    console.log(`本機入口：http://127.0.0.1:${port}/mobile-host/`);
  }
  console.log(`盲測評分將保存至 ${scoreFile}`);
});
