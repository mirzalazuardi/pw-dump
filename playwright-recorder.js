#!/usr/bin/env node
const { chromium } = require('playwright');
const fs = require('fs');

const MODE = process.env.MODE || 'record';
const SESSION_DIR = process.env.PLAYWRIGHT_SESSION_DIR || 'sessions';
const JSON_FILE = `${SESSION_DIR}/${process.env.PLAYWRIGHT_JSON || 'session.json'}`;
const TEXT_FILE = `${SESSION_DIR}/${process.env.PLAYWRIGHT_TEXT || 'session.txt'}`;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const events = [];

function save() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  
  // Save JSON
  fs.writeFileSync(JSON_FILE, JSON.stringify(events, null, 2));
  
  // Generate filtered text log
  const textOutput = events
    .filter(e => {
      if (e.type === 'network-request' || e.type === 'network-response') {
        const url = e.url.toLowerCase();
        const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.woff', '.woff2'];
        return !imageExts.some(ext => url.includes(ext));
      }
      return true;
    })
    .map(e => {
      if (e.type === 'network-request') {
        const body = e.postData ? ` | Body: ${e.postData.substring(0, 80)}${e.postData.length > 80 ? '...' : ''}` : '';
        return `[REQUEST] ${e.method} ${e.url}${body}`;
      }
      if (e.type === 'network-response') {
        return `[RESPONSE] ${e.status} ${e.url}`;
      }
      if (e.type === 'click') {
        if (e.selector.toLowerCase().match(/(img|svg|icon|image|logo)/)) return '';
        return `[CLICK] ${e.selector}`;
      }
      if (e.type === 'input') {
        return `[INPUT] ${e.selector} = ${e.value}`;
      }
      if (e.type === 'keydown') {
        return `[KEY] ${e.key}`;
      }
      return '';
    })
    .filter(line => line && line.trim())
    .join('\n');

  fs.writeFileSync(TEXT_FILE, textOutput);
  
  console.log('\n💾 Session saved:');
  console.log(`   JSON : ${JSON_FILE}`);
  console.log(`   Text : ${TEXT_FILE}`);
  console.log(`   Events: ${events.length} total | ${events.filter(e => e.type.startsWith('network')).length} network`);
}

(async () => {
  const browser = await chromium.launch({ 
    headless: false,
    args: ['--disable-gpu', '--no-sandbox']
  });
  
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Playwright Recorder)'
  });
  
  const page = await context.newPage();

  // RECORD MODE
  if (MODE === 'record') {
    await page.exposeFunction('pwRecord', (e) => {
      events.push(e);
      if (e.type.startsWith('network')) {
        const prefix = e.type === 'network-request' ? '📤' : '📥';
        const details = e.type === 'network-request' 
          ? `${e.method} ${e.url.substring(0, 60)}${e.url.length > 60 ? '...' : ''}`
          : `${e.status} ${e.url.substring(0, 60)}${e.url.length > 60 ? '...' : ''}`;
        console.log(`${prefix} ${details}`);
      }
    });

    // Network listeners
    page.on('request', req => {
      if (!req.url().startsWith('data:')) {
        events.push({
          type: 'network-request',
          method: req.method(),
          url: req.url(),
          postData: req.postData() || null,
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

    // Inject recording script
    await page.addInitScript(() => {
      function cssPath(el) {
        if (!el || !el.tagName) return 'unknown';
        let path = el.tagName.toLowerCase();
        if (el.id) return `#${el.id}`;
        if (el.className && typeof el.className === 'string' && el.className.trim()) {
          const classes = el.className.trim().split(/\s+/).join('.');
          path += `.${classes}`;
        }
        return path;
      }

      document.addEventListener('click', e => {
        if (!e.target) return;
        window.pwRecord({
          type: 'click',
          selector: cssPath(e.target),
          ts: Date.now()
        });
      });

      document.addEventListener('input', e => {
        const t = e.target;
        if (!t || !t.name) return;
        
        const sensitive = 
          t.type === 'password' || 
          t.name.toLowerCase().includes('password') || 
          t.name.toLowerCase().includes('token') ||
          t.name.toLowerCase().includes('secret');
        
        window.pwRecord({
          type: 'input',
          selector: cssPath(t),
          value: sensitive ? '[MASKED]' : (t.value || ''),
          ts: Date.now()
        });
      });

      document.addEventListener('keydown', e => {
        // Only record meaningful keys
        if (e.key.length === 1 || ['Enter', 'Tab', 'Escape', 'Backspace'].includes(e.key)) {
          window.pwRecord({
            type: 'keydown',
            key: e.key,
            ts: Date.now()
          });
        }
      });
    });

    console.log('🎥 STARTING RECORDING MODE');
    console.log(`🌐 Target: ${BASE_URL}`);
    console.log(`📁 Output: ${SESSION_DIR}/`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('💡 INSTRUCTIONS:');
    console.log('   • Perform actions in the browser window');
    console.log('   • Press CTRL+C to stop recording and save session');
    console.log('   • Sensitive fields (password/token) are automatically masked');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Handle shutdown
    process.on('SIGINT', async () => {
      console.log('\n🛑 Stopping recording...');
      save();
      await browser.close();
      process.exit(0);
    });

    // Keep alive
    await new Promise(() => {});
  }

  // REPLAY MODE
  if (MODE === 'replay') {
    if (!fs.existsSync(JSON_FILE)) {
      console.error(`❌ FATAL: Session file not found: ${JSON_FILE}`);
      console.error('💡 Run in RECORD mode first: MODE=record node playwright-recorder.js');
      await browser.close();
      process.exit(1);
    }

    const data = JSON.parse(fs.readFileSync(JSON_FILE, 'utf-8'));
    console.log(`🔁 STARTING REPLAY MODE (${data.length} events)`);
    console.log(`🌐 Target: ${BASE_URL}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    
    let lastTs = data[0]?.ts || Date.now();
    let successCount = 0;
    let failCount = 0;

    for (const e of data) {
      // Wait proportional to original timing
      const delay = Math.min(Math.max(e.ts - lastTs, 0), 2000);
      if (delay > 10) await page.waitForTimeout(delay);
      lastTs = e.ts;

      try {
        if (e.type === 'click') {
          await page.click(e.selector, { timeout: 3000 });
          successCount++;
        } else if (e.type === 'input' && e.value !== '[MASKED]') {
          await page.fill(e.selector, e.value, { timeout: 3000 });
          successCount++;
        } else if (e.type === 'keydown') {
          await page.keyboard.press(e.key, { timeout: 1000 });
          successCount++;
        }
      } catch (err) {
        failCount++;
        if (process.env.DEBUG) {
          console.warn(`⚠️  Failed ${e.type} (${e.selector || e.key}): ${err.message}`);
        }
      }
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`✅ REPLAY COMPLETE: ${successCount} succeeded | ${failCount} failed`);
    console.log('💡 Keeping browser open for 10 seconds to observe result...');
    await page.waitForTimeout(10000);
  }

  await browser.close();
})();
