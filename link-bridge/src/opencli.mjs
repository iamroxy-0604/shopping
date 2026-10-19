import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../node_modules/@jackwener/opencli/dist/src/main.js');

export function runOpenCli(args, timeout = 20000) {
  return new Promise((resolve) => {
    if (!fs.existsSync(script)) return resolve({ ok: false, code: 'opencli_missing' });
    const child = spawn(process.execPath, [script, ...args], { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { child.kill(); finish({ ok: false, code: 'timeout' }); }, timeout);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) { child.kill(); finish({ ok: false, code: 'output_too_large' }); }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', () => finish({ ok: false, code: 'opencli_error' }));
    child.on('close', (code) => {
      if (code !== 0) {
        const reason = /Navigation rejected/i.test(stderr) ? 'navigation_rejected'
          : /login|登录|auth/i.test(stderr) ? 'login_required' : 'opencli_error';
        return finish({ ok: false, code: reason });
      }
      try { finish({ ok: true, data: JSON.parse(stdout) }); }
      catch { finish({ ok: false, code: 'invalid_output' }); }
    });
  });
}
