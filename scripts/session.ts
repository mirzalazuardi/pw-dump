import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const SESSION_DIR = process.env.PLAYWRIGHT_SESSION_DIR || 'sessions';
const JSON_FILE = path.join(SESSION_DIR, process.env.PLAYWRIGHT_JSON || 'session.json');
const TEXT_FILE = path.join(SESSION_DIR, process.env.PLAYWRIGHT_TEXT || 'session.txt');
const MODE = process.env.MODE || 'record';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const REPLAY_TIMEOUT = parseInt(process.env.REPLAY_TIMEOUT || '5000', 10);
const MAX_WAIT_FOR_SELECTOR = 15000;
const VIEWPORT_WIDTH = parseInt(process.env.VIEWPORT_WIDTH || '1280', 10);
const VIEWPORT_HEIGHT = parseInt(process.env.VIEWPORT_HEIGHT || '720', 10);

type Event =
  | { type: 'click'; selector: string; ts: number }
  | { type: 'input'; selector: string; value: string; ts: number }
  | { type: 'keydown'; key: string; ts: number }
  | { type: 'network-request'; method: string; url: string; postData?: string | null; ts: number }
  | { type: 'network-response'; status: number; url: string; ts: number };

const events: Event[] = [];

if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

function save() {
  fs.writeFileSync(JSON_FILE, JSON.stringify(events, null, 2));
  
  const textOutput = events
    .filter(e => {
      if (e.type === 'network-request' || e.type === 'network-response') {
        const url = e.url.toLowerCase();
        const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.bmp', '.avif'];
        return !imageExts.some(ext => url.includes(ext));
      }
      return true;
    })
    .map(e => {
      if (e.type === 'network-request') {
        const bodyPreview = e.postData ? ` | Body: ${e.postData.substring(0, 120)}${e.postData.length > 120 ? '...' : ''}` : '';
        return `[REQUEST] ${e.method} ${e.url}${bodyPreview}`;
      }
      if (e.type === 'network-response') {
        return `[RESPONSE] ${e.status} ${e.url}`;
      }
      if (e.type === 'click') {
        return `[CLICK] ${e.selector}`;
      }
      if (e.type === 'input') {
        return `[INPUT] ${e.selector} = "${e.value}"`;
      }
      if (e.type === 'keydown') {
        return `[KEY] ${e.key}`;
      }
      return '';
    })
    .filter(line => line.trim() !== '')
    .join('\n');

  fs.writeFileSync(TEXT_FILE, textOutput);
  
  console.log('Session tersimpan:');
  console.log('  * JSON (lengkap): ' + JSON_FILE);
  console.log('  * TEXT (ringkasan): ' + TEXT_FILE);
  console.log('  * Total event: ' + events.length + ' | ' + events.filter(e => e.type === 'input').length + ' input field');
}

const INJECTED_SCRIPT = 
'function getSelector(el) {\n' +
'  if (!el || el.nodeType !== 1) return \'body\';\n' +
'  const testId = el.dataset?.testid;\n' +
'  if (testId) return \'[data-testid="\' + CSS.escape(testId) + \'"]\';\n' +
'  if (el.id) {\n' +
'    try {\n' +
'      if (document.querySelectorAll(\'#\' + CSS.escape(el.id)).length === 1) {\n' +
'        return \'#\' + CSS.escape(el.id);\n' +
'      }\n' +
'    } catch (e) {}\n' +
'  }\n' +
'  const parts = [];\n' +
'  let current = el;\n' +
'  while (current && current !== document.documentElement) {\n' +
'    let selector = current.tagName.toLowerCase();\n' +
'    if (current.classList.length) {\n' +
'      const staticClasses = Array.from(current.classList).filter(cls => \n' +
'        !/^(js-|hover-|active-|focus-|Mui|ant-|v-|ng-)/i.test(cls)\n' +
'      );\n' +
'      if (staticClasses.length > 0) {\n' +
'        selector += \'.\' + staticClasses.map(cls => CSS.escape(cls)).join(\'.\');\n' +
'      }\n' +
'    }\n' +
'    if (current.parentNode) {\n' +
'      const siblings = Array.from(current.parentNode.children).filter(\n' +
'        sibling => sibling.tagName === current.tagName &&\n' +
'        Array.from(sibling.classList).join(\'.\') === Array.from(current.classList).join(\'.\')\n' +
'      );\n' +
'      if (siblings.length > 1) {\n' +
'        const index = siblings.indexOf(current) + 1;\n' +
'        selector += \':nth-of-type(\' + index + \')\';\n' +
'      }\n' +
'    }\n' +
'    parts.unshift(selector);\n' +
'    if (current.id) {\n' +
'      try { parts[0] = \'#\' + CSS.escape(current.id); } catch (e) {}\n' +
'      break;\n' +
'    }\n' +
'    current = current.parentNode;\n' +
'  }\n' +
'  return parts.join(\' > \');\n' +
'}\n' +
'document.addEventListener(\'click\', function(e) {\n' +
'  if (!e.target) return;\n' +
'  window.pwRecord({ type: \'click\', selector: getSelector(e.target), ts: Date.now() });\n' +
'}, true);\n' +
'document.addEventListener(\'input\', function(e) {\n' +
'  if (!e.target) return;\n' +
'  let value = \'\';\n' +
'  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {\n' +
'    value = e.target.value;\n' +
'  } else if (e.target instanceof HTMLElement) {\n' +
'    value = e.target.textContent || \'\';\n' +
'  }\n' +
'  window.pwRecord({ type: \'input\', selector: getSelector(e.target), value: value, ts: Date.now() });\n' +
'}, true);\n' +
'document.addEventListener(\'keydown\', function(e) {\n' +
'  window.pwRecord({ type: \'keydown\', key: e.key, ts: Date.now() });\n' +
'}, true);';

// KRUSIAL: Reset posisi konten sebagai STRING (hindari error TS window/document)
const RESET_POSITION_SCRIPT = `
  window.scrollTo(0, 0);
  document.body.style.margin = '0';
  document.body.style.padding = '0';
  document.documentElement.style.scrollBehavior = 'auto';
  void document.body.offsetHeight; // Force reflow
`;

(async () => {
  const browser = await chromium.launch({ 
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });
  
  const context = await browser.newContext({
    viewport: { 
      width: VIEWPORT_WIDTH, 
      height: VIEWPORT_HEIGHT 
    }
  });
  
  const page = await context.newPage();

  if (MODE === 'record') {
    await page.exposeFunction('pwRecord', (e: Event) => {
      events.push(e);
      if (e.type === 'click') console.log('[CLICK] [' + events.length + '] ' + e.selector);
      if (e.type === 'input') console.log('[INPUT] [' + events.length + '] ' + e.selector + ' = "' + e.value + '"');
      if (e.type === 'keydown') console.log('[KEY] [' + events.length + '] ' + e.key);
    });

    page.on('request', req => {
      // PERBAIKAN TYPO: data: (bukan data:)
      if (!req.url().startsWith('data:')) {
        events.push({
          type: 'network-request',
          method: req.method(),
          url: req.url(),
          postData: req.postData(),
          ts: Date.now()
        });
      }
    });

    page.on('response', res => {
      events.push({
        type: 'network-response',
        status: res.status(),
        url: res.url(),
        ts: Date.now()
      });
    });

    await page.addInitScript(INJECTED_SCRIPT);
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    
    // RESET POSISI KONTEN KE KIRI-ATAS (MENGGUNAKAN STRING - AMAN UNTUK TS)
    await page.evaluate(RESET_POSITION_SCRIPT);
    
    console.log('\nRECORDING DIMULAI: ' + BASE_URL);
    console.log('  * Viewport: ' + VIEWPORT_WIDTH + 'x' + VIEWPORT_HEIGHT);
    console.log('  * Semua interaksi direkam UTUH (termasuk password/token)');
    console.log('  * Tekan Ctrl+C untuk menyimpan sesi dan keluar\n');

    process.on('SIGINT', async () => {
      console.log('\nMenghentikan perekaman...');
      save();
      await browser.close();
      process.exit(0);
    });

    await new Promise(() => {});
  }

  if (MODE === 'replay') {
    if (!fs.existsSync(JSON_FILE)) {
      console.error('File sesi tidak ditemukan: ' + JSON_FILE);
      await browser.close();
      process.exit(1);
    }

    const data: Event[] = JSON.parse(fs.readFileSync(JSON_FILE, 'utf-8')) as Event[];
    
    console.log('MEMULAI REPLAY: ' + data.length + ' event dari ' + JSON_FILE);
    console.log('  Target: ' + BASE_URL);
    console.log('  Viewport: ' + VIEWPORT_WIDTH + 'x' + VIEWPORT_HEIGHT);
    console.log('  PERINGATAN: Semua nilai input direplay SESUAI REKAMAN\n');

    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    
    // RESET POSISI KONTEN SEBELUM REPLAY
    await page.evaluate(RESET_POSITION_SCRIPT);
    
    let lastTs = data[0]?.ts || Date.now();
    let successCount = 0;
    let failCount = 0;

    for (const [index, e] of data.entries()) {
      const timeDiff = Math.min(Math.max(0, e.ts - lastTs), 5000);
      if (timeDiff > 50) await page.waitForTimeout(timeDiff);
      lastTs = e.ts;

      try {
        switch (e.type) {
          case 'click':
            await page.waitForSelector(e.selector, { state: 'visible', timeout: MAX_WAIT_FOR_SELECTOR });
            await page.click(e.selector);
            successCount++;
            break;
          
          case 'input':
            await page.waitForSelector(e.selector, { state: 'visible', timeout: MAX_WAIT_FOR_SELECTOR });
            await page.fill(e.selector, e.value);
            successCount++;
            break;
          
          case 'keydown':
            await page.keyboard.press(e.key);
            successCount++;
            break;
        }
      } catch (err) {
        failCount++;
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.warn('[Event #' + index + '] ' + e.type + ' gagal: ' + errorMsg);
        
        if (e.type === 'keydown') {
          console.warn('  Key: ' + e.key);
        } else if ('selector' in e) {
          console.warn('  Selector: ' + e.selector);
        }
      }
    }

    console.log('\nREPLAY SELESAI');
    console.log('  Berhasil: ' + successCount + ' | Gagal: ' + failCount + ' dari ' + data.length + ' event');
    console.log('  Menunggu ' + (REPLAY_TIMEOUT / 1000) + ' detik sebelum menutup');
    await page.waitForTimeout(REPLAY_TIMEOUT);
  }

  await browser.close();
})();
