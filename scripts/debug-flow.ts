import { chromium } from 'playwright';
import fs from 'fs';

type LogEntry = {
  type: 'click' | 'input' | 'keydown' | 'network';
  timestamp: string;
  data: any;
};

const logs: LogEntry[] = [];

function log(type: LogEntry['type'], data: any) {
  logs.push({
    type,
    timestamp: new Date().toISOString(),
    data,
  });
}

(async () => {
  const browser = await chromium.launch({
    headless: false,
    slowMo: 50,
  });

  const page = await browser.newPage();

  // ===============================
  // NETWORK (FILTER DOMAIN)
  // ===============================
  page.on('request', req => {
    if (!req.url().includes('example.com')) return;

    log('network', {
      method: req.method(),
      url: req.url(),
      postData: req.postData(),
    });
  });

  page.on('response', res => {
    if (!res.url().includes('example.com')) return;

    log('network', {
      status: res.status(),
      url: res.url(),
    });
  });

  // ===============================
  // EXPOSE LOGGER TO BROWSER
  // ===============================
  await page.exposeFunction('pwLog', (entry: LogEntry) => {
    logs.push(entry);
  });

  // ===============================
  // INJECT BROWSER SCRIPT (STRING!)
  // ===============================
  await page.addInitScript(`
    (() => {
      document.addEventListener('click', e => {
        const t = e.target;
        if (!t) return;

        window.pwLog({
          type: 'click',
          timestamp: new Date().toISOString(),
          data: {
            tag: t.tagName,
            id: t.id,
            class: t.className,
            text: t.innerText ? t.innerText.slice(0, 50) : null
          }
        });
      });

      document.addEventListener('input', e => {
        const el = e.target;
        if (!el) return;

        const sensitive =
          el.type === 'password' ||
          (el.name && el.name.toLowerCase().includes('password')) ||
          (el.name && el.name.toLowerCase().includes('token'));

        window.pwLog({
          type: 'input',
          timestamp: new Date().toISOString(),
          data: {
            name: el.name,
            value: sensitive ? '[MASKED]' : el.value
          }
        });
      });

      document.addEventListener('keydown', e => {
        window.pwLog({
          type: 'keydown',
          timestamp: new Date().toISOString(),
          data: { key: e.key }
        });
      });
    })();
  `);

  // ===============================
  // START
  // ===============================
  await page.goto('https://example.com');

  console.log('🟢 Interact with browser (60s)…');
  await page.waitForTimeout(60_000);

  fs.writeFileSync(
    'debug-output.json',
    JSON.stringify(logs, null, 2)
  );

  console.log('✅ debug-output.json saved');
  await browser.close();
})();

