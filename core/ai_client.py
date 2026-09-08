import json
import urllib.error
import urllib.request

from django.conf import settings


SYSTEM_PROMPT = """
你是“心研同伴”，一个面向高校在校大学生的 AI 心理沟通智能体。
核心受众是大学生，重点支持学业高压群体，包括学科竞赛、科研课题、代码调试、绩点焦虑、备考压力和学业受挫。

你的边界：
1. 你提供情绪支持、压力梳理、认知重构和行动拆解。
2. 你不做医学诊断，不替代心理咨询师、精神科医生或紧急救助。
3. 如果用户表达自杀、自残、伤害自己、伤害他人或强烈危机风险，要优先建议立刻联系身边可信任的人、学校心理中心、辅导员或当地紧急救助。
4. 语气要温和、具体、尊重，不说教，不轻易评价用户。
5. 回复应使用简体中文，适合大学生阅读。
6. 每次回复尽量给出一个很小、今天能做的下一步。
""".strip()


SCENARIO_LABELS = {
    'competition': '学科竞赛',
    'research': '科研课题',
    'coding': '代码调试',
    'gpa': '绩点焦虑',
    'exam': '备考压力',
    'setback': '学业受挫',
}


class AIUnavailable(Exception):
    pass


def generate_ai_reply(message, scenario):
    provider = settings.AI_PROVIDER.lower()

    if provider in ('auto', 'doubao', 'ark') and settings.ARK_API_KEY:
        try:
            return call_doubao(message, scenario), 'doubao'
        except AIUnavailable:
            if provider in ('doubao', 'ark'):
                raise

    if provider in ('auto', 'gemini') and settings.GEMINI_API_KEY:
        try:
            return call_gemini(message, scenario), 'gemini'
        except AIUnavailable:
            if provider == 'gemini':
                raise

    if provider in ('auto', 'ollama'):
        try:
            return call_ollama(message, scenario), 'ollama'
        except AIUnavailable:
            if provider == 'ollama':
                raise

    raise AIUnavailable('No configured AI provider is available.')


def build_user_prompt(message, scenario):
    scenario_label = SCENARIO_LABELS.get(scenario, '一般学业压力')
    return (
        f'当前场景：{scenario_label}\n'
        f'学生表达：{message}\n\n'
        '请先共情和确认压力，再帮助学生把问题拆成“事实、担心、可控小行动”。'
        '结尾给一个可以继续对话的问题。'
    )


def call_gemini(message, scenario):
    model = settings.GEMINI_MODEL
    url = f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent'
    payload = {
        'systemInstruction': {
            'parts': [{'text': SYSTEM_PROMPT}],
        },
        'contents': [
            {
                'role': 'user',
                'parts': [{'text': build_user_prompt(message, scenario)}],
            }
        ],
        'generationConfig': {
            'temperature': 0.7,
            'maxOutputTokens': 700,
        },
    }
    headers = {
        'Content-Type': 'application/json',
        'x-goog-api-key': settings.GEMINI_API_KEY,
    }

    data = request_json(url, payload, headers=headers, timeout=30)
    try:
        return data['candidates'][0]['content']['parts'][0]['text'].strip()
    except (KeyError, IndexError, TypeError) as exc:
        raise AIUnavailable('Gemini returned an unexpected response.') from exc


def call_doubao(message, scenario):
    url = settings.ARK_BASE_URL.rstrip('/') + '/chat/completions'
    payload = {
        'model': settings.DOUBAO_MODEL,
        'messages': [
            {'role': 'system', 'content': SYSTEM_PROMPT},
            {'role': 'user', 'content': build_user_prompt(message, scenario)},
        ],
        'temperature': 0.7,
        'max_tokens': 700,
    }
    headers = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {settings.ARK_API_KEY}',
    }

    data = request_json(url, payload, headers=headers, timeout=30)
    try:
        return data['choices'][0]['message']['content'].strip()
    except (KeyError, IndexError, TypeError) as exc:
        raise AIUnavailable('Doubao returned an unexpected response.') from exc


def call_ollama(message, scenario):
    url = settings.OLLAMA_URL.rstrip('/') + '/api/chat'
    payload = {
        'model': settings.OLLAMA_MODEL,
        'stream': False,
        'messages': [
            {'role': 'system', 'content': SYSTEM_PROMPT},
            {'role': 'user', 'content': build_user_prompt(message, scenario)},
        ],
        'options': {
            'temperature': 0.7,
        },
    }

    data = request_json(url, payload, timeout=8)
    try:
        return data['message']['content'].strip()
    except (KeyError, TypeError) as exc:
        raise AIUnavailable('Ollama returned an unexpected response.') from exc


def request_json(url, payload, headers=None, timeout=20):
    encoded = json.dumps(payload).encode('utf-8')
    request = urllib.request.Request(
        url,
        data=encoded,
        headers=headers or {'Content-Type': 'application/json'},
        method='POST',
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode('utf-8'))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise AIUnavailable(str(exc)) from exc
