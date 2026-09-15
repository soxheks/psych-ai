const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const baseURL = process.env.PREVIEW_URL || 'http://127.0.0.1:8000';
const landingURL = new URL('/', baseURL).toString();
const chatURL = new URL('/chat/', baseURL).toString();
const journalURL = new URL('/journal/', baseURL).toString();
const output = path.resolve('output/landing-journal');
fs.mkdirSync(output, { recursive: true });

async function noHorizontalOverflow(page, label) {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false, label + ': horizontal overflow');
}

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));

        await page.goto(landingURL);
        await page.locator('h1').waitFor();
        await page.waitForTimeout(1000);
        assert.equal(await page.locator('h1').textContent(), '心研同伴');
        assert.equal(await page.locator('a[href="/chat/"]').count() > 0, true);
        assert.equal(await page.locator('a[href="/journal/"]').count() > 0, true);
        const heroImage = await page.locator('.hero-image').evaluate((element) => getComputedStyle(element).backgroundImage);
        assert.match(heroImage, /landing-room\.jpg/);
        await noHorizontalOverflow(page, 'landing desktop');
        await page.screenshot({ path: path.join(output, 'landing-desktop.png'), fullPage: true });

        const primary = page.locator('.button-primary');
        await primary.hover();
        await page.waitForTimeout(220);
        assert.notEqual(await primary.evaluate((element) => getComputedStyle(element).transform), 'none');

        await page.locator('.button-secondary').click();
        await page.locator('.page-transition.is-leaving').waitFor();
        await page.waitForTimeout(300);
        assert.equal(await page.locator('#transitionLabel').textContent(), '打开一页心灵随笔');
        await page.screenshot({ path: path.join(output, 'page-transition.png') });
        await page.waitForURL('**/journal/');
        assert.equal(page.url(), journalURL);
        await page.locator('.page-transition.is-arriving').waitFor();
        await page.waitForTimeout(800);
        await page.locator('#journalInput').fill('最近任务很多，我想先把今晚的压力放在这里，明天再从一小步开始。');
        assert.equal(await page.locator('#characterCount').textContent(), '31');
        assert.equal(await page.locator('#finishButton').isEnabled(), true);
        await noHorizontalOverflow(page, 'journal desktop');
        await page.screenshot({ path: path.join(output, 'journal-writing.png'), fullPage: true });

        await page.locator('#finishButton').click();
        await page.locator('#journalStage.is-sending').waitFor();
        await page.waitForTimeout(1800);
        const planeOpacity = Number(await page.locator('#paperPlane').evaluate((element) => getComputedStyle(element).opacity));
        assert(planeOpacity > 0, 'paper plane should be visible during flight');
        await page.screenshot({ path: path.join(output, 'journal-flight.png'), fullPage: true });
        await page.locator('#journalComplete').waitFor({ state: 'visible', timeout: 5000 });
        await page.waitForTimeout(650);
        assert.equal(await page.locator('#journalForm').isHidden(), true);
        await page.screenshot({ path: path.join(output, 'journal-complete.png'), fullPage: true });
        await page.locator('#writeAgain').click();
        assert.equal(await page.locator('#journalInput').isVisible(), true);
        assert.equal(await page.locator('#journalInput').inputValue(), '');

        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(landingURL);
        await page.waitForTimeout(1000);
        await noHorizontalOverflow(page, 'landing mobile');
        await page.screenshot({ path: path.join(output, 'landing-mobile.png'), fullPage: true });
        await page.goto(journalURL);
        await noHorizontalOverflow(page, 'journal mobile');
        await page.screenshot({ path: path.join(output, 'journal-mobile.png'), fullPage: true });

        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(chatURL);
        await page.locator('.chat-site-nav').waitFor();
        assert.equal(await page.locator('.chat-site-nav a').count(), 2);
        assert.equal(await page.locator('.chat-nav-copy').first().isVisible(), true);
        await page.locator('.chat-site-nav a').first().hover();
        await page.waitForTimeout(220);
        assert.notEqual(await page.locator('.chat-site-nav a').first().evaluate((element) => getComputedStyle(element).transform), 'none');
        await page.screenshot({ path: path.join(output, 'chat-nav-desktop.png'), fullPage: true });

        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.locator('.chat-nav-copy').first().isHidden(), true);
        await noHorizontalOverflow(page, 'chat mobile navigation');
        await page.screenshot({ path: path.join(output, 'chat-nav-mobile.png'), fullPage: true });

        await page.goto(journalURL);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.locator('#journalInput').fill('让这句话安静地飞走。');
        await page.locator('#finishButton').click();
        await page.locator('#journalComplete').waitFor({ state: 'visible', timeout: 1000 });

        assert.deepEqual(errors, []);
        fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ passed: true, errors }, null, 2));
        console.log('PASS: landing navigation, hero asset, hover feedback, journal input, paper-plane sequence, completion state, mobile layout and reduced motion.');
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
