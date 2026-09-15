const form = document.getElementById('journalForm');
const input = document.getElementById('journalInput');
const count = document.getElementById('characterCount');
const finishButton = document.getElementById('finishButton');
const hint = document.getElementById('journalHint');
const stage = document.getElementById('journalStage');
const flightLayer = document.getElementById('flightLayer');
const foldingText = document.getElementById('foldingText');
const complete = document.getElementById('journalComplete');
const writeAgain = document.getElementById('writeAgain');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let sending = false;
let completionTimer;

function updateInputState() {
    const length = Array.from(input.value).length;
    count.textContent = String(length);
    finishButton.disabled = sending || !input.value.trim();
    hint.textContent = input.value.trim() ? '写好了，就把它轻轻放下。' : '不署名，也不需要给谁看。';
}

function showComplete() {
    stage.classList.remove('is-sending');
    flightLayer.setAttribute('aria-hidden', 'true');
    form.hidden = true;
    complete.hidden = false;
    complete.focus();
}

form.addEventListener('submit', (event) => {
    event.preventDefault();
    const note = input.value.trim();
    if (!note || sending) return;

    sending = true;
    finishButton.disabled = true;
    foldingText.textContent = note;
    flightLayer.setAttribute('aria-hidden', 'false');
    stage.classList.add('is-sending');
    window.clearTimeout(completionTimer);
    completionTimer = window.setTimeout(showComplete, reducedMotion.matches ? 120 : 3650);
});

writeAgain.addEventListener('click', () => {
    window.clearTimeout(completionTimer);
    sending = false;
    input.value = '';
    foldingText.textContent = '';
    complete.hidden = true;
    form.hidden = false;
    stage.classList.remove('is-sending');
    updateInputState();
    input.focus();
});

input.addEventListener('input', updateInputState);
window.addEventListener('pagehide', () => window.clearTimeout(completionTimer));
updateInputState();
