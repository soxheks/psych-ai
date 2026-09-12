const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const baseURL = process.env.PREVIEW_URL || 'http://127.0.0.1:8003';
const output = path.resolve('output/companion-preview');
fs.mkdirSync(output, { recursive: true });

async function checkLayout(page, width, height, label) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: path.join(output, label + '.png'), fullPage: true });
    const layout = await page.evaluate(() => {
        const rect = (selector) => {
            const box = document.querySelector(selector).getBoundingClientRect();
            return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
        };
        return {
            width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
            stage: rect('.character-stage'), messages: rect('#messages'), composer: rect('.composer'),
            header: rect('.chat-header'), companion: rect('#companion'),
            textOverflow: [...document.querySelectorAll('button, h1, h2, .companion-caption')].some((el) => el.scrollWidth > el.clientWidth + 2),
        };
    });
    assert(layout.scrollWidth <= width, label + ': horizontal overflow');
    assert(!layout.textOverflow, label + ': overflowing text');
    assert(layout.stage.width > 80 && layout.stage.height > 80, label + ': character too small');
    assert(layout.composer.bottom <= height + 1, label + ': input below viewport');
    assert(layout.messages.height > 100, label + ': chat area too short');
    assert(layout.messages.bottom <= layout.composer.y + 1, label + ': messages overlap input');
    const separated = layout.companion.x >= layout.messages.right - 1 || layout.companion.bottom <= layout.messages.y + 1;
    assert(separated, label + ': companion overlaps conversation');
    console.log(label + ': layout passed');
}

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        await context.addInitScript(() => {
            window.__spoken = [];
            window.__voices = [{ lang: 'zh-CN', localService: true, name: 'Test Chinese voice' }];
            Object.defineProperty(window, 'speechSynthesis', { value: {
                getVoices: () => window.__voices,
                cancel: () => { window.__speech = null; },
                speak: (item) => { window.__spoken.push(item.text); window.__speech = item; item.onstart?.(); },
            } });
            window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(baseURL);
        await page.locator('.character-sprite').waitFor();
        const assetURL = await page.locator('.character-sprite').evaluate((element) => getComputedStyle(element).backgroundImage.match(/url\(["']?([^"')]+)/)[1]);
        const asset = await page.request.get(assetURL);
        assert.equal(asset.status(), 200);
        assert((await asset.body()).length > 10000);
        const imageStats = await page.evaluate(async (url) => {
            const image = new Image();
            image.src = url;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(image, 0, 0);
            const occupied = [];
            for (let row = 0; row < 2; row++) {
                for (let col = 0; col < 2; col++) {
                    const data = ctx.getImageData(col * image.width / 2, row * image.height / 2, image.width / 2, image.height / 2).data;
                    let dark = 0;
                    for (let i = 0; i < data.length; i += 4) if (Math.min(data[i], data[i + 1], data[i + 2]) < 180) dark++;
                    occupied.push(dark / (data.length / 4));
                }
            }
            return { width: image.width, height: image.height, occupied };
        }, assetURL);
        assert(imageStats.occupied.every((ratio) => ratio > .02 && ratio < .6), 'All four sprites must contain a character');
        console.log('Sprite pixels:', JSON.stringify(imageStats));
        for (const viewport of [[1440, 900, 'desktop'], [1024, 768, 'tablet-landscape'], [768, 1024, 'tablet'], [390, 844, 'mobile'], [320, 640, 'small-mobile']]) {
            await checkLayout(page, ...viewport);
        }
        await page.setViewportSize({ width: 1440, height: 900 });
        const scenario = page.locator('[data-scenario="research"]');
        const originalScenarioWidth = await scenario.evaluate((el) => el.offsetWidth);
        await scenario.hover();
        await page.waitForTimeout(260);
        assert.notEqual(await scenario.evaluate((el) => getComputedStyle(el).transform), 'none', 'Scenario hover should move gently');
        assert.equal(await scenario.evaluate((el) => el.offsetWidth), originalScenarioWidth, 'Hover must not resize the layout');
        await scenario.click();
        assert.equal(await scenario.getAttribute('aria-pressed'), 'true');
        assert.equal(await scenario.locator('.tap-ripple').count(), 1, 'Click ripple should be present');

        const mood = page.locator('.mood-option').first();
        const previousMessageCount = await page.locator('.message').count();
        await mood.hover();
        await page.waitForTimeout(260);
        assert.notEqual(await mood.evaluate((el) => getComputedStyle(el).transform), 'none', 'Mood hover should lift');
        await mood.click();
        assert.equal(await page.locator('#messageInput').inputValue(), await mood.getAttribute('data-prompt'));
        assert.equal(await mood.getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('.scenario.active').count(), 0, 'Mood drafts must not inherit an academic scenario');
        assert.equal(await page.locator('.message').count(), previousMessageCount, 'Mood selection must not send a message');

        const character = page.locator('#characterGreeting');
        const stageBounds = await character.boundingBox();
        await character.hover({ position: { x: stageBounds.width * .8, y: stageBounds.height * .35 } });
        await page.waitForFunction(() => document.querySelector('.character-look').style.getPropertyValue('--look-x') !== '');
        assert.notEqual(await page.locator('.character-look').evaluate((el) => el.style.getPropertyValue('--look-x')), '0.00px');
        await character.click();
        assert.equal(await page.locator('#companion').getAttribute('data-state'), 'greeting');
        await page.screenshot({ path: path.join(output, 'ui-greeting.png'), fullPage: true });
        await page.mouse.move(20, 20);
        await page.waitForFunction(() => !document.querySelector('.character-look').style.getPropertyValue('--look-x'));
        await page.waitForFunction(() => document.querySelector('#companion').dataset.state === 'idle');
        await page.locator('[data-scenario="competition"]').click();
        await page.locator('#messageInput').fill('');

        const initialTransform = await page.locator('.character-motion').evaluate((el) => getComputedStyle(el).transform);
        await page.waitForTimeout(300);
        assert.notEqual(await page.locator('.character-motion').evaluate((el) => getComputedStyle(el).transform), initialTransform, 'Idle should animate');
        await page.locator('#messageInput').fill('最近备考有些累，想找人聊聊。');
        assert.deepEqual(errors, []);
        assert.equal(await page.locator('#companion').getAttribute('data-state'), 'listening');

        let releaseResponse;
        let requests = 0;
        const responseReady = new Promise((resolve) => { releaseResponse = resolve; });
        const reply = '备考让你有些疲惫，先给自己一点喘息的空间。我们可以一起把任务缩小：今天先选一道题，或者休息五分钟。你现在最担心的是时间不够，还是成绩没有达到期待？';
        await page.route('**/api/chat/', async (route) => {
            requests++;
            await responseReady;
            await route.fulfill({ json: { reply, provider: 'doubao' } });
        });
        await page.locator('#sendButton').click();
        assert.equal(await page.locator('#companion').getAttribute('data-state'), 'thinking');
        assert(await page.locator('#sendButton').isDisabled());
        assert(await page.locator('#welcomeIntro').isHidden());
        await character.click();
        assert.equal(await page.locator('#companion').getAttribute('data-state'), 'thinking', 'Greeting must not interrupt a pending reply');
        await page.locator('#messageInput').fill('下一条草稿');
        await page.locator('#messageInput').press('Enter');
        assert.equal(requests, 1, 'Must not submit twice while pending');
        await page.screenshot({ path: path.join(output, 'thinking.png'), fullPage: true });
        releaseResponse();
        await page.waitForFunction(() => document.querySelector('#companion').dataset.state === 'speaking');
        await page.screenshot({ path: path.join(output, 'speaking.png'), fullPage: true });
        await page.waitForFunction(() => !document.querySelector('#sendButton').disabled);
        assert.equal(await page.locator('.message.assistant').last().locator('.bubble').textContent(), reply);
        assert.equal(await page.locator('#messageInput').inputValue(), '下一条草稿');
        assert.equal(await page.locator('#companion').getAttribute('data-state'), 'listening');
        assert.equal(await page.locator('#replyAnnouncement').textContent(), reply);
        await page.locator('#messageInput').fill('');
        await page.locator('#voiceToggle').click();
        assert.equal(await page.locator('#voiceToggle').getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('#companion').getAttribute('data-state'), 'speaking');
        assert.equal(await page.evaluate(() => window.__spoken[0]), reply);
        assert.equal(await page.evaluate(() => window.__speech.pitch), 1.22);
        await page.evaluate(() => window.__speech.onend());
        assert.equal(await page.locator('#companion').getAttribute('data-state'), 'idle');
        await page.locator('#voiceToggle').click();

        await page.unroute('**/api/chat/');
        await page.route('**/api/chat/', (route) => route.fulfill({ status: 503, body: 'unavailable' }));
        await page.locator('#messageInput').fill('请保留这句话');
        await page.locator('#sendButton').click();
        await page.waitForFunction(() => !document.querySelector('#sendButton').disabled);
        assert.equal(await page.locator('#messageInput').inputValue(), '请保留这句话');
        assert.match(await page.locator('.message.assistant').last().textContent(), /保留/);

        await page.unroute('**/api/chat/');
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await scenario.hover();
        assert.equal(await scenario.evaluate((el) => getComputedStyle(el).transform), 'none');
        await character.hover();
        assert.equal(await page.locator('.character-look').evaluate((el) => getComputedStyle(el).transform), 'none');
        const riskReply = '先把安全放在第一位，联系身边可信任的人或当地紧急救助。';
        await page.route('**/api/chat/', (route) => route.fulfill({ json: { reply: riskReply, risk: true } }));
        await page.locator('#messageInput').fill('危机回复测试');
        await page.locator('#sendButton').click();
        await page.waitForFunction(() => !document.querySelector('#sendButton').disabled);
        assert.equal(await page.locator('.message.assistant').last().locator('.bubble').textContent(), riskReply);
        assert.equal(await page.locator('#companion').getAttribute('data-state'), 'listening');
        assert.equal(await page.locator('.character-motion').evaluate((el) => getComputedStyle(el).animationName), 'none');
        await page.evaluate(() => { window.__voices = []; });
        await page.locator('#voiceToggle').click();
        await page.waitForFunction(() => document.querySelector('#voiceNotice').textContent.includes('没有可用的中文声音'));
        assert.match(await page.locator('#voiceNotice').textContent(), /没有可用的中文声音/);

        await page.unroute('**/api/chat/');
        await page.route('**/api/chat/', (route) => route.fulfill({ json: { reply: '这是基础陪伴回复。', provider: 'fallback' } }));
        await page.locator('#messageInput').fill('基础模式测试');
        await page.locator('#sendButton').click();
        await page.waitForFunction(() => !document.querySelector('#sendButton').disabled);
        assert.equal(await page.locator('#chatStatus').textContent(), '基础陪伴模式');
        await page.locator('#messageInput').fill('中文输入法');
        await page.locator('#messageInput').dispatchEvent('keydown', { key: 'Enter', isComposing: true });
        assert.equal(await page.locator('#messageInput').inputValue(), '中文输入法');
        await page.locator('#messageInput').press('Shift+Enter');
        assert((await page.locator('#messageInput').inputValue()).includes('\n'));
        assert.deepEqual(errors, []);
        await checkLayout(page, 390, 844, 'mobile-conversation');

        const csrf = await page.locator('[name=csrfmiddlewaretoken]').inputValue();
        const safety = await page.request.post(baseURL + '/api/chat/', {
            form: { message: '自残风险测试', scenario: 'exam' },
            headers: { 'X-CSRFToken': csrf, Referer: baseURL + '/' },
        });
        assert.equal(safety.status(), 200);
        assert.equal((await safety.json()).risk, true);
        console.log('PASS: hover feedback, click ripple, mood drafts, pointer following, character greeting, five viewport sizes, reply states, request guard, failure recovery, voice lifecycle (mock), reduced motion, IME, actual Django safety endpoint.');
        fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ passed: true, imageStats, browserErrors: errors }, null, 2));
    } finally {
        await browser.close();
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
