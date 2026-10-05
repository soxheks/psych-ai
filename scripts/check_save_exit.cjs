const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fs = require('node:fs');
const base = process.env.PREVIEW_URL || 'http://127.0.0.1:8000';
const output = 'output/save-exit-2026-10-05';

(async () => {
    fs.mkdirSync(output, { recursive: true });
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        for (const width of [1440, 390, 320]) {
            const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/api/chat/', async route => {
                await new Promise(resolve => setTimeout(resolve, 700));
                const reply = '最近一次走神前，你正在想什么？';
                const events = [
                    { type: 'meta', stage: 'clarify' },
                    { type: 'delta', text: reply, provider: 'doubao' },
                    { type: 'done', reply, stage: 'clarify', provider: 'doubao', risk: false,
                        memory: { concern: '上课走神', facts: ['最近上课走神很焦虑。'] }, action_status: '', action_card: null },
                ];
                await route.fulfill({ contentType: 'application/x-ndjson', body: events.map(event => JSON.stringify(event)).join('\n') + '\n' });
            });
            await page.goto(base + '/chat/');
            await page.locator('.composer-data-settings summary').click();
            await page.locator('#saveAndExit').click();
            assert.match(await page.locator('#privacyStatus').innerText(), /先确认开启/);
            assert.equal(await page.evaluate(() => localStorage.getItem('mindmate-chat-progress-v1')), null);
            await page.locator('#progressConsent').check();
            await page.locator('#messageInput').fill('最近上课走神很焦虑。');
            await page.locator('#saveAndExit').click();
            assert.match(await page.locator('#privacyStatus').innerText(), /未发送/);
            await page.locator('#sendButton').click();
            await page.locator('#saveAndExit').click();
            assert.match(await page.locator('#privacyStatus').innerText(), /回复还在生成/);
            await page.waitForFunction(() => !document.querySelector('#sendButton').disabled);
            await page.locator('#memoryConcern').fill('上课走神，担心跟不上。');
            await page.locator('#memoryConcern').press('Tab');
            await page.locator('#saveAndExit').scrollIntoViewIfNeeded();
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
            assert.ok(await page.locator('.data-settings-body').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'settings must not clip text horizontally');
            await page.screenshot({ path: `${output}/settings-${width}.png` });
            await page.locator('#saveAndExit').click();
            await page.waitForURL(base + '/');
            await page.goto(base + '/chat/');
            assert.match(await page.locator('#messages').innerText(), /最近上课走神很焦虑/);
            assert.match(await page.locator('#privacyStatus').textContent(), /恢复上次进度/);
            assert.equal(await page.locator('#memoryConcern').inputValue(), '上课走神，担心跟不上。');
            assert.equal(await page.locator('#metricsConsent').isChecked(), false);
            await page.locator('.composer-data-settings summary').click();
            await page.evaluate(() => {
                window.originalSetItem = Storage.prototype.setItem;
                Storage.prototype.setItem = () => { throw new DOMException('Blocked', 'QuotaExceededError'); };
            });
            await page.locator('#saveAndExit').click();
            assert.match(await page.locator('#privacyStatus').innerText(), /保存未成功/);
            assert.equal(new URL(page.url()).pathname, '/chat/');
            await page.evaluate(() => { Storage.prototype.setItem = window.originalSetItem; });
            await page.locator('#clearLocalProgress').click();
            assert.equal(await page.evaluate(() => localStorage.getItem('mindmate-chat-progress-v1')), null);
            await page.locator('#progressConsent').check();
            await page.evaluate(() => enterSafetyMode({ risk: true, risk_state: 'active' }));
            await page.locator('#saveAndExit').click();
            assert.match(await page.locator('#privacyStatus').innerText(), /安全支持内容不会保存/);
            assert.equal(await page.evaluate(() => localStorage.getItem('mindmate-chat-progress-v1')), null);
            assert.equal(new URL(page.url()).pathname, '/chat/');
            assert.deepEqual(errors, []);
            await context.close();
            console.log(`PASS ${width}px: consent, draft, pending, save, restore, storage failure, deletion, safety, layout`);
        }
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
