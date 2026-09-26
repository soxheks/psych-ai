const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const baseURL = process.env.PREVIEW_URL || 'http://127.0.0.1:8000';

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
        await context.addInitScript(() => {
            const realFetch = window.fetch.bind(window);
            window.testRequests = [];
            window.testIncomplete = false;
            window.testRisk = false;
            window.testEnd = false;
            window.fetch = async (url, options) => {
                if (!String(url).endsWith('/api/chat/')) return realFetch(url, options);
                const request = Object.fromEntries(new URLSearchParams(options.body));
                window.testRequests.push(request);
                const prior = JSON.parse(request.memory);
                const memory = {
                    concern: prior.concern || request.message,
                    facts: [request.message], questions: ['最担心的是哪个部分？'],
                    answered: [{ question: '最担心的是哪个部分？', answer: '周五的演示' }], preference: 'listen',
                };
                const risk = window.testRisk;
                const incomplete = window.testIncomplete;
                const first = risk ? '先联系身边能够帮助你的人。' : '我听见你说周五要交演示。';
                const second = risk ? '现在先关注安全。' : '我们可以慢慢说。';
                const encoder = new TextEncoder();
                return new Response(new ReadableStream({
                    start(controller) {
                        const send = (event) => {
                            const bytes = encoder.encode(JSON.stringify(event) + '\n');
                            // Exercise UTF-8 decoding when a network chunk splits a Chinese character.
                            const boundary = bytes.findIndex((byte) => byte > 127) + 1;
                            controller.enqueue(bytes.slice(0, boundary));
                            controller.enqueue(bytes.slice(boundary));
                        };
                        send({ type: 'meta', stage: 'listen' });
                        send({ type: 'delta', text: first, provider: 'doubao' });
                        setTimeout(() => {
                            if (!incomplete) {
                                send({ type: 'delta', text: second, provider: 'doubao' });
                                send({ type: 'done', reply: first + second, stage: risk ? 'safety' : 'listen',
                                    provider: risk ? 'safety' : 'doubao', risk, action_card: null,
                                    action_status: '', ...(risk ? {} : { memory }) });
                            }
                            controller.close();
                            window.testEnd = true;
                        }, 450);
                    },
                }), { headers: { 'Content-Type': 'application/x-ndjson' } });
            };
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(baseURL + '/chat/');
        const input = page.locator('#messageInput');
        const button = page.locator('#sendButton');
        await input.fill('周五要交竞赛演示，我负责数据库。');
        await button.click();
        await page.waitForFunction(() => document.querySelector('.message.assistant:last-child .bubble')?.textContent === '我听见你说周五要交演示。');
        assert.equal(await page.evaluate(() => window.testEnd), false, 'first sentence must be visible before stream ends');
        await page.waitForFunction(() => !document.querySelector('#sendButton').disabled);
        assert.equal(await page.locator('.message.assistant .bubble').last().textContent(), '我听见你说周五要交演示。我们可以慢慢说。');
        assert.equal(await page.locator('#memorySummary').getAttribute('hidden'), null, 'memory summary should be available after the first reply');
        await page.locator('.composer-data-settings summary').click();
        assert.match(await page.locator('#memoryConcern').inputValue(), /数据库/);
        await page.locator('#memoryConcern').fill('周五演示，数据库由我负责。');
        await page.locator('#memoryConcern').press('Tab');

        for (let index = 0; index < 7; index++) {
            await input.fill(`继续聊聊第${index}个细节。`);
            await button.click();
            await page.waitForFunction(() => !document.querySelector('#sendButton').disabled);
        }
        const last = await page.evaluate(() => window.testRequests.at(-1));
        assert(!last.history.includes('我负责数据库'), 'original user turn should be outside the recent window');
        assert.equal(JSON.parse(last.memory).concern, '周五演示，数据库由我负责。', 'edited memory should reach later requests');
        assert.equal(await page.evaluate(() => localStorage.getItem('mindmate-chat-progress-v1')), null);

        await page.evaluate(() => { window.testIncomplete = true; });
        await input.fill('这句话需要重试。');
        await button.click();
        await page.waitForFunction(() => !document.querySelector('#sendButton').disabled);
        assert.equal(await page.locator('.message.assistant .bubble').last().textContent(), '我听见你说周五要交演示。');
        assert.match(await page.locator('#voiceNotice').textContent(), /中途断开/);
        assert.equal(await input.inputValue(), '这句话需要重试。');

        await page.evaluate(() => { window.testIncomplete = false; window.testRisk = true; });
        await input.fill('安全分流测试');
        await button.click();
        await page.waitForFunction(() => !document.querySelector('#sendButton').disabled);
        await input.fill('继续留在安全模式');
        await button.click();
        await page.waitForFunction(() => !document.querySelector('#sendButton').disabled);
        const safetyRequest = await page.evaluate(() => window.testRequests.at(-1));
        assert.equal(safetyRequest.memory, '{}');
        assert.equal(safetyRequest.history, '[]');

        await page.reload();
        await input.fill('新的一次聊天');
        await button.click();
        await page.waitForFunction(() => !document.querySelector('#sendButton').disabled);
        assert.equal(await page.evaluate(() => window.testRequests[0].memory), '{}');
        assert.deepEqual(errors, []);
        console.log('PASS: incremental UTF-8 stream, visible/editable memory, memory beyond six messages, no default storage, interrupted text preservation, crisis clearing and fresh-page isolation.');
    } finally {
        await browser.close();
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
