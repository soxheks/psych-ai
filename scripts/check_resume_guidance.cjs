const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const base = process.env.PREVIEW_URL || 'http://127.0.0.1:8004';

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    fs.mkdirSync('output/guidance-resume-2026-10-05', { recursive: true });
    try {
        for (const width of [1440, 390, 320]) {
            const context = await browser.newContext({ viewport: { width, height: 850 }, reducedMotion: 'reduce' });
            const page = await context.newPage();
            const requests = [];
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/api/chat/', route => {
                const payload = Object.fromEntries(new URLSearchParams(route.request().postData()));
                requests.push(payload);
                return route.fulfill({ json: {
                    reply: requests.length === 1 ? '我在听。' : '我们接着看刚才的困扰。',
                    provider: 'fallback', stage: requests.length === 1 ? 'listen' : 'clarify',
                    action_status: '', action_card: null, memory: { preference: requests.length === 1 ? 'listen' : 'clarify' },
                } });
            });
            await page.goto(base + '/chat/');
            await page.locator('#messageInput').fill('我只想说说，先别建议。');
            await page.locator('#sendButton').click();
            await page.waitForFunction(() => !pending);
            assert.ok(await page.locator('#resumeGuidance').isVisible());
            await page.locator('#messageInput').fill('还没写完的想法');
            await page.locator('#resumeGuidance').click();
            assert.equal(await page.locator('#messageInput').inputValue(), '还没写完的想法');
            assert.equal(requests.length, 1);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
            await page.screenshot({ path: `output/guidance-resume-2026-10-05/control-${width}.png` });
            await page.locator('#messageInput').fill('');
            await page.locator('#resumeGuidance').click();
            await page.waitForFunction(() => !pending);
            assert.equal(requests.length, 2);
            assert.equal(requests[1].message, '我现在想一起梳理，看看最困扰我的部分。');
            assert.equal(requests[1].conversation_intent, '');
            assert.ok(await page.locator('#resumeGuidance').isHidden());
            assert.equal(await page.locator('#dialogueStages li').nth(1).getAttribute('aria-current'), 'step');
            assert.deepEqual(errors, []);
            await context.close();
            console.log(`PASS ${width}px: pause/resume control, draft protection, stage 2 rendering`);
        }
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
