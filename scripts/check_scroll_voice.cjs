const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const baseURL = process.env.PREVIEW_URL || 'http://127.0.0.1:8003';
const output = path.resolve('output/companion-preview/scroll-voice');
fs.mkdirSync(output, { recursive: true });
const ending = '结尾检查：这句话应该可以完整看到。';
const longReply = Array.from({ length: 18 }, (_, index) =>
    '第 ' + (index + 1) + ' 段滚动测试：最近的任务可能有些多。可以先写下最挂心的一件事，再把今天能做的一小步说清楚。这里用较长的文字检查显示和滚动。'
).join('\n\n') + '\n\n' + ending;

async function geometry(page) {
    return page.evaluate(() => {
        const messages = document.querySelector('#messages');
        const region = messages.getBoundingClientRect();
        const composer = document.querySelector('.composer').getBoundingClientRect();
        const hit = document.elementFromPoint(composer.x + composer.width / 2, composer.top + 18);
        return {
            client: messages.clientHeight, scroll: messages.scrollHeight, top: messages.scrollTop,
            gap: messages.scrollHeight - messages.scrollTop - messages.clientHeight,
            regionBottom: region.bottom, composerTop: composer.top, composerBottom: composer.bottom,
            composerHit: Boolean(hit?.closest('.composer')),
            viewportHeight: innerHeight,
            horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        };
    });
}

async function assertBoundaries(page, label) {
    const data = await geometry(page);
    assert(data.regionBottom <= data.composerTop + 1, label + ': message region crosses composer');
    assert(data.composerHit, label + ': animated reply paints over composer');
    assert(data.composerBottom <= data.viewportHeight + 1, label + ': composer below viewport');
    assert(!data.horizontalOverflow, label + ': horizontal overflow');
    return data;
}

async function assertAtBottom(page) {
    await page.waitForFunction(() => {
        const el = document.querySelector('#messages');
        return el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
    });
    const tail = await page.locator('.message.assistant').last().locator('.bubble').evaluate((bubble) => {
        const node = bubble.firstChild;
        const range = document.createRange();
        range.setStart(node, Math.max(0, node.textContent.length - 16));
        range.setEnd(node, node.textContent.length);
        const line = range.getBoundingClientRect();
        const region = document.querySelector('#messages').getBoundingClientRect();
        const hit = document.elementFromPoint(line.x + 4, line.bottom - 3);
        return { visible: line.top >= region.top && line.bottom <= region.bottom + 1, hit: Boolean(hit?.closest('#messages')) };
    });
    assert(tail.visible && tail.hit, 'Final reply line must be visible and not covered');
}

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const context = await browser.newContext({ reducedMotion: 'reduce', deviceScaleFactor: 2 });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/api/chat/', (route) => route.fulfill({ json: { reply: longReply, provider: 'fallback' } }));
        for (const [width, height] of [[1440, 650], [1280, 620], [1440, 480], [390, 640], [320, 640]]) {
            await page.setViewportSize({ width, height });
            await page.goto(baseURL);
            const label = width + 'x' + height;
            const initial = await assertBoundaries(page, label + ' welcome');
            assert(initial.scroll > initial.client, label + ': expected overflowing welcome for this regression');
            const messagesBox = await page.locator('#messages').boundingBox();
            await page.mouse.move(messagesBox.x + messagesBox.width / 2, messagesBox.y + 50);
            await page.mouse.wheel(0, 2000);
            await page.waitForFunction(() => document.querySelector('#messages').scrollTop > 0);
            await page.mouse.wheel(0, 2000);
            await page.waitForTimeout(150);
            const greetingBottom = await page.locator('.welcome-bubble').evaluate((el) => el.getBoundingClientRect().bottom);
            assert(greetingBottom <= (await geometry(page)).regionBottom + 1, label + ': greeting end is inaccessible');
            await page.screenshot({ path: path.join(output, label + '-welcome.png') });

            await page.locator('#messageInput').fill('这是一条长回复的显示测试。');
            await page.locator('#sendButton').click();
            await page.waitForFunction(() => !document.querySelector('#sendButton').disabled);
            assert.equal(await page.locator('.message.assistant').last().locator('.bubble').textContent(), longReply);
            await assertAtBottom(page);
            await assertBoundaries(page, label + ' reply');
            await page.screenshot({ path: path.join(output, label + '-reply.png') });

            await page.locator('#messageInput').fill('第一行草稿\n第二行草稿\n第三行草稿\n第四行草稿\n第五行草稿\n第六行草稿');
            await assertAtBottom(page);
            await assertBoundaries(page, label + ' expanded composer');
            const bottom = (await geometry(page)).top;
            await page.mouse.move(messagesBox.x + 60, messagesBox.y + 60);
            await page.mouse.wheel(0, -350);
            await page.waitForFunction((value) => document.querySelector('#messages').scrollTop < value - 80, bottom);
            const manuallyScrolled = (await geometry(page)).top;
            await page.waitForTimeout(200);
            assert(Math.abs((await geometry(page)).top - manuallyScrolled) < 2, 'Manual upward scrolling must be respected');
            console.log(label + ': welcome wheel, long reply, clipping, expanded input, manual reading passed');
        }

        await page.setViewportSize({ width: 1280, height: 620 });
        await page.goto(baseURL);
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.locator('#messageInput').fill('逐字回复滚动测试。');
        await page.locator('#sendButton').click();
        await page.waitForFunction(() => document.querySelector('#companion').dataset.state === 'speaking');
        await page.waitForTimeout(1800);
        await assertBoundaries(page, 'animated reply');
        const bounds = await page.locator('#messages').boundingBox();
        await page.mouse.move(bounds.x + 50, bounds.y + 60);
        await page.mouse.wheel(0, -500);
        await page.waitForTimeout(180);
        const readingTop = (await geometry(page)).top;
        await page.waitForFunction(() => !document.querySelector('#sendButton').disabled);
        assert(Math.abs((await geometry(page)).top - readingTop) < 2, 'Growing text must not pull the reader back down');
        await page.mouse.wheel(0, 20000);
        await assertAtBottom(page);
        await page.setViewportSize({ width: 1280, height: 480 });
        await assertAtBottom(page);
        await assertBoundaries(page, 'resized completed reply');
        assert.deepEqual(errors, []);
        await context.close();

        const voiceContext = await browser.newContext({ reducedMotion: 'reduce' });
        await voiceContext.addInitScript(() => {
            window.__voices = [
                { name: 'Microsoft Kangkang - Chinese', lang: 'zh-CN', localService: true },
                { name: 'Microsoft Huihui - Chinese', lang: 'zh-CN', localService: true },
                { name: 'Microsoft Yaoyao - Chinese', lang: 'zh-CN', localService: true },
            ];
            window.__voiceCalls = [];
            class MockSpeech extends EventTarget {
                getVoices() { return window.__voices; }
                cancel() { window.__currentVoice = null; }
                speak(item) {
                    window.__currentVoice = item;
                    window.__voiceCalls.push({ text: item.text, name: item.voice.name, pitch: item.pitch, rate: item.rate, volume: item.volume });
                    item.onstart?.();
                }
            }
            Object.defineProperty(window, 'speechSynthesis', { value: new MockSpeech() });
            window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
        });
        const voicePage = await voiceContext.newPage();
        await voicePage.goto(baseURL);
        await voicePage.locator('#voicePreview').click();
        await voicePage.waitForFunction(() => window.__voiceCalls.length === 1);
        const sample = await voicePage.evaluate(() => window.__voiceCalls[0]);
        assert.match(sample.name, /Yaoyao/);
        assert.equal(sample.pitch, 1.22);
        assert.equal(sample.rate, 1.02);
        assert.equal(await voicePage.locator('#voiceToggle').getAttribute('aria-pressed'), 'false', 'Preview must not enable automatic reading');
        assert.equal(await voicePage.locator('.message.user').count(), 0);
        await voicePage.locator('#voicePreview').click();
        assert.equal(await voicePage.evaluate(() => window.__currentVoice), null);

        await voicePage.evaluate(() => { window.__savedVoices = window.__voices; window.__voices = []; });
        await voicePage.locator('#voicePreview').click();
        await voicePage.locator('#voicePreview').click();
        await voicePage.evaluate(() => {
            window.__voices = window.__savedVoices;
            speechSynthesis.dispatchEvent(new Event('voiceschanged'));
        });
        await voicePage.waitForTimeout(100);
        assert.equal(await voicePage.evaluate(() => window.__voiceCalls.length), 1, 'Cancelled voice loading must stay cancelled');

        await voicePage.evaluate(() => { window.__voices = []; });
        await voicePage.locator('#voicePreview').click();
        await voicePage.evaluate(() => {
            window.__voices = window.__savedVoices;
            speechSynthesis.dispatchEvent(new Event('voiceschanged'));
        });
        await voicePage.waitForFunction(() => window.__voiceCalls.length === 2);
        await voicePage.evaluate(() => window.__currentVoice.onend());
        assert.equal(await voicePage.locator('#voicePreview').getAttribute('aria-pressed'), 'false');

        await voicePage.route('**/api/chat/', (route) => route.fulfill({ json: { reply: '测试回复，也使用同一套角色声线。', provider: 'fallback' } }));
        await voicePage.locator('#voiceToggle').click();
        await voicePage.locator('#messageInput').fill('请回答。');
        await voicePage.locator('#sendButton').click();
        await voicePage.waitForFunction(() => window.__voiceCalls.length === 3);
        assert.match((await voicePage.evaluate(() => window.__voiceCalls[2])).name, /Yaoyao/);
        await voicePage.locator('#voiceToggle').click();

        await voicePage.evaluate(() => { window.__voices = []; });
        await voicePage.locator('#voicePreview').click();
        await voicePage.waitForFunction(() => document.querySelector('#voiceNotice').textContent.includes('没有可用的中文声音'));
        assert.equal(await voicePage.locator('#voicePreview').getAttribute('aria-pressed'), 'false');
        await voiceContext.close();

        // Inspect the installed browser voices, while intercepting output to avoid playing test audio.
        const actualPage = await browser.newPage();
        await actualPage.addInitScript(() => {
            Object.defineProperty(speechSynthesis, 'speak', { value: (item) => {
                window.__actualSelection = { name: item.voice.name, pitch: item.pitch, rate: item.rate };
                item.onstart?.();
                item.onend?.();
            } });
        });
        await actualPage.goto(baseURL);
        await actualPage.waitForFunction(() => speechSynthesis.getVoices().some((voice) => /^zh/i.test(voice.lang)));
        await actualPage.locator('#voicePreview').click();
        await actualPage.waitForFunction(() => window.__actualSelection);
        const actualSelection = await actualPage.evaluate(() => window.__actualSelection);
        assert.match(actualSelection.name, /Yaoyao/);
        fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ passed: true, actualSelection, errors }, null, 2));
        console.log('Voice checks passed:', JSON.stringify(actualSelection));
        console.log('PASS: initial scrolling, long/animated replies, scroll preservation, viewport/input resizing, voice selection, preview, delayed voices and cancellation.');
    } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
