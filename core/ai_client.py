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
6. 尚未行动时可给出一个很小、今天能做的下一步；用户已完成行动时先复盘，不立刻布置新任务。
7. 遵循当前指定的陪伴阶段，不要跳过倾听直接说教，也不要一次提出多个问题。
8. 不使用“你应该”“想开点”等命令或轻描淡写的表达。回复控制在 220 字以内。
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


PHASE_GUIDANCE = {
    'clarify': (
        '当前阶段是“看清压力”。先用一两句话共情，再分别指出你听到的事实和可能的担心。'
        '最后只问一个具体、容易回答的问题，暂时不要给任务清单。'
    ),
    'control': (
        '当前阶段是“找到可控”。承接前文，区分暂时无法控制的结果与今天能够控制的动作。'
        '给出不超过两个温和选项，并说明页面会提供一张可选择的今日行动卡。最后只问一个问题。'
    ),
    'action': (
        '当前阶段是“迈出一步”。关注学生尝试小行动后的感受和阻碍，肯定任何微小进展。'
        '“用户已选择的行动”会单独提供，必须准确理解并围绕这个具体行动回应，不要再询问用户选了什么。'
        '帮助调整步骤的难度，最后只问一个简短的复盘问题。'
    ),
}

ACTION_STATUS_LABELS = {
    'selected': '已选择，尚未说明已经开始',
    'started': '已经开始进行',
    'completed': '已经明确完成',
    'stuck': '已经尝试但遇到阻碍',
    'adjusting': '认为原步骤太难，正在缩小步骤',
}

ACTION_STATUS_GUIDANCE = {
    'selected': '用户只是选定了行动，不要误称已经完成；可以温和确认准备从哪里开始。',
    'started': '用户已经开始，不要再问是否开始；关注当前进展或阻碍。',
    'completed': (
        '用户已经明确完成该行动。绝对不要再邀请用户开始、尝试、今天再做一点，'
        '也不要把已经完成的行动说成将来的任务。结合上一轮问题理解“有、是、轻松一点”等简短回答，'
        '围绕完成后的感受、有效方法和可复用经验进行复盘。'
    ),
    'stuck': '用户已经实际尝试但卡住了，不要把卡住说成没有行动；只帮助定位一个具体阻碍。',
    'adjusting': '用户认为原步骤太难；不要催促执行原步骤，帮助把它缩小或换成更轻的动作。',
}


def generate_ai_reply(message, scenario, history=None, phase='clarify', selected_action='', action_status=''):
    provider = settings.AI_PROVIDER.lower()

    if provider in ('auto', 'doubao', 'ark') and settings.ARK_API_KEY:
        try:
            return call_doubao(message, scenario, history, phase, selected_action, action_status), 'doubao'
        except AIUnavailable:
            if provider in ('doubao', 'ark'):
                raise

    if provider in ('auto', 'gemini') and settings.GEMINI_API_KEY:
        try:
            return call_gemini(message, scenario, history, phase, selected_action, action_status), 'gemini'
        except AIUnavailable:
            if provider == 'gemini':
                raise

    if provider in ('auto', 'ollama'):
        try:
            return call_ollama(message, scenario, history, phase, selected_action, action_status), 'ollama'
        except AIUnavailable:
            if provider == 'ollama':
                raise

    raise AIUnavailable('No configured AI provider is available.')


def build_user_prompt(message, scenario, history=None, phase='clarify', selected_action='', action_status=''):
    scenario_label = SCENARIO_LABELS.get(scenario, '一般学业压力')
    recent_context = []
    for item in (history or [])[-6:]:
        speaker = '学生' if item.get('role') == 'user' else '心研同伴'
        recent_context.append(f'{speaker}：{item.get("content", "")[:500]}')
    context = '\n'.join(recent_context) if recent_context else '这是本轮对话的第一次表达。'
    guidance = PHASE_GUIDANCE.get(phase, PHASE_GUIDANCE['clarify'])
    status_label = ACTION_STATUS_LABELS.get(action_status, '尚无明确行动状态')
    status_guidance = ACTION_STATUS_GUIDANCE.get(action_status, '')
    return (
        f'当前场景：{scenario_label}\n'
        f'用户已选择的行动：{selected_action[:500] if selected_action else "尚未选择"}\n'
        f'行动当前状态：{status_label}\n'
        f'最近对话（仅用于本次回复）：\n{context}\n\n'
        f'学生最新表达：{message}\n\n'
        f'{guidance}\n{status_guidance}\n'
        '只输出要直接对学生说的话，不输出阶段名称、分析过程或格式说明。'
    )


def call_gemini(message, scenario, history=None, phase='clarify', selected_action='', action_status=''):
    model = settings.GEMINI_MODEL
    url = f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent'
    payload = {
        'systemInstruction': {
            'parts': [{'text': SYSTEM_PROMPT}],
        },
        'contents': [
            {
                'role': 'user',
                'parts': [{'text': build_user_prompt(message, scenario, history, phase, selected_action, action_status)}],
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


def call_doubao(message, scenario, history=None, phase='clarify', selected_action='', action_status=''):
    url = settings.ARK_BASE_URL.rstrip('/') + '/chat/completions'
    payload = {
        'model': settings.DOUBAO_MODEL,
        'messages': [
            {'role': 'system', 'content': SYSTEM_PROMPT},
            {'role': 'user', 'content': build_user_prompt(message, scenario, history, phase, selected_action, action_status)},
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


def call_ollama(message, scenario, history=None, phase='clarify', selected_action='', action_status=''):
    url = settings.OLLAMA_URL.rstrip('/') + '/api/chat'
    payload = {
        'model': settings.OLLAMA_MODEL,
        'stream': False,
        'messages': [
            {'role': 'system', 'content': SYSTEM_PROMPT},
            {'role': 'user', 'content': build_user_prompt(message, scenario, history, phase, selected_action, action_status)},
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
