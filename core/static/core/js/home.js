const messages = document.querySelector('#messages');
const form = document.querySelector('#chatForm');
const input = document.querySelector('#messageInput');
let csrf = readCookie('csrftoken');
const scenarios = document.querySelectorAll('.scenario');
const companion = document.querySelector('#companion');
const companionStatus = document.querySelector('#companionStatus');
const chatStatus = document.querySelector('#chatStatus');
const sendButton = document.querySelector('#sendButton');
const announcement = document.querySelector('#replyAnnouncement');
const voiceToggle = document.querySelector('#voiceToggle');
const voicePreview = document.querySelector('#voicePreview');
const voiceNotice = document.querySelector('#voiceNotice');
const welcomeIntro = document.querySelector('#welcomeIntro');
const moodOptions = document.querySelectorAll('.mood-option');
const characterGreeting = document.querySelector('#characterGreeting');
const characterLook = document.querySelector('.character-look');
const draftStatus = document.querySelector('#draftStatus');
const dialogueStages = document.querySelectorAll('#dialogueStages li');
const dialogueStageLabel = document.querySelector('#dialogueStageLabel');
const actionCardTemplate = document.querySelector('#actionCardTemplate');
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const speech = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window
    ? window.speechSynthesis : null;
const openingGreeting = '你好呀，我是心研同伴。先陪你听听自己的心情，再一起把眼前的压力拆小一点。最近，哪件事最让你挂心？';

function readCookie(name) {
    const prefix = `${name}=`;
    const item = document.cookie.split(';').map((value) => value.trim()).find((value) => value.startsWith(prefix));
    return item ? decodeURIComponent(item.slice(prefix.length)) : '';
}

async function ensureCsrfToken() {
    csrf = readCookie('csrftoken') || csrf;
    if (csrf) return csrf;
    const response = await fetch('/api/csrf/', {
        credentials: 'same-origin',
        cache: 'no-store',
    });
    if (!response.ok) throw new Error('CSRF token request failed');
    const payload = await response.json();
    csrf = payload.csrfToken || readCookie('csrftoken');
    if (!csrf) throw new Error('CSRF token unavailable');
    return csrf;
}

let activeScenario = 'competition';
let pending = false;
let revealing = false;
let supportMode = false;
let voiceEnabled = true;
let utterance = null;
let speechStartTimer = null;
let speechEndTimer = null;
let speechRequestId = 0;
let cancelVoiceWait = null;
let previewActive = false;
let lastReply = openingGreeting;
let followMessages = true;
let greetingActive = false;
let greetingTimer = null;
let lookFrame = null;
let previousScrollTop = 0;
let openingGreetingPending = false;
let openingGreetingTimer = null;
let flowStage = 'listen';
let selectedAction = '';
const conversationHistory = [];

const stageLabels = {
    listen: '先听你说',
    clarify: '一起看清压力',
    control: '寻找能控制的部分',
    action: '陪你迈出一小步',
};
const stageOrder = ['listen', 'clarify', 'control', 'action'];
const providerLabels = {
    doubao: '豆包 AI 陪伴中',
    gemini: 'Gemini AI 陪伴中',
    ollama: '本地 AI 陪伴中',
    fallback: '基础陪伴模式',
};

function updateDialogueStage(stage) {
    if (!stageOrder.includes(stage)) return;
    flowStage = stage;
    const activeIndex = stageOrder.indexOf(stage);
    dialogueStageLabel.textContent = stageLabels[stage];
    dialogueStages.forEach((item, index) => {
        item.classList.toggle('active', index === activeIndex);
        item.classList.toggle('done', index < activeIndex);
        if (index === activeIndex) item.setAttribute('aria-current', 'step');
        else item.removeAttribute('aria-current');
    });
}

function submitGuidedUpdate(text, stage = 'action') {
    if (pending || !text) return false;
    updateDialogueStage(stage);
    input.value = text;
    resizeInput();
    form.requestSubmit();
    return true;
}

function renderActionCard(card) {
    if (!card || typeof card.step !== 'string' || !actionCardTemplate) return;
    messages.querySelector('.action-card:not(.is-accepted)')?.remove();
    const actionCard = actionCardTemplate.content.firstElementChild.cloneNode(true);
    const steps = [card.step, ...(Array.isArray(card.alternatives) ? card.alternatives : [])]
        .filter((step, index, items) => typeof step === 'string' && step.trim() && items.indexOf(step) === index);
    let stepIndex = 0;
    const step = actionCard.querySelector('.action-step');
    const change = actionCard.querySelector('.action-change');
    const accept = actionCard.querySelector('.action-accept');
    const next = actionCard.querySelector('.action-next');
    const nextStatus = actionCard.querySelector('.action-next-status');
    const start = actionCard.querySelector('.action-start');
    const completeAction = actionCard.querySelector('.action-complete');
    const stuck = actionCard.querySelector('.action-stuck');
    const smaller = actionCard.querySelector('.action-smaller');
    actionCard.querySelector('h3').textContent = card.title || '只做眼前的一小步';
    actionCard.querySelector('.action-duration').textContent = card.duration || '约 10 分钟';
    actionCard.querySelector('.action-note').textContent = card.note || '不求一次做好，只确认这一步是否适合现在的你。';
    step.textContent = steps[0];
    change.hidden = steps.length < 2;
    change.addEventListener('click', () => {
        stepIndex = (stepIndex + 1) % steps.length;
        step.textContent = steps[stepIndex];
        announcement.textContent = '已换成新的小步骤：' + steps[stepIndex];
        scrollMessages();
    });
    accept.addEventListener('click', () => {
        actionCard.classList.add('is-accepted');
        accept.disabled = true;
        accept.textContent = '这一步，已经选好了';
        conversationHistory.push({ role: 'user', content: '我选择的今日行动是：' + steps[stepIndex] });
        selectedAction = steps[stepIndex];
        updateDialogueStage('action');
        companionStatus.textContent = '不用做完全部，先陪你迈出这一小步';
        announcement.textContent = '已选定今日行动：' + steps[stepIndex];
        next.hidden = false;
        scrollMessages(true);
    });
    start.addEventListener('click', () => {
        actionCard.classList.add('is-running');
        start.disabled = true;
        start.textContent = '正在进行';
        nextStatus.textContent = '已经开始。先试十分钟，不用追求做完；有任何进展或阻碍，都可以回来告诉我。';
        companionStatus.textContent = '我会在这里，等你按自己的节奏回来';
        announcement.textContent = '行动已经开始。完成或卡住时，可以选择下面的按钮继续。';
    });
    function followUp(message, state, status) {
        if (pending || actionCard.classList.contains('is-following-up')) return;
        actionCard.classList.add('is-following-up', state);
        nextStatus.textContent = status;
        if (!submitGuidedUpdate(message, state === 'is-adjusting' ? 'control' : 'action')) {
            actionCard.classList.remove('is-following-up', state);
        }
    }
    completeAction.addEventListener('click', () => followUp(
        '我完成了行动卡里的这一步，想和你简单复盘一下。',
        'is-complete',
        '收到你的进展了。我们一起看看，是什么帮助你完成了这一步。'
    ));
    stuck.addEventListener('click', () => followUp(
        '我尝试了行动卡里的这一步，但现在卡住了，请陪我看看阻碍在哪里。',
        'is-stuck',
        '卡住不等于失败。你已经把具体情况告诉我，我们一起看看阻碍。'
    ));
    smaller.addEventListener('click', () => followUp(
        '这张行动卡对我来说还是有点难，请帮我换成一个更轻、更容易开始的步骤。',
        'is-adjusting',
        '好的，我们把这一步再缩小，不勉强现在的自己。'
    ));
    messages.append(actionCard);
    scrollMessages(true);
}

function updateCompanion() {
    let state = 'idle';
    let label = '我在这里，慢慢说就好';
    if (pending && !revealing) {
        state = 'thinking';
        label = '让我想一想，怎么陪你一起面对';
    } else if (supportMode) {
        state = 'listening';
        label = '先照顾好你的安全，我在听';
    } else if (revealing || utterance) {
        state = 'speaking';
        label = '我们一起，把心事慢慢说开';
    } else if (document.activeElement === input && input.value.trim()) {
        state = 'listening';
        label = '我在认真听，你可以慢慢说';
    } else if (greetingActive) {
        state = 'greeting';
        label = '收到你的招呼啦，很高兴见到你';
    }
    companion.dataset.state = state;
    companionStatus.textContent = label;
}

function scrollMessages(force = false) {
    if (force || followMessages) messages.scrollTop = messages.scrollHeight;
}

messages.addEventListener('scroll', () => {
    const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 64;
    if (atBottom) followMessages = true;
    else if (messages.scrollTop < previousScrollTop - 1) followMessages = false;
    previousScrollTop = messages.scrollTop;
}, { passive: true });

// Growing replies and input/viewport resizing must not disable bottom-following.
new ResizeObserver(() => {
    if (messages.classList.contains('has-conversation')) scrollMessages();
}).observe(messages);

scenarios.forEach((button) => {
    button.addEventListener('click', () => {
        scenarios.forEach((item) => {
            const active = item === button;
            item.classList.toggle('active', active);
            item.setAttribute('aria-pressed', String(active));
        });
        activeScenario = button.dataset.scenario;
        document.querySelector('#modeTitle').textContent = '学业压力陪伴';
        input.value = button.dataset.prompt;
        resizeInput();
        input.focus();
        updateCompanion();
    });
    button.setAttribute('aria-pressed', String(button.classList.contains('active')));
});

moodOptions.forEach((button) => {
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
        activeScenario = '';
        document.querySelector('#modeTitle').textContent = '心情陪伴';
        scenarios.forEach((item) => {
            item.classList.remove('active');
            item.setAttribute('aria-pressed', 'false');
        });
        input.value = button.dataset.prompt;
        resizeInput();
        input.focus();
        updateCompanion();
    });
});

document.addEventListener('click', (event) => {
    const button = event.target.closest('.scenario, .mood-option, .icon-button, #sendButton');
    if (!button || reducedMotion.matches) return;
    button.querySelector('.tap-ripple')?.remove();
    const bounds = button.getBoundingClientRect();
    const ripple = document.createElement('span');
    ripple.className = 'tap-ripple';
    ripple.setAttribute('aria-hidden', 'true');
    ripple.style.setProperty('--ripple-size', Math.max(bounds.width, bounds.height) * 2 + 'px');
    ripple.style.setProperty('--ripple-x', (event.detail ? event.clientX - bounds.left : bounds.width / 2) + 'px');
    ripple.style.setProperty('--ripple-y', (event.detail ? event.clientY - bounds.top : bounds.height / 2) + 'px');
    button.append(ripple);
    window.setTimeout(() => ripple.remove(), 600);
});

function resetCharacterLook() {
    window.cancelAnimationFrame(lookFrame);
    lookFrame = null;
    characterLook.style.removeProperty('--look-x');
    characterLook.style.removeProperty('--look-y');
    characterLook.style.removeProperty('--look-angle');
}

characterGreeting.addEventListener('pointermove', (event) => {
    if (reducedMotion.matches || !finePointer.matches || event.pointerType === 'touch' || pending || supportMode) return;
    window.cancelAnimationFrame(lookFrame);
    lookFrame = window.requestAnimationFrame(() => {
        const bounds = characterGreeting.getBoundingClientRect();
        const x = Math.max(-1, Math.min(1, (event.clientX - bounds.left) / bounds.width * 2 - 1));
        const y = Math.max(-1, Math.min(1, (event.clientY - bounds.top) / bounds.height * 2 - 1));
        characterLook.style.setProperty('--look-x', (x * 5).toFixed(2) + 'px');
        characterLook.style.setProperty('--look-y', (y * 3).toFixed(2) + 'px');
        characterLook.style.setProperty('--look-angle', (x * 2).toFixed(2) + 'deg');
        lookFrame = null;
    });
});
characterGreeting.addEventListener('pointerleave', resetCharacterLook);
characterGreeting.addEventListener('pointercancel', resetCharacterLook);
reducedMotion.addEventListener('change', resetCharacterLook);
characterGreeting.addEventListener('click', () => {
    if (pending || supportMode || utterance) return;
    window.clearTimeout(greetingTimer);
    greetingActive = true;
    updateCompanion();
    greetingTimer = window.setTimeout(() => {
        greetingActive = false;
        updateCompanion();
    }, 1700);
});

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || pending) return;

    stopSpeech();
    window.clearTimeout(greetingTimer);
    greetingActive = false;
    resetCharacterLook();
    pending = true;
    supportMode = false;
    sendButton.disabled = true;
    voicePreview.disabled = true;
    sendButton.setAttribute('aria-label', '正在回复');
    draftStatus.textContent = '正在认真回应…';
    chatStatus.textContent = '正在回应';
    announcement.textContent = '';
    voiceNotice.textContent = '';
    followMessages = true;
    appendMessage('user', text);
    input.value = '';
    resizeInput();
    const thinking = appendMessage('assistant', '我在听，请给我一点时间……');
    thinking.classList.add('pending');
    thinking.setAttribute('aria-busy', 'true');
    updateCompanion();

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 45000);
    try {
        await ensureCsrfToken();
        const recentHistory = conversationHistory.slice(-6);
        conversationHistory.push({ role: 'user', content: text });
        const body = new URLSearchParams({
            message: text,
            scenario: activeScenario,
            flow_stage: flowStage,
            selected_action: selectedAction,
            history: JSON.stringify(recentHistory),
        });
        const response = await fetch('/api/chat/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-CSRFToken': csrf,
            },
            body,
            signal: controller.signal,
        });
        if (!response.ok) throw new Error('Chat request failed');
        const data = await response.json();
        if (typeof data.reply !== 'string' || !data.reply.trim()) {
            throw new Error('Empty chat response');
        }
        window.clearTimeout(timeout);
        thinking.classList.remove('pending');
        thinking.dataset.provider = data.provider || (data.risk ? 'safety' : 'fallback');
        supportMode = Boolean(data.risk);
        thinking.classList.toggle('risk', supportMode);
        lastReply = data.reply;
        if (!supportMode) updateDialogueStage(data.stage);
        revealing = true;
        updateCompanion();
        if (voiceEnabled) speakReply(data.reply);
        await revealReply(thinking.querySelector('.bubble'), data.reply, supportMode);
        conversationHistory.push({ role: 'assistant', content: data.reply });
        if (!supportMode) renderActionCard(data.action_card);
        chatStatus.textContent = supportMode
            ? '安全支持模式'
            : (providerLabels[data.provider] || '在这里陪你');
        chatStatus.dataset.provider = supportMode ? 'safety' : (data.provider || 'unknown');
        announcement.textContent = data.reply;
    } catch (error) {
        if (conversationHistory.at(-1)?.role === 'user' && conversationHistory.at(-1)?.content === text) {
            conversationHistory.pop();
        }
        const notice = error.name === 'AbortError'
            ? '这次回应等得有些久。你的话已经保留，可以稍后再试一次。'
            : '暂时没有收到回应。你的话已经保留，可以稍后再试一次。';
        thinking.querySelector('.bubble').textContent = notice;
        chatStatus.textContent = '连接暂时中断';
        announcement.textContent = notice;
        if (!input.value.trim()) {
            input.value = text;
            resizeInput();
        }
    } finally {
        window.clearTimeout(timeout);
        pending = false;
        revealing = false;
        sendButton.disabled = false;
        voicePreview.disabled = false;
        sendButton.setAttribute('aria-label', '发送消息');
        updateDraft();
        thinking.classList.remove('pending');
        thinking.setAttribute('aria-busy', 'false');
        updateCompanion();
        scrollMessages();
    }
});

function resizeInput() {
    input.style.height = '60px';
    input.style.height = Math.min(input.scrollHeight, 132) + 'px';
    updateDraft();
}

function updateDraft() {
    const hasDraft = Boolean(input.value.trim());
    form.classList.toggle('has-draft', hasDraft);
    draftStatus.textContent = pending ? '正在认真回应…' : (hasDraft ? '慢慢说，不用着急' : '慢慢来，我在听');
    moodOptions.forEach((button) => button.setAttribute('aria-pressed', String(input.value === button.dataset.prompt)));
}

input.addEventListener('input', () => {
    resizeInput();
    updateCompanion();
});
input.addEventListener('focus', updateCompanion);
input.addEventListener('blur', updateCompanion);
input.addEventListener('keydown', (event) => {
    // Chinese IME uses Enter to commit a candidate before sending a message.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        if (!pending) form.requestSubmit();
    }
});

function appendMessage(role, text) {
    if (role === 'user') {
        welcomeIntro.hidden = true;
        messages.classList.add('has-conversation');
    }
    const article = document.createElement('article');
    article.className = 'message arriving ' + role;
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.setAttribute('aria-hidden', 'true');
    if (role === 'assistant') {
        avatar.classList.add('companion-avatar');
        const portrait = document.createElement('span');
        portrait.className = 'character-portrait';
        avatar.append(portrait);
    } else {
        avatar.textContent = '我';
    }
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    article.append(avatar, bubble);
    messages.append(article);
    scrollMessages(true);
    return article;
}

function revealReply(bubble, text, immediate) {
    if (immediate || reducedMotion.matches || document.hidden) {
        bubble.textContent = text;
        scrollMessages();
        return Promise.resolve();
    }
    // Reveal a completed server reply locally; the backend is not a streaming API.
    const characters = Array.from(text);
    const duration = Math.min(6500, Math.max(600, characters.length * 22));
    const start = performance.now();
    bubble.textContent = '';
    return new Promise((resolve) => {
        const tick = () => {
            const progress = document.hidden || reducedMotion.matches
                ? 1 : Math.min(1, (performance.now() - start) / duration);
            bubble.textContent = characters.slice(0, Math.max(1, Math.ceil(progress * characters.length))).join('');
            scrollMessages();
            if (progress >= 1) resolve();
            else window.setTimeout(tick, 24);
        };
        tick();
    });
}

function stopSpeech() {
    speechRequestId++;
    cancelVoiceWait?.();
    window.clearTimeout(speechStartTimer);
    window.clearTimeout(speechEndTimer);
    utterance = null;
    previewActive = false;
    updatePreviewButton();
    if (speech) speech.cancel();
    updateCompanion();
}

function updatePreviewButton() {
    voicePreview.setAttribute('aria-pressed', String(previewActive));
    const label = previewActive ? '停止试听' : '试听角色声音';
    voicePreview.setAttribute('aria-label', label);
    voicePreview.title = label;
    voicePreview.querySelector('.preview-play').hidden = previewActive;
    voicePreview.querySelector('.preview-stop').hidden = !previewActive;
}

function chineseVoices() {
    return speech.getVoices().filter((voice) => /^zh([_-]|$)/i.test(voice.lang));
}

function waitForChineseVoices() {
    const available = chineseVoices();
    if (available.length) return Promise.resolve(available);
    return new Promise((resolve) => {
        let timer;
        const finish = () => {
            window.clearTimeout(timer);
            speech.removeEventListener?.('voiceschanged', onChange);
            cancelVoiceWait = null;
            resolve(chineseVoices());
        };
        const onChange = () => { if (chineseVoices().length) finish(); };
        cancelVoiceWait = finish;
        speech.addEventListener?.('voiceschanged', onChange);
        timer = window.setTimeout(finish, 1800);
    });
}

function selectCompanionVoice(voices) {
    // Voice names are device-specific; prefer a light Chinese voice over list order.
    const preferredNames = [/xiaoyi|晓伊/i, /yaoyao|瑶瑶/i, /xiaoxiao|晓晓/i, /huihui|慧慧/i, /tingting|婷婷/i];
    for (const name of preferredNames) {
        const match = voices.find((voice) => name.test(voice.name));
        if (match) return match;
    }
    return voices.find((voice) => /female|女声/i.test(voice.name))
        || voices.find((voice) => voice.localService) || voices[0];
}

async function speakReply(text, { preview = false, opening = false } = {}) {
    if (!speech || (!voiceEnabled && !preview)) return;
    stopSpeech();
    const requestId = speechRequestId;
    previewActive = preview;
    updatePreviewButton();
    if (!chineseVoices().length) voiceNotice.textContent = '正在准备中文声音…';
    const voices = await waitForChineseVoices();
    if (requestId !== speechRequestId) return;
    if (!voices.length) {
        stopSpeech();
        voiceNotice.textContent = '当前浏览器没有可用的中文声音，文字回复正常。';
        return;
    }
    const current = new SpeechSynthesisUtterance(text);
    current.voice = selectCompanionVoice(voices);
    current.lang = current.voice.lang;
    current.pitch = 1.22;
    current.rate = 1.02;
    current.volume = 0.9;
    utterance = current;
    const finish = (notice = '', retryOpening = false) => {
        if (utterance !== current) return;
        stopSpeech();
        if (retryOpening && voiceEnabled) {
            openingGreetingPending = true;
            voiceNotice.textContent = '轻触页面后，我会和你打个招呼。';
        } else {
            voiceNotice.textContent = notice;
        }
    };
    current.onstart = () => {
        if (utterance !== current) return;
        openingGreetingPending = false;
        window.clearTimeout(speechStartTimer);
        voiceNotice.textContent = '';
        updateCompanion();
    };
    current.onend = () => finish();
    current.onerror = (event) => finish(
        '语音暂时不可用，文字回复正常。',
        opening && event.error === 'not-allowed'
    );
    speechStartTimer = window.setTimeout(
        () => finish('语音未能自动启动，文字回复正常。', opening),
        opening ? 3000 : 7000
    );
    speechEndTimer = window.setTimeout(() => finish(), Math.min(180000, Math.max(15000, text.length * 500)));
    try {
        speech.speak(current);
        updateCompanion();
    } catch {
        finish('语音暂时不可用，文字回复正常。');
    }
}

if (speech) {
    voiceToggle.hidden = false;
    voicePreview.hidden = false;
    voiceToggle.setAttribute('aria-pressed', 'true');
    voiceToggle.setAttribute('aria-label', '关闭语音朗读');
    voiceToggle.title = '关闭语音朗读';
    voiceToggle.querySelector('.voice-on').hidden = false;
    voiceToggle.querySelector('.voice-off').hidden = true;
    // Load browser-provided voices; speech uses only browser voices and keys stay server-side.
    speech.getVoices();
    voicePreview.addEventListener('click', () => {
        if (pending) return;
        if (previewActive) stopSpeech();
        else speakReply('你好呀，我是心研同伴。今天辛苦啦，慢慢说，我会认真听。', { preview: true });
    });
    voiceToggle.addEventListener('click', () => {
        voiceEnabled = !voiceEnabled;
        voiceToggle.setAttribute('aria-pressed', String(voiceEnabled));
        const label = voiceEnabled ? '关闭语音朗读' : '开启语音朗读';
        voiceToggle.setAttribute('aria-label', label);
        voiceToggle.title = label;
        voiceToggle.querySelector('.voice-on').hidden = !voiceEnabled;
        voiceToggle.querySelector('.voice-off').hidden = voiceEnabled;
        voiceNotice.textContent = '';
        if (!voiceEnabled) stopSpeech();
        else if (!pending && lastReply) speakReply(lastReply);
    });

    openingGreetingTimer = window.setTimeout(() => {
        if (voiceEnabled && !pending && !utterance) {
            speakReply(openingGreeting, { opening: true });
        }
    }, 900);

    const retryOpeningGreeting = (event) => {
        if (!openingGreetingPending || !voiceEnabled || pending) return;
        if (event.target.closest?.('#voiceToggle, #voicePreview')) return;
        openingGreetingPending = false;
        speakReply(openingGreeting, { opening: true });
    };
    document.addEventListener('pointerdown', retryOpeningGreeting, { capture: true });
    document.addEventListener('keydown', retryOpeningGreeting, { capture: true });
}
window.addEventListener('pagehide', () => {
    window.clearTimeout(openingGreetingTimer);
    window.clearTimeout(greetingTimer);
    greetingActive = false;
    resetCharacterLook();
    stopSpeech();
});
