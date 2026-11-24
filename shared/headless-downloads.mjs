import * as filesystem from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

// Configure only a stopped, Vega-managed Chromium profile, as the UID which runs Chromium.
export async function prepareHeadlessDownloads(profile, directory, fs = filesystem) {
  if (!isAbsolute(directory)) throw Error('下载目录必须是绝对路径');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(directory)).isDirectory()) throw Error('下载目录不可用：' + directory);
  await fs.access(directory, constants.W_OK | constants.X_OK);
  const dir = join(profile, 'Default'), prefs = join(dir, 'Preferences');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  let config = {};
  try { config = JSON.parse(await fs.readFile(prefs, 'utf8')); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('无效的 Chromium Preferences；保留原文件');
  if (config.download?.default_directory === directory && config.download?.prompt_for_download === false && config.download?.directory_upgrade === true) return;
  config.download = { ...config.download, default_directory: directory, prompt_for_download: false, directory_upgrade: true };
  const tmp = prefs + '.' + randomUUID();
  try {
    await fs.writeFile(tmp, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
    await fs.rename(tmp, prefs);
  } finally { await fs.rm(tmp, { force: true }); }
}
