// FEAT-318: which browser SnowboardAnywhere.exe opens the game in. The launcher (tools/launcher.mjs) asks in its
// console on the first launch, remembers the answer in launcher.json next to the exe, and the game's
// Settings > Launcher > Browser reads and changes it through the /__launcher/browsers and /__launcher/browser routes.
//
// Windows only for now (the Mac half is FEAT-320): only findBrowsers, pickOther and launch know the OS; the prompt,
// the saved file and the routes are shared. Elsewhere findBrowsers finds nothing, so the launcher opens the system
// default with no prompt and the routes say unavailable (the game hides the setting).
//
// launcher.json: { "browser": "default" } or { "browser": { "name": "Google Chrome", "path": "C:\\...\\chrome.exe" } }.
// Other keys in the file are kept.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { refuseForeignOrigin } from './same_origin.mjs';

const WIN = process.platform === 'win32';
/** how long the first-launch prompt waits before it takes the default, so a double-click never hangs */
const PROMPT_SECONDS = 30;

/** Run a PowerShell script (no profile, hidden from the console's own input); resolves its stdout. */
function powershell(script, { sta = false, timeout = 15000 } = {}) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...(sta ? ['-STA'] : []),
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', args, { windowsHide: true, timeout, encoding: 'utf8', maxBuffer: 4 << 20 }, (e, out) => (e ? reject(e) : resolve(out)));
  });
}

// Reads every StartMenuInternet client (machine, user and 32-bit), and the http UserChoice ProgId with its command,
// as JSON. PowerShell rather than `reg query` text, which is localised ("(Default)" is "(Standard)" in German).
const FIND_PS = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
function Val($p, $n) { $k = Get-Item -LiteralPath $p; if ($k) { $k.GetValue($n) } }
$out = @()
foreach ($r in 'HKLM:\\SOFTWARE\\Clients\\StartMenuInternet', 'HKCU:\\SOFTWARE\\Clients\\StartMenuInternet', 'HKLM:\\SOFTWARE\\WOW6432Node\\Clients\\StartMenuInternet') {
  foreach ($k in (Get-ChildItem -LiteralPath $r)) {
    $out += [pscustomobject]@{ key = $k.PSChildName; name = $k.GetValue(''); app = (Val "$($k.PSPath)\\Capabilities" 'ApplicationName'); command = (Val "$($k.PSPath)\\shell\\open\\command" '') }
  }
}
$prog = Val 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice' 'ProgId'
$cmd = $null; $app = $null
if ($prog) { $cmd = Val "Registry::HKEY_CLASSES_ROOT\\$prog\\shell\\open\\command" ''; $app = Val "Registry::HKEY_CLASSES_ROOT\\$prog\\Application" 'ApplicationName' }
ConvertTo-Json -Compress -Depth 3 @{ clients = @($out); progId = $prog; progCommand = $cmd; progApp = $app }
`;

/** The exe out of a shell\open\command value: `"C:\x\chrome.exe" -- "%1"` or `C:\x\a.exe %1`. */
export function exeOf(command) {
  if (typeof command !== 'string') return null;
  const c = command.trim();
  if (c.startsWith('"')) { const end = c.indexOf('"', 1); return end > 1 ? c.slice(1, end) : null; }
  const m = /^(.*?\.exe)\b/i.exec(c);
  return m ? m[1] : c.split(/\s+/)[0] || null;
}
/** a registry display name, unless it is a resource reference (@C:\x.dll,-101) or empty */
const shown = (n) => (typeof n === 'string' && n.trim() && !n.startsWith('@') ? n.trim() : null);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * The browsers installed on this PC and the system default's name:
 * { browsers: [{ name, path }], defaultName } (defaultName null when it can't be told).
 * Entries whose exe is gone are dropped; Internet Explorer (it opens Edge on Windows 11) is left out.
 */
export async function findBrowsers() {
  if (!WIN) return { browsers: [], defaultName: null };
  let j;
  try { j = JSON.parse((await powershell(FIND_PS)).trim() || '{}'); } catch { return { browsers: [], defaultName: null }; }
  const browsers = [];
  for (const c of [].concat(j.clients ?? [])) {
    if (!c || /^iexplore\.exe$/i.test(c.key ?? '')) continue;
    const exe = exeOf(c.command);
    if (!exe || !fs.existsSync(exe) || browsers.some((b) => same(b.path, exe))) continue;
    browsers.push({ name: shown(c.name) ?? shown(c.app) ?? c.key ?? path.basename(exe, '.exe'), path: exe });
  }
  browsers.sort((a, b) => a.name.localeCompare(b.name));
  const defExe = exeOf(j.progCommand);
  const defaultName = browsers.find((b) => same(b.path, defExe))?.name ?? shown(j.progApp) ?? null;
  return { browsers, defaultName };
}

/** A native file picker for any .exe (portable browsers, Chrome Canary). Resolves { name, path } or null on Cancel. */
export async function pickOther() {
  if (!WIN) return null;
  const out = await powershell(`
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = 'Pick the browser to open Snowboard Anywhere in'
$d.Filter = 'Programs (*.exe)|*.exe'
$d.InitialDirectory = [Environment]::GetFolderPath('ProgramFiles')
if ($d.ShowDialog($owner) -eq 'OK') {
  $v = (Get-Item -LiteralPath $d.FileName).VersionInfo
  ConvertTo-Json -Compress @{ path = $d.FileName; name = $v.FileDescription }
}`, { sta: true, timeout: 0 });
  if (!out.trim()) return null;
  const j = JSON.parse(out.trim());
  return { name: shown(j.name) ?? path.basename(j.path, '.exe'), path: j.path };
}

/** Open url in a browser exe; false when it would not start (the caller falls back to the default). */
export function launch(exe, url) {
  return new Promise((resolve) => {
    try {
      const p = spawn(exe, [url], { detached: true, stdio: 'ignore' });
      p.once('error', () => resolve(false));
      p.once('spawn', () => { p.unref(); resolve(true); });
    } catch { resolve(false); }
  });
}

// ---------------------------------------------------------------- launcher.json
/** the whole file, {} when it is missing or broken */
function readConfig(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { return {}; }
}
/** The saved choice: 'default', { name, path }, or null when nothing (valid) is saved. */
export function savedBrowser(file) {
  const b = readConfig(file).browser;
  if (b === 'default') return 'default';
  return b && typeof b.path === 'string' && b.path ? { name: typeof b.name === 'string' && b.name ? b.name : path.basename(b.path, '.exe'), path: b.path } : null;
}
export function saveBrowser(file, choice) {
  const j = readConfig(file);
  j.browser = choice === 'default' ? 'default' : { name: choice.name, path: choice.path };
  fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
}

// ---------------------------------------------------------------- the console prompt
/**
 * Console lines, one reader for the whole prompt (a reader per question drops lines typed ahead or piped in).
 * ask() resolves the next line, or null after `seconds` (null: no limit) or at the end of input (Ctrl+Z).
 */
function lineReader() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const lines = [];
  let waiting = null, ended = false;
  rl.on('line', (l) => { if (waiting) { const w = waiting; waiting = null; w(l); } else lines.push(l); });
  rl.once('close', () => { ended = true; if (waiting) { const w = waiting; waiting = null; w(null); } });
  return {
    ask(question, seconds) {
      process.stdout.write(question);
      if (lines.length) { const l = lines.shift(); process.stdout.write(`${l}\n`); return Promise.resolve(l); } // echo what was typed ahead
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => {
        const timer = seconds ? setTimeout(() => { waiting = null; process.stdout.write('\n'); resolve(null); }, seconds * 1000) : 0;
        waiting = (l) => { clearTimeout(timer); resolve(l); };
      });
    },
    close() { rl.close(); },
  };
}

/**
 * The console list: "Open Snowboard Anywhere in: 1) Windows default (Edge) 2) ... N) Other...". Saves and resolves
 * the choice. `wait`: the first launch gives up after PROMPT_SECONDS and takes the default; --pick-browser waits.
 */
async function prompt(file, found, wait) {
  const rl = lineReader();
  try { return await promptWith(rl, file, found, wait); } finally { rl.close(); }
}
async function promptWith(rl, file, found, wait) {
  const { browsers, defaultName } = found;
  const def = `Windows default${defaultName ? ` (${defaultName})` : ''}`;
  for (;;) {
    console.log('\nOpen Snowboard Anywhere in:');
    console.log(`  1) ${def}`);
    browsers.forEach((b, i) => console.log(`  ${i + 2}) ${b.name}`));
    const other = browsers.length + 2;
    console.log(`  ${other}) Other... (pick an .exe)`);
    const a = await rl.ask(wait ? 'Choice [1]: ' : `Choice [1] (Windows default in ${PROMPT_SECONDS} s): `, wait ? null : PROMPT_SECONDS);
    const t = (a ?? '').trim();
    const n = t === '' ? 1 : Number(t);
    let choice = null;
    if (n === 1) choice = 'default';
    else if (Number.isInteger(n) && n >= 2 && n < other) choice = browsers[n - 2];
    else if (n === other) {
      console.log('Pick the browser\'s .exe in the window that opened (it may be behind this one).');
      choice = await pickOther().catch(() => null);
      if (!choice) { console.log('Nothing picked.'); continue; }
    } else { console.log(`Type a number from 1 to ${other}, or press Enter for the Windows default.`); continue; }
    saveBrowser(file, choice);
    console.log(`\nThe game opens in ${choice === 'default' ? def : choice.name}. To change it: SnowboardAnywhere.exe --pick-browser,`);
    console.log('or Settings > Launcher > Browser in the game.');
    return choice;
  }
}

/**
 * The browser this launch opens: the saved one, or ask (first launch, --pick-browser, or the saved exe is gone).
 * Resolves 'default' or { name, path }. Off Windows, or with no console to ask in, it is the default without asking.
 */
export async function chooseBrowser(file, { pick = false, interactive = true } = {}) {
  const saved = savedBrowser(file);
  if (saved && !pick) {
    if (saved === 'default' || fs.existsSync(saved.path)) return saved;
    console.log(`\n${saved.name} is no longer at ${saved.path}: pick another browser.`);
  }
  if (!WIN || !interactive || !process.stdin.isTTY) return saved && saved !== 'default' && fs.existsSync(saved.path) ? saved : 'default';
  const found = await findBrowsers();
  return prompt(file, found, pick);
}

// ---------------------------------------------------------------- the routes, for Settings > Launcher > Browser
/**
 * GET /__launcher/browsers: { available, current: 'default' | path, defaultName, browsers: [{ name, path }] }
 * POST /__launcher/browser { path: 'default' | one of the listed paths } or { other: true } (the file picker opens on
 * this PC): saves it, answers like GET. Only listed paths are taken, so a page can't point the launcher at any exe.
 * Connect-style (req, res, next); the launcher mounts it, the dev server doesn't (the game then hides the setting).
 */
export function browserRoutes(file) {
  let picking = false; // one Other... file picker at a time
  let cache = null; // the registry read takes a moment: once per launcher run (a browser added with Other... comes from launcher.json)
  const found = async () => (cache ??= findBrowsers());
  const state = async () => {
    const f = await found();
    const s = savedBrowser(file);
    const browsers = [...f.browsers];
    if (s && s !== 'default' && fs.existsSync(s.path) && !browsers.some((b) => same(b.path, s.path))) browsers.push(s); // one picked with Other...
    return { available: WIN, current: s && s !== 'default' && fs.existsSync(s.path) ? s.path : 'default', defaultName: f.defaultName, browsers };
  };
  const send = (res, code, body) => {
    res.statusCode = code; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(body));
  };
  return (req, res, next) => {
    const url = req.url.split('?')[0];
    if (url !== '/__launcher/browsers' && url !== '/__launcher/browser') { next(); return; }
    route(req, res, url).catch((e) => { if (!res.headersSent) send(res, 500, { error: String(e?.message ?? e) }); else res.end(); });
  };
  async function route(req, res, url) {
    if (url === '/__launcher/browsers') {
      if (req.method !== 'GET') { send(res, 405, { error: 'GET only' }); return; }
      send(res, 200, await state()); return;
    }
    if (req.method !== 'POST') { send(res, 405, { error: 'POST only' }); return; }
    if (refuseForeignOrigin(req, res)) return;
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) { send(res, 403, { error: 'same-origin JSON only' }); return; }
    if (!WIN) { send(res, 404, { error: 'only on Windows' }); return; }
    let body = '';
    for await (const c of req) { body += c; if (body.length > 4096) { send(res, 413, { error: 'too long' }); return; } }
    let j;
    try { j = JSON.parse(body); } catch { send(res, 400, { error: 'not JSON' }); return; }
    if (j?.other) {
      if (picking) { send(res, 409, { error: 'the file picker is already open' }); return; }
      picking = true;
      let c;
      try { c = await pickOther().catch(() => null); } finally { picking = false; }
      if (c) { saveBrowser(file, c); console.log(`\nSettings: the game opens in ${c.name} from the next launch.`); }
      send(res, 200, { ...(await state()), picked: !!c }); return;
    }
    const s = await state();
    const choice = j?.path === 'default' ? 'default' : s.browsers.find((b) => same(b.path, j?.path));
    if (!choice) { send(res, 400, { error: 'not one of the listed browsers' }); return; }
    saveBrowser(file, choice);
    console.log(`\nSettings: the game opens in ${choice === 'default' ? 'the Windows default browser' : choice.name} from the next launch.`);
    send(res, 200, await state());
  }
}
