import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = process.env.WASM_TTS_HOST ?? '0.0.0.0';
const port = Number(process.env.WASM_TTS_PORT ?? 8765);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`WASM_TTS_PORT 無效：${process.env.WASM_TTS_PORT}`);
}
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.txt': 'text/plain', '.bin': 'application/octet-stream', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };

http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  const file = path.resolve(root, `.${pathname}`);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403).end();
    return;
  }
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  fs.stat(file, (statError, stat) => {
    const target = !statError && stat.isDirectory() ? path.join(file, 'index.html') : file;
    fs.readFile(target, (error, data) => {
      if (error) {
        response.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
        return;
      }
      response.setHeader('Content-Type', mime[path.extname(target)] ?? 'application/octet-stream');
      response.writeHead(200).end(data);
    });
  });
}).listen(port, host, () => {
  console.log(`WASM TTS 測試 host 正在監聽 http://${host}:${port}`);
  console.log(`本機入口：http://127.0.0.1:${port}/mobile-host/`);
});
