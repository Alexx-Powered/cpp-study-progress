#!/usr/bin/env node
'use strict';

// 仅使用 Node.js 内置模块：读取公开视频元数据，替换模板配置和分 P 数据。
// 发布操作留给智能体按用户指定的平台执行，本脚本不会创建仓库或上传文件。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createDesktopShortcut } = require('./desktop_shortcut.cjs');

const SKILL_DIR = path.resolve(__dirname, '..');
const TEMPLATE_URL = 'https://raw.githubusercontent.com/Alexx-Powered/cpp-study-progress/main/templates/%E5%AD%A6%E4%B9%A0%E8%BF%9B%E5%BA%A6%E6%A8%A1%E6%9D%BF.html';
const BV_PATTERN = /^BV[0-9A-Za-z]{10}$/;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');

function parseArgs(argv) {
  const options = { action: argv[0], overwrite: false };
  const allowed = new Set(['url', 'output', 'metadata', 'metadata-output', 'template', 'storage-prefix', 'html', 'shortcut-dir', 'icon-png']);
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--no-shortcut') {
      if (options.noShortcut) throw new Error('重复参数 --no-shortcut');
      options.noShortcut = true;
      continue;
    }
    if (flag === '--overwrite') {
      if (options.overwrite) throw new Error('重复参数 --overwrite');
      options.overwrite = true;
      continue;
    }
    if (!flag.startsWith('--') || !allowed.has(flag.slice(2))) throw new Error(`未知参数：${flag}`);
    const key = flag.slice(2);
    if (options[key] !== undefined) throw new Error(`重复参数：${flag}`);
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`缺少参数值：${flag}`);
    options[key] = argv[++i];
  }
  return options;
}

async function publicRequest(url, headers = {}) {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, ...headers },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}：${url}`);
  }
  return response;
}

async function identifyVideo(input) {
  if (typeof input !== 'string') throw new Error('请提供 B 站视频链接');
  if (BV_PATTERN.test(input)) return { bvid: input };
  let url;
  try { url = new URL(input); } catch { throw new Error('无法识别视频链接'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('只接受公开 HTTP/HTTPS 链接');
  if (url.hostname === 'b23.tv') {
    const response = await publicRequest(url.href);
    url = new URL(response.url);
    await response.body?.cancel();
  }
  if (!(url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com'))) throw new Error('链接不是 B 站视频');
  const match = url.pathname.match(/\/video\/(BV[0-9A-Za-z]{10}|av\d+)(?:\/|$)/);
  if (!match) throw new Error('需要 /video/BV… 或 /video/av… 视频地址，不能把合集页当作分 P 视频');
  return match[1].startsWith('BV') ? { bvid: match[1] } : { aid: match[1].slice(2) };
}

function normalizeCourse(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('课程元数据必须是对象');
  let input = raw;
  if (Object.hasOwn(raw, 'code')) {
    if (raw.code !== 0 || !raw.data) throw new Error(`B 站接口返回 ${raw.code}：${raw.message || '无数据'}`);
    const data = raw.data;
    if (!Array.isArray(data.pages)) throw new Error('接口缺少逐 P 数据');
    if (Number.isInteger(data.videos) && data.videos !== data.pages.length) throw new Error('接口的总分 P 数与目录不一致，请检查浏览器目录');
    input = {
      bvid: data.bvid,
      title: data.title,
      pages: data.pages.map(p => ({ page: p.page, title: p.part, durationSeconds: p.duration, cid: p.cid }))
    };
    if (data.ugc_season) {
      input.separateCollection = {
        title: data.ugc_season.title,
        episodes: (data.ugc_season.sections || []).reduce((sum, s) => sum + (s.episodes || []).length, 0)
      };
    }
  }
  if (!BV_PATTERN.test(input.bvid)) throw new Error('元数据中缺少有效 BV 号');
  if (typeof input.title !== 'string' || !input.title.trim()) throw new Error('课程标题为空');
  if (!Array.isArray(input.pages) || !input.pages.length) throw new Error('没有分 P 数据');
  const pages = input.pages.map(p => {
    if (!p || !Number.isSafeInteger(p.page) || p.page < 1) throw new Error('分 P 编号必须是正整数');
    if (typeof p.title !== 'string' || !p.title.trim()) throw new Error(`P${p.page} 标题为空`);
    if (!Number.isSafeInteger(p.durationSeconds) || p.durationSeconds < 0) throw new Error(`P${p.page} 缺少真实整数秒数`);
    const result = { page: p.page, title: p.title, durationSeconds: p.durationSeconds };
    if (p.cid !== undefined) {
      if (!Number.isSafeInteger(p.cid) || p.cid < 1) throw new Error(`P${p.page} 的 cid 无效`);
      result.cid = p.cid;
    }
    if (p.stage !== undefined) {
      if (typeof p.stage !== 'string' || !p.stage.trim()) throw new Error(`P${p.page} 的章节名称无效`);
      result.stage = p.stage;
    }
    return result;
  }).sort((a, b) => a.page - b.page);
  pages.forEach((p, i) => {
    if (p.page !== i + 1) throw new Error('分 P 编号存在缺失或重复，必须从 1 连续到 N');
  });
  const total = pages.reduce((sum, p) => sum + p.durationSeconds, 0);
  if (!Number.isSafeInteger(total)) throw new Error('总秒数超出安全范围');
  const course = { version: 1, bvid: input.bvid, title: input.title, url: `https://www.bilibili.com/video/${input.bvid}/`, pages };
  if (input.source) course.source = input.source;
  if (input.separateCollection) course.separateCollection = input.separateCollection;
  return course;
}

async function fetchCourse(input) {
  const identity = await identifyVideo(input);
  const api = new URL('https://api.bilibili.com/x/web-interface/view');
  for (const [key, value] of Object.entries(identity)) api.searchParams.set(key, value);
  const response = await publicRequest(api.href, { Referer: 'https://www.bilibili.com/' });
  const course = normalizeCourse(await response.json());
  course.source = { method: 'bilibili-view-api', url: api.href, checkedAt: new Date().toISOString() };
  return course;
}

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const pad = value => String(value).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${pad(minutes)}:${pad(seconds % 60)}`;
}

// JSON 要用于内联脚本：转义闭合 script 标签及 Unicode 行分隔符，不执行模板代码。
function scriptJson(value, indent = 2) {
  return JSON.stringify(value, null, indent).replace(/[<>&\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// 扫描顶层字面量边界，支持字符串及注释，避免用 eval 读取网络模板。
function literalRange(html, name, opening) {
  const matches = [...html.matchAll(new RegExp(`^const ${name}\\s*=\\s*`, 'gm'))];
  if (matches.length !== 1) throw new Error(`模板应恰好包含一个 const ${name}`);
  const start = matches[0].index + matches[0][0].length;
  if (html[start] !== opening) throw new Error(`${name} 必须是可替换的字面量`);
  let depth = 0, quote = '', escaped = false, lineComment = false, blockComment = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i], next = html[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '/' && next === '/') { lineComment = true; i++; continue; }
    if (c === '/' && next === '*') { blockComment = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{' || c === '[') depth++;
    if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  throw new Error(`模板的 ${name} 未闭合`);
}

function configureTemplate(html, course, storagePrefix) {
  const range = literalRange(html, 'TEMPLATE_CONFIG', '{');
  let config = html.slice(range.start, range.end);
  const values = { storagePrefix, title: course.title, courseUrl: course.url, courseLinkText: 'B 站课程', legacyPositionKeys: [] };
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`^([ \\t]*(?:${key}|"${key}")[ \\t]*:[ \\t]*).*$`, 'gm');
    if ([...config.matchAll(pattern)].length !== 1) throw new Error(`模板配置 ${key} 需要单独一行且只出现一次`);
    config = config.replace(pattern, (_, prefix) => prefix + scriptJson(value, 0) + ',');
  }
  return html.slice(0, range.start) + config + html.slice(range.end);
}

// 只提取原标题中的章节或重复主题前缀；已有人工阶段优先，未知标题不继承上一集。
function inferLessonStages(lessons) {
 const fallback = "课程分集";
 const details = lessons.map(lesson => {
  const text = String(lesson.title || "").trim()
   .replace(/^(?:(?:P|EP|课时)\s*)?\d+(?:[.．-]\d+)*[.．、:：)）\s_-]+/i, "")
   .replace(/^第\s*[0-9一二三四五六七八九十百零〇两]+\s*[课讲][.．、:：\s-]*/, "");
  const heading = text.match(/^(第\s*[0-9一二三四五六七八九十百零〇两]+\s*(?:阶段|章|篇|部分|模块)|(?:chapter|module|part|stage)\s+[0-9IVX]+\b)/i);
  const bracket = text.match(/^[【\[]([^】\]]+)[】\]]/);
  let cut = text.length, depth = 0;
  for (let i = 0; i < text.length; i++) {
   if (/[（(【\[]/.test(text[i])) depth++;
   else if (/[）)】\]]/.test(text[i])) depth = Math.max(0, depth - 1);
   else if (!depth && /[-‐‑–—_:：|｜]/.test(text[i])) { cut = i; break; }
  }
  const prefix = heading ? heading[1].replace(/\s+/g, heading[1].startsWith("第") ? "" : " ")
   : bracket ? bracket[1].trim() : text.slice(0, cut).trim();
  const usable = prefix.length >= 2 && prefix.length <= 60;
  return { text, prefix, usable, heading: !!heading, structured: cut < text.length || !!bracket };
 });
 const counts = new Map();
 for (const item of details) {
  if (item.usable && (item.structured || item.heading)) counts.set(item.prefix, (counts.get(item.prefix) || 0) + 1);
 }
 return lessons.map((lesson, index) => {
  if (typeof lesson.stage === "string" && lesson.stage.trim() && lesson.stage.trim() !== fallback) return lesson.stage;
  const item = details[index];
  const opening = index === 0 && /课程导学|课程介绍|课程导览|课程概述/.test(item.text);
  const closing = index === lessons.length - 1 && /感恩同行|后会有期|课程总结|结束语|结课|课程结束/.test(item.text);
  if (item.usable && (item.heading || (item.structured && counts.get(item.prefix) >= 2) || opening || closing)) return item.prefix;
  return fallback;
 });
}

function generateHtml(template, input, storagePrefix) {
  const course = normalizeCourse(input);
  const prefix = storagePrefix || `bilibili-${course.bvid.toLowerCase()}`;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(prefix)) throw new Error('存储前缀须为 1～100 个字母、数字、下划线或连字符');
  let html = configureTemplate(template.replace(/^\uFEFF/, ''), course, prefix);
  // 从模板的 JSON 图标字典读取资源，不执行模板脚本；首次加载也显示课程图标。
  if (html.includes('function applyCourseIcon(') && html.includes('id="courseIcon"')) {
    const iconFunction = html.slice(html.indexOf('function applyCourseIcon('), html.indexOf('applyCourseIcon(TITLE);')).replace(/^[ \t]+const icons/m, 'const icons');
    const iconRange = literalRange(iconFunction, 'icons', '{');
    const icons = JSON.parse(iconFunction.slice(iconRange.start, iconRange.end));
    const match = course.title.match(/python|c\+\+|c＋＋/i);
    const kind = match ? (/python/i.test(match[0]) ? 'python' : 'cpp') : 'book';
    const href = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(icons[kind]);
    html = html.replace(/<link\b[^>]*\bid="courseIcon"[^>]*>/i, tag => tag.replace(/\bhref="[^"]*"/i, () => `href="${href}"`));
  }
  const range = literalRange(html, 'BASE', '[');
  const stages = inferLessonStages(course.pages);
  const lessons = course.pages.map((p, i) => ({ title: p.title, duration: formatDuration(p.durationSeconds), stage: stages[i] }));
  html = html.slice(0, range.start) + scriptJson(lessons) + html.slice(range.end);
  if (!/<meta\s+charset=["']?utf-8/i.test(html) || !html.includes('renderDailyChart') || !html.includes('buildEpisodeUrl')) {
    throw new Error('模板缺少 UTF-8 声明或学习进度功能');
  }
  return html;
}

async function loadTemplate(localPath) {
  if (localPath) {
    const html = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(localPath));
    return { html, source: { kind: 'local', path: path.resolve(localPath), sha256: sha256(html) }, warnings: [] };
  }
  try {
    const response = await publicRequest(TEMPLATE_URL);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 1024 * 1024) throw new Error('模板大于 1 MiB，请人工检查');
    const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // 只检验可替换结构，不运行下载的脚本；真实课程随后替换。
    generateHtml(html, { bvid: 'BV1sHU9BmEne', title: '结构检查', pages: [{ page: 1, title: '结构检查', durationSeconds: 1 }] });
    return { html, source: { kind: 'github', url: TEMPLATE_URL, sha256: sha256(html) }, warnings: [] };
  } catch (error) {
    const cached = path.join(SKILL_DIR, 'assets', 'template.html');
    const html = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(cached));
    return { html, source: { kind: 'bundled-cache', url: TEMPLATE_URL, sha256: sha256(html) }, warnings: [`GitHub 模板不可用，使用随技能保存的快照：${error.message}`] };
  }
}

function checkOutput(filename, overwrite = false) {
  const output = path.resolve(filename);
  if (fs.existsSync(output)) {
    const stat = fs.lstatSync(output);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`输出目标不是普通文件：${output}`);
    if (!overwrite) throw new Error(`文件已存在，未覆盖：${output}；若用户要求覆盖，可加 --overwrite`);
  }
  return output;
}

function writeOutput(filename, content, overwrite = false) {
  const output = checkOutput(filename, overwrite);
  let backup = null;
  if (fs.existsSync(output)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backup = `${output}.bak-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
    fs.copyFileSync(output, backup, fs.constants.COPYFILE_EXCL);
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, content, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' });
  return { output, backup };
}

function summary(course) {
  const totalSeconds = course.pages.reduce((sum, p) => sum + p.durationSeconds, 0);
  return { bvid: course.bvid, title: course.title, parts: course.pages.length, totalSeconds, totalMinutes: Number((totalSeconds / 60).toFixed(1)), first: course.pages[0], last: course.pages.at(-1), separateCollection: course.separateCollection || null };
}

async function main() {
  if (!process.argv[2] || ['--help', '-h'].includes(process.argv[2])) {
    console.log('Node.js 18+\ncreate --url <B站链接> --output <目标.html> [--metadata-output <课程.json>]\nfetch --url <B站链接> --output <课程.json>\nbuild --metadata <课程.json> --output <目标.html>\ndesktop --html <最终.html> [--icon-png <课程Logo.png>]\ncreate/build 默认创建带课程 Logo 的 Windows 桌面快捷方式。\n可选：--no-shortcut（临时或线上构建） --shortcut-dir <目录> --template <模板.html> --storage-prefix <独立前缀> --overwrite（先备份）');
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  if (options.action === 'desktop') {
    if (!options.html) throw new Error('desktop 需要 --html 指向最终文件');
    console.log(JSON.stringify(createDesktopShortcut(options.html, { directory: options['shortcut-dir'], png: options['icon-png'] }), null, 2));
    return;
  }
  if (!['fetch', 'build', 'create'].includes(options.action)) throw new Error('命令须为 fetch、build 或 create');
  if (!options.output) throw new Error('请指定 --output');
  const extension = options.action === 'fetch' ? '.json' : '.html';
  if (path.extname(options.output).toLowerCase() !== extension) throw new Error(`输出应为 ${extension} 文件`);
  const outputPath = checkOutput(options.output, options.overwrite);
  if (options['metadata-output']) {
    if (options.action === 'fetch') throw new Error('fetch 的 --output 已是元数据文件');
    if (path.extname(options['metadata-output']).toLowerCase() !== '.json') throw new Error('元数据输出应为 .json 文件');
    const metadataPath = checkOutput(options['metadata-output'], options.overwrite);
    if (metadataPath.toLowerCase() === outputPath.toLowerCase()) throw new Error('元数据与 HTML 输出不能相同');
  }
  let course;
  if (options.action === 'build') {
    if (!options.metadata) throw new Error('build 需要 --metadata');
    course = normalizeCourse(JSON.parse(fs.readFileSync(options.metadata, 'utf8').replace(/^\uFEFF/, '')));
  } else {
    if (!options.url) throw new Error('需要 --url');
    course = await fetchCourse(options.url);
  }
  if (options.action === 'fetch') {
    console.log(JSON.stringify({ ...summary(course), ...writeOutput(options.output, JSON.stringify(course, null, 2) + '\n', options.overwrite) }, null, 2));
    return;
  }
  const template = await loadTemplate(options.template);
  const html = generateHtml(template.html, course, options['storage-prefix']);
  const metadata = options['metadata-output'] ? writeOutput(options['metadata-output'], JSON.stringify(course, null, 2) + '\n', options.overwrite) : null;
  const result = { ...summary(course), ...writeOutput(options.output, html, options.overwrite), metadata, template: template.source, warnings: [...template.warnings] };
  if (!options.noShortcut) {
    try { result.desktop = createDesktopShortcut(result.output, { directory: options['shortcut-dir'], png: options['icon-png'] }); }
    catch (error) {
      result.desktop = { error: error.message };
      result.warnings.push('HTML 已生成，但桌面快捷方式尚未完成：' + error.message);
      process.exitCode = 1;
    }
  }
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { identifyVideo, normalizeCourse, fetchCourse, formatDuration, literalRange, inferLessonStages, generateHtml, loadTemplate, writeOutput, summary };
if (require.main === module) main().catch(error => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
