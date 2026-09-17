const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const baseURL = process.env.PREVIEW_URL || 'http://127.0.0.1:8000';
const landingURL = new URL('/', baseURL).toString();
const journalURL = new URL('/journal/', baseURL).toString();

async function waitForPageCache(page) {
    const startedAt = Date.now();
    await page.waitForFunction(async () => {
        if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return false;
        const cache = await caches.open('mindmate-pages-v1');
        const pages = await Promise.all(['/', '/chat/', '/journal/']
            .map((path) => cache.match(path, { ignoreVary: true })));
        return pages.every(Boolean);
    }, null, { timeout: 10000 });
    return Date.now() - startedAt;
}

async function measureTransition(page, selector, expectedURL) {
    const target = page.locator(selector);
    const bounds = await target.boundingBox();
    assert(bounds, `missing transition target: ${selector}`);
    const startedAt = Date.now();
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.waitForURL(expectedURL, { timeout: 3000 });
    const navigationMs = Date.now() - startedAt;
    await page.waitForFunction(() => !document.querySelector('.page-transition')?.classList.contains('is-arriving'));
    return {
        navigationMs,
        completeMs: Date.now() - startedAt,
    };
}

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));

        await page.goto(landingURL);
        const cacheReadyMs = await waitForPageCache(page);
        await page.locator('.button-secondary').hover();
        await page.waitForFunction(() => [...document.querySelectorAll('link[rel="prefetch"]')]
            .some((link) => new URL(link.href).pathname === '/journal/'));

        const desktop = await measureTransition(page, '.button-secondary', journalURL);
        assert(desktop.navigationMs < 600, `desktop navigation took ${desktop.navigationMs}ms`);
        assert(desktop.completeMs < 1100, `desktop transition took ${desktop.completeMs}ms`);

        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(landingURL);
        const mobile = await measureTransition(page, '.button-secondary', journalURL);
        assert(mobile.navigationMs < 600, `mobile navigation took ${mobile.navigationMs}ms`);
        assert.equal(await page.locator('.transition-rail-two').evaluate((element) => getComputedStyle(element).display), 'none');

        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.goto(landingURL);
        const reducedStartedAt = Date.now();
        await page.locator('.button-secondary').click();
        await page.waitForURL(journalURL, { timeout: 2000 });
        const reducedMotionMs = Date.now() - reducedStartedAt;
        assert(reducedMotionMs < 350, `reduced-motion navigation took ${reducedMotionMs}ms`);

        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ cacheReadyMs, desktop, mobile, reducedMotionMs, errors }, null, 2));
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
