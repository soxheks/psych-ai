const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const base = process.env.PREVIEW_URL || 'http://127.0.0.1:8001';
const output = process.env.JOURNEY_OUTPUT || 'output/dialogue-retest-2026-10-05';

(async () => {
    fs.mkdirSync(output, { recursive: true });
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const records = [];
    const errors = [];
    try {
        for (const width of [1440, 390]) {
            const context = await browser.newContext({ viewport: { width, height: 850 }, reducedMotion: 'reduce' });
            const page = await context.newPage();
            page.on('pageerror', error => errors.push(error.message));
            let outcomes = 0;
            page.on('request', request => { if (request.url().endsWith('/api/outcomes/')) outcomes++; });
            await page.goto(base + '/chat/');
            async function observeReplies() {
                await page.evaluate(() => {
                    window.qaResponses = [];
                    const original = readChatResponse;
                    readChatResponse = async (...args) => {
                        try {
                            const result = await original(...args);
                            window.qaResponses.push({ status: args[0].status, data: result.data });
                            return result;
                        } catch (error) {
                            window.qaResponses.push({ status: args[0].status, error: error.message });
                            throw error;
                        }
                    };
                });
            }
            await observeReplies();
            let lastRequest = 0;
            async function say(message, button = '#sendButton') {
                await new Promise(resolve => setTimeout(resolve, Math.max(0, 6000 - (Date.now() - lastRequest))));
                lastRequest = Date.now();
                await page.locator('#messageInput').fill(message);
                const count = await page.evaluate(() => window.qaResponses.length);
                await page.locator(button).click();
                try {
                    await page.waitForFunction(count => window.qaResponses.length > count, count, { timeout: 55000 });
                } catch (error) {
                    console.log(await page.evaluate(() => ({ url: location.href, text: document.body.innerText, responses: window.qaResponses })));
                    throw error;
                }
                const response = await page.evaluate(() => window.qaResponses.at(-1));
                assert.equal(response.status, 200, JSON.stringify(response));
                assert.ok(!response.error, response.error);
                const data = response.data;
                assert.equal(data.type, 'done');
                assert.ok(data.reply.trim());
                assert.ok(!data.interrupted);
                assert.ok(!/[。！？]{2,}/.test(data.reply));
                await page.waitForFunction(() => !pending);
                assert.equal(await page.locator('.message.assistant .bubble').last().textContent(), data.reply);
                records.push({ width, input: message || '我现在想一起梳理，看看最困扰我的部分。', ...data });
                fs.writeFileSync(output + '/transcripts.json', JSON.stringify(records, null, 2));
                return data;
            }
            let data = await say('我在备考，越临近考试越难集中注意力。');
            assert.equal(data.stage, 'clarify');
            assert.ok(data.reply.includes('？'), 'opening should offer a concrete continuation');
            data = await say('每天看书都会走神，脑子里一直想着考砸。');
            assert.equal(data.stage, 'clarify');
            assert.equal(data.action_card, null);
            assert.ok(data.reply.includes('？'));
            data = await say('卡在公式推导。');
            assert.equal(data.stage, 'control');
            assert.equal(data.action_card.title, '开始一个短专注');
            await page.getByRole('button', { name: '就从这一步开始', exact: true }).click();
            data = await say('我刚才那一步已经做完了，是把问题拆小让我轻松一点。');
            assert.equal(data.action_status, 'completed');
            assert.ok(data.reply.includes('把问题拆小'));
            assert.ok(!data.reply.includes('？'));
            assert.equal(await page.locator('.completion-summary').count(), 1);
            assert.ok(await page.locator('#dialogueStages li').last().evaluate(element => element.classList.contains('complete')));
            await page.screenshot({ path: `${output}/completed-${width}.png` });
            if (process.env.JOURNEY_SHORT === 'true') {
                assert.equal(outcomes, 0, 'synthetic tests must not create outcome records');
                assert.equal(await page.evaluate(() => localStorage.getItem('mindmate-chat-progress-v1')), null);
                await context.close();
                console.log(`PASS ${width}px: two-question handoff, streamed reply, selection and completion`);
                continue;
            }
            data = await say('我好多了，今天先聊到这里。');
            assert.equal(data.ended, true);
            assert.ok(!data.reply.includes('？'));
            await page.reload();
            await observeReplies();
            data = await say('最近上课走神很焦虑。');
            assert.equal(data.stage, 'clarify');
            assert.ok(data.reply.includes('？'));
            data = await say('对');
            assert.equal(data.stage, 'clarify');
            assert.equal(data.action_card, null);
            data = await say('你理解错了，我说的是听不懂课，不是考试成绩。');
            assert.ok(!data.reply.includes('？'));
            assert.equal(data.action_card, null);
            data = await say('我只想倾诉，不想听建议。');
            assert.equal(data.stage, 'listen');
            assert.equal(data.action_card, null);
            assert.ok(!data.reply.includes('？'));
            assert.ok(await page.locator('#resumeGuidance').isVisible());
            await page.screenshot({ path: `${output}/resume-${width}.png` });
            data = await say('', '#resumeGuidance');
            assert.equal(data.stage, 'clarify');
            assert.ok(await page.locator('#resumeGuidance').isHidden());
            data = await say('每天上课都卡在公式推导上，很难受。');
            assert.equal(data.stage, 'control');
            assert.ok(data.action_card);
            assert.equal(data.action_status, '');
            await page.reload();
            await observeReplies();
            data = await say('我在备考，最近好累。');
            assert.equal(data.stage, 'listen');
            data = await say('还是好累，想接着说说。');
            assert.equal(data.stage, 'clarify');
            data = await say('每次复习都卡在公式上，我还是很难受。');
            assert.equal(data.stage, 'clarify');
            assert.ok(data.reply.includes('？'));
            data = await say('证明跟不上。');
            assert.equal(data.stage, 'control');
            assert.equal(data.action_status, '');
            assert.equal(outcomes, 0, 'synthetic tests must not create outcome records');
            assert.equal(await page.evaluate(() => localStorage.getItem('mindmate-chat-progress-v1')), null);
            await context.close();
            console.log(`PASS ${width}px: real local API, natural handoff, completion, ending, confirmation, correction, pause`);
        }
        assert.deepEqual(errors, []);
        console.log('Providers: ' + [...new Set(records.map(item => item.provider))].join(', '));
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
