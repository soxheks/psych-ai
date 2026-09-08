const messages = document.querySelector('#messages');
const form = document.querySelector('#chatForm');
const input = document.querySelector('#messageInput');
const csrf = document.querySelector('[name=csrfmiddlewaretoken]').value;
const scenarios = document.querySelectorAll('.scenario');

let activeScenario = 'competition';

scenarios.forEach((button) => {
    button.addEventListener('click', () => {
        scenarios.forEach((item) => item.classList.remove('active'));
        button.classList.add('active');
        activeScenario = button.dataset.scenario;
        input.value = button.dataset.prompt;
        input.focus();
    });
});

form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const text = input.value.trim();
    if (!text) {
        return;
    }

    appendMessage('user', text);
    input.value = '';
    input.style.height = '';

    const thinking = appendMessage('assistant', '我正在听，也在帮你把这件事拆得更清楚一点...');

    try {
        const body = new URLSearchParams();
        body.set('message', text);
        body.set('scenario', activeScenario);

        const response = await fetch('/api/chat/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-CSRFToken': csrf,
            },
            body,
        });

        const data = await response.json();
        thinking.querySelector('.bubble').textContent = data.reply;
        thinking.dataset.provider = data.provider || 'fallback';
        thinking.classList.toggle('risk', Boolean(data.risk));
    } catch (error) {
        thinking.querySelector('.bubble').textContent = '网络或服务暂时没有响应。你可以先把这句话留在这里，等一下再试。';
    }

    messages.scrollTop = messages.scrollHeight;
});

input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
});

function appendMessage(role, text) {
    const article = document.createElement('article');
    article.className = `message ${role}`;

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = role === 'user' ? '我' : 'AI';

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;

    article.append(avatar, bubble);
    messages.append(article);
    messages.scrollTop = messages.scrollHeight;

    return article;
}
