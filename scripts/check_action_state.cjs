const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const baseURL = process.env.PREVIEW_URL || 'http://127.0.0.1:8000';
const chatURL = new URL('/chat/', baseURL).toString();
const selectedAction = '打开任务清单，只圈出截止最近且最重要的一项，写下它的第一个动作。';

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await context.newPage();
        const requests = [];
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));

        await page.route('**/api/chat/', async (route) => {
            const body = new URLSearchParams(route.request().postData() || '');
            requests.push(Object.fromEntries(body));
            if (requests.length === 1) {
                await route.fulfill({ json: {
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
                } });
                return;
            }
            await route.fulfill({ json: {
                reply: requests.length === 2
                    ? '你已经完成了这一步。完成后有没有感觉轻松一点？'
                    : '能感觉轻松一点，是很值得记住的反馈。什么最帮助你完成了它？',
                provider: 'doubao',
                stage: 'action',
                action_status: 'completed',
                action_card: null,
            } });
        });

        await page.goto(chatURL);
        await page.locator('#messageInput').fill('我想先处理竞赛任务。');
        await page.locator('#sendButton').click();
        await page.locator('.action-card').waitFor({ state: 'visible' });
        await page.locator('.action-accept').click();
        await page.locator('.action-complete').click();
        await page.waitForFunction(() => !document.querySelector('#sendButton').disabled);

        assert.equal(requests[1].selected_action, selectedAction);
        assert.equal(requests[1].action_status, 'completed');

        await page.locator('#messageInput').fill('有');
        await page.locator('#sendButton').click();
        await page.waitForFunction(() => !document.querySelector('#sendButton').disabled);

        assert.equal(requests[2].selected_action, selectedAction);
        assert.equal(requests[2].action_status, 'completed');
        assert.equal(requests[2].flow_stage, 'action');
        assert.deepEqual(errors, []);
        console.log('PASS: selected action and completed status persist through the completion reply and the next user turn.');
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
