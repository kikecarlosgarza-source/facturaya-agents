async function explorarPortal({ portal, urlPista }) {
  let chromium;
  try {
    const playwrightExtra = require('playwright-extra');
    const stealth = require('puppeteer-extra-plugin-stealth')();
    chromium = playwrightExtra.chromium;
    chromium.use(stealth);
    console.log(`[REINO B] Scout: usando playwright-extra + stealth`);
  } catch (e) {
    console.warn(`[REINO B] Scout: playwright-extra no disponible, fallback a playwright base (${e.message})`);
    chromium = require('playwright').chromium;
  }

  let browser;
  const xhrCalls = [];

  try {
    browser = await chromium.launch({ headless: true, timeout: 60000 });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    page.on('request', req => {
      const t = req.resourceType();
      if (t === 'xhr' || t === 'fetch') {
        xhrCalls.push({ url: req.url(), method: req.method() });
      }
    });

    await page.goto(urlPista, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);

    const url = page.url();
    const titulo = await page.title().catch(() => '');

    const dom = await page.evaluate(() => {
      const isVisible = el => !!(el && el.offsetParent !== null);

      const inputs = Array.from(document.querySelectorAll('input'))
        .filter(isVisible)
        .map(i => ({
          name: i.name || null,
          id: i.id || null,
          type: i.type || 'text',
          placeholder: i.placeholder || null,
          maxlength: i.maxLength > 0 ? i.maxLength : null
        }));

      const selects = Array.from(document.querySelectorAll('select'))
        .filter(isVisible)
        .map(s => ({
          name: s.name || null,
          id: s.id || null,
          options: Array.from(s.options).slice(0, 30).map(o => ({ value: o.value, text: (o.text || '').trim().substring(0, 80) }))
        }));

      const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]'))
        .filter(isVisible)
        .map(b => {
          const selector = b.id ? `#${b.id}` : (b.name ? `[name="${b.name}"]` : '');
          return {
            texto: (b.textContent || b.value || '').trim().substring(0, 80),
            selector
          };
        });

      const forms = Array.from(document.querySelectorAll('form')).map(f => ({
        action: f.action || null,
        method: (f.method || 'GET').toUpperCase(),
        name: f.name || null,
        id: f.id || null
      }));

      const captchaSelectors = [
        '#captcha',
        'img[id*="aptcha" i]',
        'iframe[src*="recaptcha"]',
        'iframe[src*="hcaptcha"]',
        '[data-sitekey]'
      ];
      const hasCaptcha = captchaSelectors.some(sel => document.querySelector(sel));

      let framework = 'vanilla';
      if (window.angular || document.querySelector('[ng-app], [ng-controller], [ng-version]')) framework = 'angular';
      else if (window.React || document.querySelector('[data-reactroot], #__next')) framework = 'react';
      else if (window.Vue) framework = 'vue';

      const shadowHosts = Array.from(document.querySelectorAll('*')).filter(el => el.shadowRoot).length;

      return { inputs, selects, buttons, forms, hasCaptcha, framework, shadowHosts };
    });

    const cookies = await context.cookies();

    return {
      portal,
      url,
      titulo,
      inputs: dom.inputs,
      selects: dom.selects,
      buttons: dom.buttons,
      forms: dom.forms,
      xhrCalls: xhrCalls.slice(0, 50),
      hasCaptcha: dom.hasCaptcha,
      framework: dom.framework,
      shadowHosts: dom.shadowHosts,
      cookieNames: cookies.map(c => c.name)
    };
  } catch (err) {
    return { error: err.message, portal, urlPista };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { explorarPortal };
