const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const baseURL = process.env.PREVIEW_URL || 'http://127.0.0.1:8000';
const chatURL = new URL('/chat/', baseURL).toString();
const selectedAction = '打开任务清单，只圈出截止最近且最重要的一项，写下它的第一个动作。';
const screenshotDir = process.env.SCREENSHOT_DIR;

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await context.newPage();
        const requests = [];
        const outcomeRequests = [];
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));

        await page.route('**/api/chat/', async (route) => {
            const body = new URLSearchParams(route.request().postData() || '');
            requests.push(Object.fromEntries(body));
            if (requests.length === 1) {
                const final = {
                    reply: '我们先从今天能控制的一小步开始。',
                    provider: 'doubao',
                    stage: 'control',
                    action_status: '',
                    action_card: {
                        title: '先圈出最关键的一项',
                        step: selectedAction,
                        alternatives: [],
                        duration: '约 10 分钟',
                        note: '不求一次做好。',
                    },
                };
                await new Promise((resolve) => setTimeout(resolve, 2100));
                await route.fulfill({
                    status: 200,
                    contentType: 'application/x-ndjson; charset=utf-8',
                    body: [
                        { type: 'meta', stage: 'control', action_status: '', action_card: final.action_card },
                        { type: 'status', text: '正在寻找一个更轻、更可控的步骤' },
                        { type: 'delta', text: '我们先从今天能控制的', provider: 'doubao' },
                        { type: 'delta', text: '一小步开始。', provider: 'doubao' },
                        { type: 'done', ...final },
                    ].map((event) => JSON.stringify(event)).join('\n') + '\n',
                });
                return;
            }
            if (requests.length === 2) {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/x-ndjson; charset=utf-8',
                    body: [
                        { type: 'meta', stage: 'action', action_status: 'completed', action_card: null },
                        { type: 'delta', text: '你已经完成了这一步。', provider: 'doubao' },
                    ].map((event) => JSON.stringify(event)).join('\n') + '\n',
                });
                return;
            }
            await route.fulfill({ json: {
                reply: requests.length === 3
                    ? '你已经完成了这一步。此刻可以先停下来感受一下变化。'
                    : '能感觉轻松一点，是很值得记住的反馈。',
                provider: 'doubao',
                stage: 'action',
                action_status: 'completed',
                action_card: null,
            } });
        });
        await page.route('**/api/outcomes/', async (route) => {
            const body = new URLSearchParams(route.request().postData() || '');
            outcomeRequests.push(Object.fromEntries(body));
            await route.fulfill({ json: body.get('consent') === 'withdrawn'
                ? { deleted: true }
                : { saved: true, created: outcomeRequests.length === 1 } });
        });

        await page.goto(chatURL);
        assert.equal(await page.locator('#initialStressCheckin').isVisible(), false);
        await page.locator('.scenario.active').click();
        assert.equal(await page.locator('#initialStressCheckin').isVisible(), true);
        await page.locator('#initialStressScale [data-stress="5"]').click();
        assert.match(await page.locator('#initialStressFeedback').textContent(), /压力 5 分/);
        await page.locator('#messageInput').fill('我想先处理竞赛任务。');
        await page.locator('#sendButton').click();
        await page.waitForTimeout(1900);
        assert.match(await page.locator('.message.assistant.pending .bubble').textContent(), /已经连接/);
        await page.locator('.action-card').waitFor({ state: 'visible' });
        assert.equal(requests[0].stream, 'true');
        assert.match(await page.locator('.message.assistant:not(.pending) .bubble').last().textContent(), /一小步开始/);
        await page.locator('.action-accept').click();
        await page.locator('.action-complete').click();
        await page.locator('.message-retry').waitFor({ state: 'visible' });

        assert.equal(requests[1].selected_action, selectedAction);
        assert.equal(requests[1].action_status, 'completed');
        assert.equal(await page.locator('.completion-summary').count(), 0);
        await page.locator('.message-retry').click();
        await page.waitForFunction(() => !document.querySelector('#sendButton').disabled);
        assert.equal(requests[2].selected_action, selectedAction);
        assert.equal(requests[2].action_status, 'completed');
        await page.locator('#dialogueStages li[data-stage="action"].complete').waitFor();
        assert.equal(await page.locator('#dialogueStages li[data-stage="action"] span').textContent(), '✓');
        assert.match(await page.locator('#dialogueStageLabel').textContent(), /已经完成/);
        assert.equal(await page.locator('#dialogueStages li.active').count(), 0);
        await page.locator('.completion-summary').waitFor({ state: 'visible' });
        assert.match(await page.locator('.completion-affirmation').textContent(), /值得被认真看见/);
        assert.match(await page.locator('.completion-takeaway').textContent(), /留给下次的方法/);
        assert.equal(await page.locator('.completion-feedback').getAttribute('open'), null, 'optional feedback should start collapsed');
        assert.equal(await page.locator('#companion').getAttribute('data-state'), 'celebrating');
        if (screenshotDir) {
            fs.mkdirSync(screenshotDir, { recursive: true });
            await page.locator('.completion-summary').scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(screenshotDir, 'outcome-collapsed-desktop.png') });
            await page.setViewportSize({ width: 390, height: 844 });
            await page.locator('.completion-summary').scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(screenshotDir, 'outcome-collapsed-mobile.png') });
            await page.setViewportSize({ width: 1280, height: 800 });
        }
        await page.locator('.completion-stress-options [data-stress="2"]').click();
        assert.match(await page.locator('.completion-result strong').textContent(), /轻了 3 分/);
        assert.equal(await page.locator('.stress-before em').textContent(), '5 分');
        assert.equal(await page.locator('.stress-after em').textContent(), '2 分');
        assert.equal(outcomeRequests.length, 0, 'anonymous data must not be sent before consent');

        await page.locator('.completion-more summary').click();
        await page.locator('[data-feedback-field="understood_rating"] [data-rating="5"]').click();
        await page.locator('[data-feedback-field="actionable_rating"] [data-rating="4"]').click();
        await page.locator('[data-feedback-field="helpful_rating"] [data-rating="5"]').click();
        await page.locator('[data-feedback-field="return_intent_rating"] [data-rating="4"]').click();
        await page.locator('.completion-feedback-note textarea').fill('希望增加更多竞赛场景。');
        assert.equal(outcomeRequests.length, 0, 'ratings must remain local until consent');

        const consent = page.locator('.completion-metrics-consent');
        assert.equal(await consent.isChecked(), false);
        await consent.check();
        await page.waitForFunction(() => document.querySelector('.completion-consent-status')?.textContent.includes('已匿名'));
        assert.equal(outcomeRequests.length, 1);
        assert.equal(outcomeRequests[0].initial_stress, '5');
        assert.equal(outcomeRequests[0].final_stress, '2');
        assert.equal(outcomeRequests[0].action_completed, 'true');
        assert.equal(outcomeRequests[0].understood_rating, '5');
        assert.equal(outcomeRequests[0].actionable_rating, '4');
        assert.equal(outcomeRequests[0].helpful_rating, '5');
        assert.equal(outcomeRequests[0].return_intent_rating, '4');
        assert.equal(outcomeRequests[0].feedback_note, '希望增加更多竞赛场景。');

        await consent.uncheck();
        await page.waitForFunction(() => document.querySelector('.completion-consent-status')?.textContent.includes('已删除'));
        assert.equal(outcomeRequests.at(-1).consent, 'withdrawn');

        if (screenshotDir) {
            fs.mkdirSync(screenshotDir, { recursive: true });
            await page.locator('.completion-summary').scrollIntoViewIfNeeded();
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
            await page.screenshot({ path: path.join(screenshotDir, 'outcome-desktop.png') });
            await page.setViewportSize({ width: 390, height: 844 });
            await page.locator('.completion-summary').scrollIntoViewIfNeeded();
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
            await page.screenshot({ path: path.join(screenshotDir, 'outcome-mobile.png') });
        }

        await page.locator('#messageInput').fill('有');
        await page.locator('#sendButton').click();
        await page.waitForFunction(() => !document.querySelector('#sendButton').disabled);

        assert.equal(requests[3].selected_action, selectedAction);
        assert.equal(requests[3].action_status, 'completed');
        assert.equal(requests[3].flow_stage, 'action');
        assert.deepEqual(errors, []);
        console.log('PASS: action state, interrupted completion retry, completion feedback, consent and outcome data all work.');
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
