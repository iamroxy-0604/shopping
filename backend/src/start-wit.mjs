import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(backendRoot, '..');
const envFile = path.join(backendRoot, '.env');
const localEnv = {};
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match) localEnv[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}
const config = { ...localEnv, ...process.env };
const frameworkPath = path.resolve(config.WIT_FRAMEWORK_PATH || 'D:\\chrome download\\wit-main\\wit-main');
const python = path.resolve(config.PYTHON_EXECUTABLE || path.join(projectRoot, '.venv', 'Scripts', 'python.exe'));
const witPort = Number(config.WIT_PORT || 8765);
if (!fs.existsSync(path.join(frameworkPath, 'wit', '__init__.py')) || !fs.existsSync(python)) {
  console.error('请先设置 WIT_FRAMEWORK_PATH，并用 Python 3.12 创建项目 .venv；参见 wit_agent/README.md');
  process.exit(1);
}
const witUrl = `http://127.0.0.1:${witPort}`;
const wit = spawn(python, ['-m', 'wit_agent.server'], {
  cwd: projectRoot,
  env: { ...config, PYTHONPATH: [frameworkPath, projectRoot, config.PYTHONPATH].filter(Boolean).join(path.delimiter), WIT_PORT: String(witPort) },
  stdio: 'inherit',
  windowsHide: true
});

async function waitForWit() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (wit.exitCode !== null) break;
    try {
      const response = await fetch(`${witUrl}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return true;
    } catch { /* Sidecar is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

if (!await waitForWit()) {
  console.error('Wit 服务启动失败，请检查 Python 依赖和端口占用');
  wit.kill();
  process.exit(1);
}
const backend = spawn(process.execPath, ['src/server.mjs'], {
  cwd: backendRoot,
  env: { ...config, WIT_AGENT_URL: witUrl },
  stdio: 'inherit',
  windowsHide: true
});
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  backend.kill();
  wit.kill();
  process.exitCode = code;
}
backend.on('exit', (code) => stop(code || 0));
wit.on('exit', (code) => stop(code || 1));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
