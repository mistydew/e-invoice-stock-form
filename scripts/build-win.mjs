// Windows 双版本一键构建：win-unpacked → rcedit 注入图标 → 安装版 + 便携版
// 用法：npm run dist
// 说明：win.signAndEditExecutable=false（绕开 winCodeSign 的符号链接问题），
//       图标与版本信息由内置 rcedit 注入，再用 --prepackaged 打包两个目标。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist-win');
const appExe = path.join(out, 'win-unpacked', '发票入库单助手.exe');
const rcedit = path.join(root, 'electron', 'rcedit-ia32.exe');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', shell: false });
const ebCli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
const runEb = (args) => run(process.execPath, [ebCli, ...args]);

console.log('1/3 打包应用目录…');
runEb(['--dir', '-c.directories.output=dist-win']);

console.log('2/3 注入图标与版本信息…');
run(rcedit, [
  appExe,
  '--set-icon', 'electron/icon.ico',
  '--set-version-string', 'FileDescription', '发票入库单助手',
  '--set-version-string', 'ProductName', '发票入库单助手',
  '--set-version-string', 'CompanyName', 'mistydew',
  '--set-file-version', '1.0.0',
  '--set-product-version', '1.0.0',
]);

console.log('3/3 打包 安装版 + 便携版…');
runEb(['--win', '--prepackaged', path.join('dist-win', 'win-unpacked'), '-c.directories.output=dist-win']);

console.log('完成，产物在 dist-win/ 目录：');
for (const f of fs.readdirSync(out)) if (f.endsWith('.exe')) console.log('  -', f);
