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
const initialStressOptions = document.querySelectorAll('#initialStressScale [data-stress]');
const initialStressFeedback = document.querySelector('#initialStressFeedback');
const characterGreeting = document.querySelector('#characterGreeting');
const characterLook = document.querySelector('.character-look');
const draftStatus = document.querySelector('#draftStatus');
const dialogueStages = document.querySelectorAll('#dialogueStages li');
const dialogueStageLabel = document.querySelector('#dialogueStageLabel');
const actionCardTemplate = document.querySelector('#actionCardTemplate');
const completionSummaryTemplate = document.querySelector('#completionSummaryTemplate');
const safetyDialog = document.querySelector('#safetyDialog');
const safetyOpenButtons = document.querySelectorAll('.safety-open');
const safetyCloseButtons = document.querySelectorAll('[data-safety-close]');
const safetyCardTemplate = document.querySelector('#safetyCardTemplate');
const progressConsent = document.querySelector('#progressConsent');
const metricsConsent = document.querySelector('#metricsConsent');
const clearLocalProgress = document.querySelector('#clearLocalProgress');
const privacyStatus = document.querySelector('#privacyStatus');
const conversationChoices = document.querySelector('#conversationChoices');
const conversationIntentButtons = document.querySelectorAll('[data-conversation-intent]');
const resumeConversation = document.querySelector('#resumeConversation');
const chatPanel = document.querySelector('.chat-panel');
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const speech = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window
    ? window.speechSynthesis : null;
const openingGreeting = '你好呀，我是心研同伴。先陪你听听自己的心情，再一起把眼前的压力拆小一点。最近，哪件事最让你挂心？';
const PROGRESS_KEY = 'mindmate-chat-progress-v1';
const PROGRESS_CONSENT_KEY = 'mindmate-progress-consent-v1';
const METRICS_CONSENT_KEY = 'mindmate-metrics-consent-v1';
const OUTCOME_ID_KEY = 'mindmate-outcome-id-v1';

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

function readStorage(key) {
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
}

function writeStorage(key, value) {
    try {
        window.localStorage.setItem(key, value);
        return true;
    } catch {
        return false;
    }
}

function removeStorage(key) {
    try {
        window.localStorage.removeItem(key);
    } catch {
        // Storage can be unavailable in privacy modes; the live chat still works.
    }
}

function createEventId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    window.crypto?.getRandomValues?.(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
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
let actionStatus = '';
let initialStress = null;
let finalStress = null;
let completionSummaryRendered = false;
let riskState = '';
let pendingIntent = '';
let conversationEnded = false;
let persistEnabled = false;
let metricsEnabled = false;
let restoringProgress = false;
let outcomeId = '';
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
    guided: '对话节奏陪伴',
};

function setPrivacyStatus(message) {
    if (privacyStatus) privacyStatus.textContent = message;
}

function removeSavedProgress(message = '') {
    removeStorage(PROGRESS_KEY);
    if (clearLocalProgress) clearLocalProgress.hidden = true;
    if (message) setPrivacyStatus(message);
}

function saveProgress() {
    if (!persistEnabled || restoringProgress) return;
    if (supportMode || riskState) {
        removeSavedProgress('为保护你，安全支持模式的内容不会保存。');
        return;
    }
    const history = conversationHistory.slice(-6).filter((item) => (
        ['user', 'assistant'].includes(item.role) && typeof item.content === 'string'
    ));
    const saved = writeStorage(PROGRESS_KEY, JSON.stringify({
        version: 1,
        activeScenario,
        flowStage,
        selectedAction,
        actionStatus,
        initialStress,
        finalStress,
        history,
        savedAt: new Date().toISOString(),
    }));
    if (clearLocalProgress) clearLocalProgress.hidden = !saved;
    setPrivacyStatus(saved ? '进度已仅保存在这台设备。' : '浏览器未允许保存，当前对话不受影响。');
}

async function recordOutcome({ withdrawn = false } = {}) {
    if (restoringProgress || (!metricsEnabled && !withdrawn)) return;
    if (!outcomeId) {
        outcomeId = readStorage(OUTCOME_ID_KEY) || createEventId();
        writeStorage(OUTCOME_ID_KEY, outcomeId);
    }
    try {
        await ensureCsrfToken();
        const body = new URLSearchParams({
            event_id: outcomeId,
            scenario: activeScenario || 'general',
            initial_stress: initialStress === null ? '' : String(initialStress),
            final_stress: finalStress === null ? '' : String(finalStress),
            action_completed: String(actionStatus === 'completed'),
        });
        if (withdrawn) body.set('consent', 'withdrawn');
        const response = await fetch('/api/outcomes/', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-CSRFToken': csrf,
            },
            body,
        });
        if (!response.ok) throw new Error('Outcome request failed');
        if (withdrawn) {
            removeStorage(OUTCOME_ID_KEY);
            outcomeId = '';
            setPrivacyStatus('本次匿名数据已删除。');
        } else {
            setPrivacyStatus('已匿名记录本次的结构化结果，不包含对话原文。');
        }
    } catch {
        setPrivacyStatus('匿名数据暂未保存，当前对话不受影响。');
    }
}

function setConversationEnded(ended) {
    conversationEnded = Boolean(ended);
    form.classList.toggle('is-ended', conversationEnded);
    input.disabled = conversationEnded;
    sendButton.disabled = conversationEnded || pending;
    conversationChoices.hidden = conversationEnded || supportMode;
    resumeConversation.hidden = !conversationEnded;
    input.placeholder = conversationEnded
        ? '本次对话已结束，需要时可以再继续。'
        : '从一句话开始，说说你的心情吧…';
}

function updateDialogueStage(stage, status = actionStatus) {
    if (!stageOrder.includes(stage)) return;
    flowStage = stage;
    const activeIndex = stageOrder.indexOf(stage);
    const flowComplete = stage === 'action' && status === 'completed';
    dialogueStageLabel.textContent = flowComplete ? '这一小步，已经完成' : stageLabels[stage];
    dialogueStageLabel.closest('.dialogue-path')?.classList.toggle('is-complete', flowComplete);
    dialogueStages.forEach((item, index) => {
        const completedStage = index < activeIndex || (flowComplete && index === activeIndex);
        const activeStage = !flowComplete && index === activeIndex;
        item.classList.toggle('active', activeStage);
        item.classList.toggle('done', completedStage);
        item.classList.toggle('complete', flowComplete && index === activeIndex);
        const marker = item.querySelector('span');
        if (marker) marker.textContent = flowComplete && index === activeIndex ? '✓' : String(index + 1);
        item.setAttribute('aria-label', `第${index + 1}步 ${item.querySelector('b')?.textContent || ''}${completedStage ? '，已完成' : ''}`);
        if (activeStage) item.setAttribute('aria-current', 'step');
        else item.removeAttribute('aria-current');
    });
    saveProgress();
}

function submitGuidedUpdate(text, stage = 'action') {
    if (pending || !text) return false;
    updateDialogueStage(stage);
    input.value = text;
    resizeInput();
    form.requestSubmit();
    return true;
}

function renderActionCard(card, restoredStatus = '') {
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
        saveProgress();
        scrollMessages();
    });
    accept.addEventListener('click', () => {
        actionCard.classList.add('is-accepted');
        accept.disabled = true;
        accept.textContent = '这一步，已经选好了';
        conversationHistory.push({ role: 'user', content: '我选择的今日行动是：' + steps[stepIndex] });
        selectedAction = steps[stepIndex];
        actionStatus = 'selected';
        updateDialogueStage('action');
        companionStatus.textContent = '不用做完全部，先陪你迈出这一小步';
        announcement.textContent = '已选定今日行动：' + steps[stepIndex];
        next.hidden = false;
        saveProgress();
        scrollMessages(true);
    });
    start.addEventListener('click', () => {
        actionCard.classList.add('is-running');
        actionStatus = 'started';
        start.disabled = true;
        start.textContent = '正在进行';
        nextStatus.textContent = '已经开始。先试十分钟，不用追求做完；有任何进展或阻碍，都可以回来告诉我。';
        companionStatus.textContent = '我会在这里，等你按自己的节奏回来';
        announcement.textContent = '行动已经开始。完成或卡住时，可以选择下面的按钮继续。';
        saveProgress();
    });
    function followUp(message, state, status, nextActionStatus) {
        if (pending || actionCard.classList.contains('is-following-up')) return;
        actionCard.classList.add('is-following-up', state);
        nextStatus.textContent = status;
        actionStatus = nextActionStatus;
        updateDialogueStage(state === 'is-adjusting' ? 'control' : 'action', actionStatus);
        saveProgress();
        if (actionStatus === 'completed') recordOutcome();
        if (!submitGuidedUpdate(message, state === 'is-adjusting' ? 'control' : 'action')) {
            actionCard.classList.remove('is-following-up', state);
        }
    }
    completeAction.addEventListener('click', () => followUp(
        '我完成了行动卡里的这一步，想和你简单复盘一下。',
        'is-complete',
        '收到你的进展了。我们一起看看，是什么帮助你完成了这一步。',
        'completed'
    ));
    stuck.addEventListener('click', () => followUp(
        '我尝试了行动卡里的这一步，但现在卡住了，请陪我看看阻碍在哪里。',
        'is-stuck',
        '卡住不等于失败。你已经把具体情况告诉我，我们一起看看阻碍。',
        'stuck'
    ));
    smaller.addEventListener('click', () => followUp(
        '这张行动卡对我来说还是有点难，请帮我换成一个更轻、更容易开始的步骤。',
        'is-adjusting',
        '好的，我们把这一步再缩小，不勉强现在的自己。',
        'adjusting'
    ));
    messages.append(actionCard);
    if (restoredStatus) {
        actionCard.classList.add('is-accepted');
        accept.disabled = true;
        accept.textContent = '这一步，已经选好了';
        next.hidden = false;
        if (restoredStatus === 'started') {
            actionCard.classList.add('is-running');
            start.disabled = true;
            start.textContent = '正在进行';
            nextStatus.textContent = '已恢复到“正在进行”。可以继续完成，也可以告诉我哪里卡住了。';
        } else if (restoredStatus === 'completed') {
            actionCard.classList.add('is-following-up', 'is-complete');
            nextStatus.textContent = '这一步已经完成。';
        } else if (restoredStatus === 'stuck') {
            actionCard.classList.add('is-following-up', 'is-stuck');
            nextStatus.textContent = '上次停在了“卡住”。可以继续说说阻碍，不用重新开始。';
        } else if (restoredStatus === 'adjusting') {
            actionCard.classList.add('is-following-up', 'is-adjusting');
            nextStatus.textContent = '上次决定把步骤继续缩小。';
        }
        if (['completed', 'stuck', 'adjusting'].includes(restoredStatus)) {
            actionCard.querySelectorAll('.action-progress-actions button').forEach((button) => { button.disabled = true; });
        }
    }
    scrollMessages(true);
}

function stressChangeCopy(before, after) {
    if (before === null) {
        return {
            title: `已记录此刻的感受：${after} 分`,
            message: '没有记录开始时的分数也没关系。愿意停下来感受自己，本身就是一种照顾。',
        };
    }
    const change = before - after;
    if (change > 0) {
        return {
            title: `比刚开始轻了 ${change} 分`,
            message: '这不代表所有问题都消失了，但说明你已经为自己腾出了一点空间。',
        };
    }
    if (change < 0) {
        return {
            title: '现在似乎比刚开始更紧绷',
            message: '谢谢你如实记录。变化不是失败的证明，先暂停任务、照顾当下的自己也很重要。',
        };
    }
    return {
        title: '此刻的感受暂时没有明显变化',
        message: '没有立刻变轻也不代表这一步没有意义。你已经完成了一次停下来、看见自己的练习。',
    };
}

function renderCompletionSummary(restoredRating = null) {
    if (completionSummaryRendered || !completionSummaryTemplate) return;
    completionSummaryRendered = true;
    const summary = completionSummaryTemplate.content.firstElementChild.cloneNode(true);
    const action = selectedAction || '刚才为自己选择的那一小步';
    const prompt = summary.querySelector('.completion-prompt');
    const result = summary.querySelector('.completion-result');
    const comparison = summary.querySelector('.stress-comparison');
    summary.querySelector('.completion-action').textContent = `你完成了：${action}`;
    prompt.textContent = initialStress === null
        ? '现在，再轻轻感受一下：此刻的压力大约有几分？'
        : `开始时你记录了 ${initialStress} 分。现在的压力大约有几分？`;

    const ratingButtons = summary.querySelectorAll('.completion-stress-options [data-stress]');
    function applyRating(value, announce = true) {
            finalStress = Number(value);
            summary.querySelectorAll('.completion-stress-options [data-stress]').forEach((item) => {
                item.setAttribute('aria-pressed', String(Number(item.dataset.stress) === finalStress));
            });
            const copy = stressChangeCopy(initialStress, finalStress);
            result.hidden = false;
            result.querySelector('strong').textContent = copy.title;
            result.querySelector('p').textContent = copy.message;
            if (initialStress !== null) {
                comparison.hidden = false;
                const before = comparison.querySelector('.stress-before');
                const after = comparison.querySelector('.stress-after');
                before.querySelector('b').style.width = `${initialStress * 20}%`;
                after.querySelector('b').style.width = `${finalStress * 20}%`;
                before.querySelector('em').textContent = `${initialStress} 分`;
                after.querySelector('em').textContent = `${finalStress} 分`;
            }
            summary.classList.add('is-rated');
            if (announce) announcement.textContent = `${copy.title}。${copy.message}`;
            companionStatus.textContent = '谢谢你照顾并认真看见了自己';
            saveProgress();
            recordOutcome();
            scrollMessages(true);
    }
    ratingButtons.forEach((button) => {
        button.addEventListener('click', () => applyRating(button.dataset.stress));
    });
    messages.append(summary);
    if (restoredRating !== null) applyRating(restoredRating, false);
    announcement.textContent = '行动已经完成。可以选择记录此刻的压力感受。';
    scrollMessages(true);
}

function renderSafetyCard(card) {
    messages.querySelectorAll('.safety-flow-card, .action-card, .completion-summary').forEach((item) => item.remove());
    if (!card || !safetyCardTemplate) return;
    const safetyCard = safetyCardTemplate.content.firstElementChild.cloneNode(true);
    safetyCard.querySelector('h3').textContent = card.title || '先确保此刻安全';
    safetyCard.querySelector('.safety-flow-prompt').textContent = card.prompt || '请选择最接近当前情况的一项。';
    const options = safetyCard.querySelector('.safety-flow-options');
    (Array.isArray(card.options) ? card.options : []).forEach((option) => {
        if (!option || typeof option.label !== 'string' || typeof option.message !== 'string') return;
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = option.label;
        button.classList.toggle('is-urgent', Boolean(option.urgent));
        button.addEventListener('click', () => {
            if (pending) return;
            pendingIntent = typeof option.intent === 'string' ? option.intent : '';
            input.value = option.message;
            resizeInput();
            form.requestSubmit();
        });
        options.append(button);
    });
    messages.append(safetyCard);
    scrollMessages(true);
}

function enterSafetyMode(data) {
    supportMode = true;
    riskState = data.risk_state || 'active';
    selectedAction = '';
    actionStatus = '';
    completionSummaryRendered = false;
    chatPanel?.classList.add('is-safety');
    dialogueStageLabel.textContent = '先确保此刻安全';
    dialogueStageLabel.closest('.dialogue-path')?.classList.remove('is-complete');
    dialogueStages.forEach((item, index) => {
        item.classList.remove('active', 'done', 'complete');
        item.removeAttribute('aria-current');
        const marker = item.querySelector('span');
        if (marker) marker.textContent = String(index + 1);
    });
    conversationChoices.hidden = true;
    resumeConversation.hidden = true;
    stopSpeech();
    removeSavedProgress('为保护你，安全支持模式的内容不会保存。');
    renderSafetyCard(data.safety_card);
}

function restoreProgress() {
    persistEnabled = readStorage(PROGRESS_CONSENT_KEY) === 'true';
    metricsEnabled = readStorage(METRICS_CONSENT_KEY) === 'true';
    progressConsent.checked = persistEnabled;
    metricsConsent.checked = metricsEnabled;
    outcomeId = metricsEnabled ? (readStorage(OUTCOME_ID_KEY) || '') : '';
    if (!persistEnabled) return;
    const raw = readStorage(PROGRESS_KEY);
    if (!raw) return;
    let saved;
    try {
        saved = JSON.parse(raw);
    } catch {
        removeSavedProgress('本地进度已损坏，已为你清除。');
        return;
    }
    if (!saved || saved.version !== 1 || !Array.isArray(saved.history)) {
        removeSavedProgress('无法识别之前的本地进度，已为你清除。');
        return;
    }
    restoringProgress = true;
    const validScenarios = new Set(['competition', 'research', 'coding', 'gpa', 'exam', 'setback', '']);
    const validStatuses = new Set(['', 'selected', 'started', 'completed', 'stuck', 'adjusting']);
    activeScenario = validScenarios.has(saved.activeScenario) ? saved.activeScenario : 'competition';
    flowStage = stageOrder.includes(saved.flowStage) ? saved.flowStage : 'listen';
    selectedAction = typeof saved.selectedAction === 'string' ? saved.selectedAction.slice(0, 500) : '';
    actionStatus = validStatuses.has(saved.actionStatus) ? saved.actionStatus : '';
    initialStress = [1, 2, 3, 4, 5].includes(saved.initialStress) ? saved.initialStress : null;
    finalStress = [1, 2, 3, 4, 5].includes(saved.finalStress) ? saved.finalStress : null;
    scenarios.forEach((button) => {
        const active = button.dataset.scenario === activeScenario;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    });
    initialStressOptions.forEach((button) => {
        button.setAttribute('aria-pressed', String(Number(button.dataset.stress) === initialStress));
    });
    if (initialStress !== null) {
        initialStressFeedback.textContent = `已恢复：开始时的压力是 ${initialStress} 分。`;
    }
    saved.history.slice(-6).forEach((item) => {
        if (!item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string') return;
        const content = item.content.trim().slice(0, 4000);
        if (!content) return;
        conversationHistory.push({ role: item.role, content });
        appendMessage(item.role, content);
    });
    updateDialogueStage(flowStage, actionStatus);
    if (selectedAction && actionStatus) {
        renderActionCard({
            title: '恢复的今日行动',
            step: selectedAction,
            alternatives: [],
            duration: '按你的节奏',
            note: '这是你上次为自己选的那一小步。',
        }, actionStatus);
    }
    if (actionStatus === 'completed') renderCompletionSummary(finalStress);
    conversationChoices.hidden = conversationHistory.length === 0;
    clearLocalProgress.hidden = false;
    restoringProgress = false;
    setPrivacyStatus('已从这台设备恢复上次进度。');
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
        saveProgress();
        recordOutcome();
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
        saveProgress();
        recordOutcome();
        updateCompanion();
    });
});

initialStressOptions.forEach((button) => {
    button.addEventListener('click', () => {
        initialStress = Number(button.dataset.stress);
        initialStressOptions.forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
        initialStressFeedback.textContent = `已记下：此刻压力 ${initialStress} 分。结束时我们再轻轻看一眼。`;
        announcement.textContent = initialStressFeedback.textContent;
        saveProgress();
        recordOutcome();
    });
});

progressConsent?.addEventListener('change', () => {
    persistEnabled = progressConsent.checked;
    writeStorage(PROGRESS_CONSENT_KEY, String(persistEnabled));
    if (persistEnabled) {
        saveProgress();
    } else {
        removeSavedProgress('已关闭并清除这台设备上的对话进度。');
    }
});

metricsConsent?.addEventListener('change', () => {
    metricsEnabled = metricsConsent.checked;
    writeStorage(METRICS_CONSENT_KEY, String(metricsEnabled));
    if (metricsEnabled) {
        recordOutcome();
    } else if (outcomeId || readStorage(OUTCOME_ID_KEY)) {
        outcomeId = outcomeId || readStorage(OUTCOME_ID_KEY);
        recordOutcome({ withdrawn: true });
    } else {
        setPrivacyStatus('未启用匿名效果数据。');
    }
});

clearLocalProgress?.addEventListener('click', () => {
    persistEnabled = false;
    progressConsent.checked = false;
    writeStorage(PROGRESS_CONSENT_KEY, 'false');
    removeSavedProgress('已清除这台设备上的对话进度，当前页面仍可继续使用。');
});

conversationIntentButtons.forEach((button) => {
    button.addEventListener('click', () => {
        if (pending || conversationEnded || supportMode) return;
        const messagesByIntent = {
            stay: '我现在不想回答问题，请先陪我安静待一会儿。',
            lighter: '我想先换个轻松一点的话题，让大脑喘口气。',
            end: '我想先结束本次对话。',
        };
        pendingIntent = button.dataset.conversationIntent || '';
        input.value = messagesByIntent[pendingIntent] || '';
        resizeInput();
        form.requestSubmit();
    });
});

resumeConversation?.addEventListener('click', () => {
    setConversationEnded(false);
    appendMessage('assistant', '欢迎回来。不用重新整理，可以从此刻最想说的一句开始。');
    conversationChoices.hidden = false;
    input.focus();
    announcement.textContent = '已继续对话。';
});

safetyOpenButtons.forEach((button) => {
    button.addEventListener('click', () => {
        if (!safetyDialog || safetyDialog.open) return;
        stopSpeech();
        safetyDialog.showModal();
        announcement.textContent = '已打开心理安全说明。';
    });
});

safetyCloseButtons.forEach((button) => {
    button.addEventListener('click', () => safetyDialog?.close());
});

safetyDialog?.addEventListener('click', (event) => {
    if (event.target === safetyDialog) safetyDialog.close();
});

document.addEventListener('click', (event) => {
    const button = event.target.closest('.scenario, .mood-option, .stress-scale button, .completion-stress-options button, .conversation-choices button, .safety-flow-options button, .icon-button, .safety-inline-open, [data-safety-close], #sendButton, #resumeConversation, #clearLocalProgress');
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
    const requestedIntent = pendingIntent;
    pendingIntent = '';
    try {
        await ensureCsrfToken();
        const recentHistory = conversationHistory.slice(-6);
        conversationHistory.push({ role: 'user', content: text });
        const body = new URLSearchParams({
            message: text,
            scenario: activeScenario,
            flow_stage: flowStage,
            selected_action: selectedAction,
            action_status: actionStatus,
            risk_state: riskState,
            conversation_intent: requestedIntent,
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
        if (typeof data.action_status === 'string') actionStatus = data.action_status;
        if (!supportMode) {
            riskState = '';
            chatPanel?.classList.remove('is-safety');
            updateDialogueStage(data.stage, actionStatus);
        }
        revealing = true;
        updateCompanion();
        if (voiceEnabled && !supportMode) speakReply(data.reply);
        await revealReply(thinking.querySelector('.bubble'), data.reply, supportMode);
        conversationHistory.push({ role: 'assistant', content: data.reply });
        if (supportMode) {
            enterSafetyMode(data);
            if (data.ended) {
                setConversationEnded(true);
                resumeConversation.hidden = true;
            }
        } else {
            renderActionCard(data.action_card);
            if (actionStatus === 'completed') renderCompletionSummary();
            setConversationEnded(Boolean(data.ended));
            if (!data.ended) conversationChoices.hidden = false;
            saveProgress();
            recordOutcome();
        }
        chatStatus.textContent = supportMode
            ? '安全支持模式'
            : (providerLabels[data.provider] || '在这里陪你');
        chatStatus.dataset.provider = supportMode ? 'safety' : (data.provider || 'unknown');
        announcement.textContent = data.reply;
    } catch (error) {
        pendingIntent = requestedIntent;
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
        sendButton.disabled = conversationEnded;
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
    // Voice names are device-specific; prefer youthful, light Chinese voices.
    const preferredNames = [
        /xiaoyi|晓伊/i,
        /yaoyao|瑶瑶/i,
        /xiaoxiao|晓晓/i,
        /xiaomeng|晓梦/i,
        /child|girl|童声|少女/i,
        /huihui|慧慧/i,
        /tingting|婷婷/i,
    ];
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
    current.pitch = 1.42;
    current.rate = 1.06;
    current.volume = 0.84;
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

restoreProgress();
updateDraft();
updateCompanion();

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
        if (voiceEnabled && !pending && !utterance && conversationHistory.length === 0) {
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
