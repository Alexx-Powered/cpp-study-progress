'use strict';

// Windows 桌面交付：将最终 HTML 的内嵌 Logo 渲染为 ICO，并创建指向该文件的快捷方式。
// 只使用 Node、Windows PowerShell 和已安装的 Edge/Chrome；浏览器使用独立临时配置。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

function powershell(source, payload = {}) {
 const bootstrap = '$ErrorActionPreference="Stop"; $ProgressPreference="SilentlyContinue"; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ' +
  '$data=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:BILIBILI_SHORTCUT_PAYLOAD)) | ConvertFrom-Json); ';
 const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
 return JSON.parse(execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(bootstrap + source, 'utf16le').toString('base64')], {
  encoding: 'utf8', windowsHide: true, timeout: 30000,
  env: { ...process.env, BILIBILI_SHORTCUT_PAYLOAD: Buffer.from(JSON.stringify(payload)).toString('base64') }
 }).replace(/^\uFEFF/, '').trim());
}

function findBrowser() {
 const folders = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
 for (const folder of folders) {
  for (const relative of ['Microsoft/Edge/Application/msedge.exe', 'Google/Chrome/Application/chrome.exe']) {
   const candidate = path.join(folder, relative);
   if (fs.existsSync(candidate)) return candidate;
  }
 }
 throw new Error('未找到 Edge/Chrome。可用隔离浏览器将最终课程 Logo 渲染为 PNG，再运行 desktop --icon-png <PNG>。');
}

function renderLogo(html) {
 const tag = html.match(/<link\b[^>]*\bid=["']courseIcon["'][^>]*>/i)?.[0];
 const href = tag?.match(/\bhref=["']([^"']+)["']/i)?.[1];
 if (!href || !/^data:image\/svg\+xml[;,]/i.test(href)) throw new Error('最终 HTML 缺少内嵌 SVG 课程 Logo。');
 const temporaryRoot = path.resolve(os.tmpdir());
 const temporary = fs.mkdtempSync(path.join(temporaryRoot, 'bilibili-course-icon-'));
 try {
  // SVG 通过 img 加载，并禁止外部请求；不执行模板或 SVG 中的脚本。
  const source = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">' +
   '<style>html,body{margin:0;width:256px;height:256px;overflow:hidden}img{display:block;width:256px;height:256px}</style><img src="' + href.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '">';
  const document = path.join(temporary, 'icon.html'), screenshot = path.join(temporary, 'icon.png');
  fs.writeFileSync(document, source, 'utf8');
  execFileSync(findBrowser(), ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=256,256', '--default-background-color=00000000', '--virtual-time-budget=1000', '--user-data-dir=' + path.join(temporary, 'profile'), '--screenshot=' + screenshot, pathToFileURL(document).href], { windowsHide: true, timeout: 45000, stdio: 'pipe' });
  if (!fs.existsSync(screenshot)) throw new Error('浏览器未生成课程 Logo PNG。');
  return fs.readFileSync(screenshot);
 } finally {
  // 只清理本次 mkdtemp 创建、且位于系统临时目录中的确定路径。
  if (path.dirname(temporary) === temporaryRoot && path.basename(temporary).startsWith('bilibili-course-icon-')) {
   try { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 }); } catch { /* 浏览器退出后仍被占用时留给系统清理。 */ }
  }
 }
}

function pngToIco(png) {
 if (png.length < 33 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('图标不是有效 PNG。');
 const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
 if (width !== height || width < 16 || width > 256) throw new Error('课程图标 PNG 须为 16～256 像素的正方形。');
 const header = Buffer.alloc(22);
 header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
 header[6] = width === 256 ? 0 : width; header[7] = height === 256 ? 0 : height;
 header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
 header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
 return Buffer.concat([header, png]);
}

function createDesktopShortcut(filename, options = {}) {
 if (process.platform !== 'win32') throw new Error('自动桌面快捷方式仅支持 Windows；HTML 已保留。');
 const htmlPath = path.resolve(filename);
 if (path.extname(htmlPath).toLowerCase() !== '.html' || !fs.statSync(htmlPath).isFile()) throw new Error('需要最终保存位置的 HTML 文件。');
 const directory = options.directory ? path.resolve(options.directory) : powershell('[Environment]::GetFolderPath("Desktop") | ConvertTo-Json -Compress');
 if (!directory || !fs.statSync(directory).isDirectory()) throw new Error('桌面或指定快捷方式目录不存在。');
 const png = options.png ? fs.readFileSync(path.resolve(options.png)) : renderLogo(fs.readFileSync(htmlPath, 'utf8'));
 const icon = htmlPath.slice(0, -5) + '.ico', bytes = pngToIco(png);
 let iconBackup = null;
 if (fs.existsSync(icon)) {
  const stat = fs.lstatSync(icon);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('ICO 目标不是普通文件：' + icon);
  if (!fs.readFileSync(icon).equals(bytes)) {
   iconBackup = icon + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
   fs.copyFileSync(icon, iconBackup, fs.constants.COPYFILE_EXCL);
  }
 }
 fs.writeFileSync(icon, bytes);
 const name = path.basename(htmlPath, '.html');
 const suffix = crypto.createHash('sha256').update(htmlPath.toLowerCase()).digest('hex').slice(0, 8);
 const result = powershell(`
 $shell=New-Object -ComObject WScript.Shell;
 $shortcutPath=Join-Path $data.directory ($data.name+".lnk");
 if(Test-Path -LiteralPath $shortcutPath){
  $existing=$shell.CreateShortcut($shortcutPath);
  if($existing.TargetPath -ine $data.html){$shortcutPath=Join-Path $data.directory ($data.alternate+".lnk")}
 }
 if(Test-Path -LiteralPath $shortcutPath){
  $item=Get-Item -LiteralPath $shortcutPath;
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw "快捷方式目标不是普通文件"};
  if($shell.CreateShortcut($shortcutPath).TargetPath -ine $data.html){throw "同名快捷方式指向其他文件，未覆盖"}
 }
 $shortcut=$shell.CreateShortcut($shortcutPath);
 $shortcut.TargetPath=$data.html;
 $shortcut.WorkingDirectory=[IO.Path]::GetDirectoryName($data.html);
 $shortcut.IconLocation=$data.icon+",0";
 $shortcut.Description=$data.name;
 $shortcut.Save();
 $check=$shell.CreateShortcut($shortcutPath);
 if($check.TargetPath -ine $data.html -or $check.IconLocation -ine ($data.icon+",0")){throw "快捷方式写入核验失败"};
 @{shortcut=$shortcutPath;target=$check.TargetPath;icon=$data.icon} | ConvertTo-Json -Compress;
 `, { html: htmlPath, icon, directory, name, alternate: name + '-' + suffix });
 return { ...result, iconBackup };
}

module.exports = { createDesktopShortcut, pngToIco };
