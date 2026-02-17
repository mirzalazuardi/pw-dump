import { chromium } from 'playwright';
import fs from 'fs';

const SESSION_DIR = process.env.PLAYWRIGHT_SESSION_DIR || 'sessions';
const JSON_FILE = `${SESSION_DIR}/${process.env.PLAYWRIGHT_JSON || 'session.json'}`;
const TEXT_FILE = `${SESSION_DIR}/${process.env.PLAYWRIGHT_TEXT || 'session.txt'}`;

const MODE = process.env.MODE || 'record';
// const JSON_FILE = 'sessions/session.json';
// const TEXT_FILE = 'sessions/session.txt';
// const BASE_URL = 'https://example.com';
const BASE_URL = 'http://localhost:3000';

type Event =
  | { type: 'click'; selector: string; ts: number }
  | { type: 'input'; selector: string; value: string; ts: number }
  | { type: 'keydown'; key: string; ts: number }
  | { type: 'network-request'; method: string; url: string; postData?: string | null; ts: number }
  | { type: 'network-response'; status: number; url: string; ts: number };

const events: Event[] = [];

function save() {
  fs.mkdirSync('sessions', { recursive: true });

  fs.writeFileSync(JSON_FILE, JSON.stringify(events, null, 2));

  const textOutput = events.filter(e => {
    if (e.type === 'network-request' || e.type === 'network-response') {
      const url = e.url;
      const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp'];
      return !imageExtensions.some(ext => url.toLowerCase().includes(ext));
    }
    return true;
  }).map(e => {
    if (e.type === 'network-request') {
      return `[REQUEST] ${e.method} ${e.url}${e.postData ? ` | Body: ${e.postData}` : ''}`;
    }
    if (e.type === 'network-response') {
      return `[RESPONSE] ${e.status} ${e.url}`;
    }
    if (e.type === 'click') {
      const isIgnored =
        e.selector.toLowerCase().includes('img') ||
        e.selector.toLowerCase().includes('svg') ||
        e.selector.toLowerCase().includes('icon') ||
        e.selector.toLowerCase().includes('image');
      if (isIgnored) return '';
      return `[CLICK] ${e.selector}`;
    }
    if (e.type === 'input') {
      return `[INPUT] ${e.selector} = ${e.value}`;
    }
    if (e.type === 'keydown') {
      return `[KEY] ${e.key}`;
    }
    return '';
  }).filter(line => line !== '').join('\n');

  fs.writeFileSync(TEXT_FILE, textOutput);

  console.log('💾 session saved to:');
  console.log(`  - ${JSON_FILE}`);
  console.log(`  - ${TEXT_FILE}`);
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  if (MODE === 'record') {
    await page.exposeFunction('pwRecord', (e: Event) => {
      events.push(e);
    });

    page.on('request', req => {
      const postData = req.postData();
      console.log(`📤 ${req.method()} ${req.url()}${postData ? ` [${postData.slice(0, 50)}...]` : ''}`);
      events.push({
        type: 'network-request',
        method: req.method(),
        url: req.url(),
        postData,
        ts: Date.now()
      });
    });

    page.on('response', res => {
      console.log(`📥 ${res.status()} ${res.url()}`);
      events.push({
        type: 'network-response',
        status: res.status(),
        url: res.url(),
        ts: Date.now()
      });
    });

    await page.addInitScript(`
      function cssPath(el) {
        if (!el || !el.tagName) return '';
        let path = el.tagName.toLowerCase();
        if (el.id) return '#' + el.id;
        if (el.className)
          path += '.' + el.className.toString().split(' ').join('.');
        return path;
      }

      document.addEventListener('click', e => {
        const t = e.target;
        if (!t) return;

        window.pwRecord({
          type: 'click',
          selector: cssPath(t),
          ts: Date.now()
        });
      });

        document.addEventListener('input', e => {
          const t = e.target;
          if (!t || !t.name) return;

          const sensitive =
            t.type === 'password' ||
            t.name.toLowerCase().includes('password') ||
            t.name.toLowerCase().includes('token');

          window.pwRecord({
            type: 'input',
            selector: cssPath(t),
            value: sensitive ? '[MASKED]' : t.value,
            ts: Date.now()
          });
        });

        document.addEventListener('keydown', e => {
          window.pwRecord({
            type: 'keydown',
            key: e.key,
            ts: Date.now()
          });
        });
      })();
    `);

    await page.goto(BASE_URL);

    console.log('🎥 RECORDING... (JSON + Text formats) - Ctrl+C to stop');

    await new Promise((_, reject) => {
      process.on('SIGINT', async () => {
        save();
        await browser.close();
        reject(new Error('SIGINT'));
      });
    });
  }

  // =========================
  // 🔁 REPLAY MODE
  // =========================
  if (MODE === 'replay') {
    const data: Event[] = JSON.parse(
      fs.readFileSync(JSON_FILE, 'utf-8')
    );

    await page.goto(BASE_URL);
    console.log('🔁 REPLAYING...');

    let lastTs = data[0]?.ts || 0;

    for (const e of data) {
      await page.waitForTimeout(e.ts - lastTs);
      lastTs = e.ts;

      if (e.type === 'click') {
        await page.click(e.selector).catch(() =>
          console.warn('❌ click failed', e.selector)
        );
      }

      if (e.type === 'input') {
        if (e.value !== '[MASKED]') {
          await page.fill(e.selector, e.value).catch(() =>
            console.warn('❌ input failed', e.selector)
          );
        }
      }

      if (e.type === 'keydown') {
        await page.keyboard.press(e.key).catch(() =>
          console.warn('❌ key failed', e.key)
        );
      }
    }

    console.log('✅ REPLAY DONE');
    await page.waitForTimeout(5_000);
  }

  await browser.close();
})();
