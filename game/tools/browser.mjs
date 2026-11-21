// Shared browser launcher for the test tools (FEAT-146).
//   default: the real GPU on Windows (ANGLE D3D11, headless); SwiftShader (software) everywhere else
//   --headed (or SHOT_HEADED=1): visible window on the real GPU
//   --gpu: force the real GPU headless; exits if Chromium falls back to software
//   --cpu (or SHOT_CPU=1): force SwiftShader
//   SHOT_REAL_PAD=1: let pages see the controllers plugged into this PC (BUG-137); by default every context
//     gets navigator.getGamepads() returning [], so a press, stick drift or a virtual pad can't move a check's
//     menus. A tool that fakes a pad (padcheck, menucheck) installs its own stub afterwards, which wins.
// Prints the renderer it got. On software it appends &lowgfx to SHOT_QUERY so big packs don't crawl.
// Local: game/node_modules (npm i). Cloud sandbox: preinstalled copy under /opt/npm-tools.
const { chromium } = await import('playwright').catch(() => import('/opt/npm-tools/node_modules/playwright/index.js').then((m) => m.default));

const GPU_ARGS = process.platform === 'win32'
  ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist']
  : ['--enable-gpu', '--ignore-gpu-blocklist'];
const CPU_ARGS = ['--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

/** Launch Chromium for a test tool from its command-line args. Returns the browser.
 *  `extraArgs`: more Chromium switches (cishot.mjs adds precise heap numbers and gc()). */
export async function launchBrowser(args = process.argv.slice(2), extraArgs = []) {
  const headed = args.includes('--headed') || process.env.SHOT_HEADED === '1';
  const forceGpu = args.includes('--gpu');
  const forceCpu = args.includes('--cpu') || process.env.SHOT_CPU === '1';
  const mode = headed ? 'headed' : forceCpu ? 'cpu' : forceGpu || process.platform === 'win32' ? 'gpu' : 'cpu';

  const browser = mode === 'headed' ? await chromium.launch({ headless: false, args: extraArgs })
    : mode === 'gpu' ? await chromium.launch({ args: [...GPU_ARGS, ...extraArgs] })
    : await chromium.launch({ args: [...CPU_ARGS, ...extraArgs] });

  hidePads(browser);
  const renderer = await rendererName(browser);
  const software = /swiftshader|llvmpipe|software/i.test(renderer);
  console.log(`GPU: ${renderer}${software ? ' (software)' : ''} [${mode}]`);
  if (software && forceGpu) {
    await browser.close();
    throw new Error('--gpu asked for the real GPU but Chromium gave a software renderer');
  }
  if (software && mode !== 'cpu') console.warn('warning: no hardware GPU, falling back to software rendering');
  if (software && !(process.env.SHOT_QUERY ?? '').includes('lowgfx')) process.env.SHOT_QUERY = `${process.env.SHOT_QUERY ?? ''}&lowgfx`;
  return browser;
}

/** Give every new context (browser.newPage makes one too) an init script that hides real gamepads. It goes on
 *  Navigator.prototype, writable and configurable, so a tool's own stub (an assignment on navigator or a
 *  defineProperty on the prototype) still replaces it; context scripts run before a page's own.
 *  For a tool that launches Chromium itself (trailcheck). Does nothing with SHOT_REAL_PAD=1. */
export function hidePads(browser) {
  if (process.env.SHOT_REAL_PAD === '1') return browser;
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (options) => {
    const context = await newContext(options);
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, writable: true, value: () => [] });
    });
    return context;
  };
  return browser;
}

async function rendererName(browser) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) return 'no WebGL2';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    });
  } finally {
    await page.close();
  }
}
