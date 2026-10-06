const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');

const base = process.env.PREVIEW_URL || 'http://127.0.0.1:8006';
const output = process.env.RECOVERY_OUTPUT || 'output/action-recovery-2026-10-06';

(async () => {
    fs.mkdirSync(output, { recursive: true });
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const records = [];
    try {
        for (const width of [1440, 390, 320]) {
            for (const mode of ['stuck', 'smaller']) {
                const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
                const page = await context.newPage();
                const errors = [];
                let outcomes = 0;
                page.on('pageerror', error => errors.push(error.message));
                page.on('request', request => { if (request.url().endsWith('/api/outcomes/')) outcomes++; });
                async function observe() {
                    await page.evaluate(() => {
                        window.qaReplies = [];
                        const original = readChatResponse;
                        readChatResponse = async (...args) => {
                            try {
                                const result = await original(...args);
                                window.qaReplies.push(result.data);
                                return result;
                            } catch (error) {
                                window.qaReplies.push({ error: error.message });
                                throw error;
                            }
                        };
                    });
                }
                async function submit(message, selector = '#sendButton') {
                    const count = await page.evaluate(() => window.qaReplies.length);
                    if (message !== null) await page.locator('#messageInput').fill(message);
                    await page.locator(selector).click();
                    await page.waitForFunction(count => window.qaReplies.length > count && !pending, count, { timeout: 55000 });
                    const data = await page.evaluate(() => window.qaReplies.at(-1));
                    assert.ok(!data.error, data.error);
                    assert.ok(!data.interrupted);
                    assert.equal(await page.locator('.message.assistant .bubble').last().textContent(), data.reply);
                    records.push({ width, mode, ...data });
                    fs.writeFileSync(`${output}/transcripts.json`, JSON.stringify(records, null, 2));
                    return data;
                }
                await page.goto(`${base}/chat/`);
                await observe();
                let data = await submit('我在备考，帮我选一个小步骤。');
                assert.equal(data.stage, 'control');
                await page.locator('.action-accept').click();
                const originalStep = await page.locator('.action-step').textContent();
                await page.locator('.action-start').click();
                assert.equal(await page.locator('.action-complete').isEnabled(), true);
                await page.locator('.composer-data-settings summary').click();
                await page.locator('#progressConsent').check();
                await page.locator('.composer-data-settings summary').click();
                data = await submit(null, `.action-${mode}`);
                assert.equal(data.stage, 'action');
                assert.equal(data.action_revision, null);
                assert.equal(await page.locator('.action-step').textContent(), originalStep);
                assert.equal(await page.locator('.action-complete').isEnabled(), true);
                assert.equal(await page.locator('.action-start').textContent(), '试试简化版');
                assert.equal(await page.locator('.action-complete').evaluate(button => getComputedStyle(button).pointerEvents), 'auto');
                assert.equal(await page.locator('.action-card.is-following-up').count(), 0);
                assert.equal(await page.locator('.completion-summary').count(), 0);
                await page.reload();
                await observe();
                assert.equal(await page.locator('.action-complete').isEnabled(), true, 'restored difficulty must remain completable');
                data = await submit(null, '.action-start');
                assert.ok(data.action_revision);
                assert.equal(data.action_revision.from_step, originalStep);
                assert.equal(data.action_status, 'selected');
                assert.equal(await page.locator('.action-card').count(), 1, 'revise the chosen card in place');
                assert.equal(await page.locator('.action-step').textContent(), data.action_revision.step);
                assert.equal(await page.locator('.action-start').isEnabled(), true);
                await page.locator('.action-start').click();
                assert.equal(await page.locator('.action-complete').isEnabled(), true);
                data = await submit(null, '.action-smaller');
                assert.equal(data.stage, 'action');
                data = await submit('好');
                assert.equal(data.memory.action_recovery.level, 2);
                const simplifiedStep = data.action_revision.step;
                assert.equal(await page.locator('.action-step').textContent(), simplifiedStep);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                await page.locator('.action-card').scrollIntoViewIfNeeded();
                await page.screenshot({ path: `${output}/simplified-${mode}-${width}.png` });
                await page.locator('#messageInput').fill('这段草稿先留着。');
                const count = await page.evaluate(() => window.qaReplies.length);
                await page.locator('.action-complete').click();
                assert.equal(await page.locator('#messageInput').inputValue(), '这段草稿先留着。');
                assert.equal(await page.evaluate(() => window.qaReplies.length), count);
                await page.locator('#messageInput').fill('');
                data = await submit(null, '.action-complete');
                assert.equal(data.action_status, 'completed');
                assert.equal(await page.locator('#dialogueStages [data-stage="action"].complete').count(), 1);
                assert.equal(await page.locator('.completion-summary').count(), 1);
                assert.ok((await page.locator('.completion-action').textContent()).includes(simplifiedStep));
                assert.equal(await page.locator('.action-complete').isDisabled(), true);
                assert.equal(outcomes, 0, 'synthetic tests must not submit outcome records');
                assert.deepEqual(errors, []);
                await context.close();
                console.log(`PASS ${width}px ${mode}: comfort, reload, two simplifications, start, draft protection and completion`);
            }
        }
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
