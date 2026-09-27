import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LOG_DIR = path.join(backendRoot, 'logs');
export const LOG_FILE = path.join(LOG_DIR, 'app.log');

export function logEvent(event, details = {}) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const line = JSON.stringify({ time: new Date().toISOString(), event, ...details }) + '\n';
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch {
    // 日志失败不能影响购物流程
  }
}
