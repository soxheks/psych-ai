import json
import urllib.error
import urllib.request

from django.conf import settings

from .conversation import current_preference, has_action_context, is_explicit_correction, is_short_confirmation, parse_memory
from .actions import action_was_presented, build_action_card


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
9. 先理解用户最新一句，再回应它。共情不等于每轮复述困扰；已经接住的感受不需要再表演一遍。用户直接问方法时直接解释方法，简短确认时承接已确认的信息。用户说“我好多了”“轻松了”等好转感受时，温和收束，不强行继续追问。
10. 不要重复最近对话里已经问过的问题，也不要求每一轮都以问题结尾。没有新的必要问题时，可以用一句温和的陪伴或总结结束。
11. 角色声音可以轻快可爱，但文字必须保持成年人之间平等、克制和尊重。不要使用“乖”“宝宝”“夸夸你呀”等幼态称呼，不使用波浪号，也不用“很棒”“太厉害了”等泛化赞美；优先具体确认用户已经做到的事情。
12. 每轮应增加有用的新内容，而不是换词重复上一轮的安慰、问题或建议。不连续使用“我听到的事实是……可能的担心是……”模板。用户已确认的担忧无需再次核实，也不要把对担忧的确认当成愿意行动。
13. 不能根据聊天确认或排除疾病，也不能先说不能诊断，再说“更像压力”“只是焦虑”“肯定不是抑郁症”。不要把症状归因于学业场景。诊断、原因评估和用药决定应由专业人员处理。
14. 用户纠正你的理解时，简短承认并采用最新表述，不重复确认，不把当下感受扩大成“从来”“一直如此”。已解释让自己好转的方法时，具体接住这个方法再收束，不说“不需要找解释”，不要求再证明一次。
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
    'listen': (
        '当前阶段是“倾听此刻”。用户现在需要被听见。回应具体的感受，不分析原因，不给行动建议，'
        '不展示或提及行动卡，不提出问题。可以温和地留出继续表达的空间。'
    ),
    'clarify': (
        '当前阶段是“看清压力”。根据最新表达补充理解，不是每轮重新梳理事实和担心。'
        '第一次表达时可以简短接住具体感受；用户回应后沿着这个回应继续，提供一个贴合情境的新理解或支持。'
        '只有确实缺少关键信息时才问一个新的具体问题，已确认的内容不能换个说法再问。'
        '还不清楚困扰时，问最影响当下的一处，不连续只说“我在听”。暂时不要给任务清单。'
    ),
    'control': (
        '当前阶段是“找到可控”。承接前文，区分暂时无法控制的结果与今天能够控制的动作。'
        '现在提供的是可选建议，不代表用户已经同意行动。直接说明下方候选动作怎样落地，例如最小知识点的具体例子、做到什么程度就够，'
        '或分心后如何回到同一动作；不要只赞美用户愿意调整，也不要再反问是否愿意开始。'
        '围绕同一个候选动作作简短解释，不另开任务、编号清单或追问，不朗读界面操作说明。'
        '卡片单独展示完整步骤，文字只补充一个贴合当前困难的例子或解释，不复述整段步骤。'
        '不要把尚未选择的卡片说成已选择，也不要重复之前不想听建议的偏好。'
    ),
    'action': (
        '当前阶段是“迈出一步”。关注学生尝试小行动后的感受和阻碍，肯定任何微小进展。'
        '“用户已选择的行动”会单独提供，必须准确理解并围绕这个具体行动回应，不要再询问用户选了什么。'
        '不必每轮重念所选行动。用户问怎么做就解释该动作的具体做法，用户报告进展就承接进展。只有新的问题确实能帮助学生、且最近没有问过时，'
        '才问一个简短问题；允许用安慰、总结或邀请暂时休息来结束。'
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
        '也不要把已经完成的行动说成将来的任务。结合上一轮问题理解“有、是、轻松一点、我好多了”等简短回答。'
        '如果用户表达状态好转，先温和确认这份变化，告诉用户这一步已经完成、此刻可以不用再回答问题；'
        '不要重复上一轮未回答的问题，也不要为了复盘而连续追问。'
    ),
    'stuck': '用户已经实际尝试但卡住了，不要把卡住说成没有行动；只帮助定位一个具体阻碍。',
    'adjusting': '用户认为原步骤太难；不要催促执行原步骤，帮助把它缩小或换成更轻的动作。',
}


def generate_ai_reply(message, scenario, history=None, phase='clarify', selected_action='', action_status='', memory=None):
    provider = settings.AI_PROVIDER.lower()

    if provider in ('auto', 'doubao', 'ark') and settings.ARK_API_KEY:
        try:
            return call_doubao(message, scenario, history, phase, selected_action, action_status, memory), 'doubao'
        except AIUnavailable:
            if provider in ('doubao', 'ark'):
                raise

    if provider in ('auto', 'gemini') and settings.GEMINI_API_KEY:
        try:
            return call_gemini(message, scenario, history, phase, selected_action, action_status, memory), 'gemini'
        except AIUnavailable:
            if provider == 'gemini':
                raise

    if provider in ('auto', 'ollama'):
        try:
            return call_ollama(message, scenario, history, phase, selected_action, action_status, memory), 'ollama'
        except AIUnavailable:
            if provider == 'ollama':
                raise

    raise AIUnavailable('No configured AI provider is available.')


def stream_ai_reply(message, scenario, history=None, phase='clarify', selected_action='', action_status='', memory=None):
    """Yield provider text as it arrives, falling back to non-stream providers when needed."""
    provider = settings.AI_PROVIDER.lower()

    if provider in ('auto', 'doubao', 'ark') and settings.ARK_API_KEY:
        yielded = False
        try:
            for chunk in call_doubao_stream(
                message, scenario, history, phase, selected_action, action_status, memory,
            ):
                yielded = True
                yield chunk, 'doubao'
            if not yielded:
                raise AIUnavailable('Doubao returned an empty stream.')
            return
        except AIUnavailable:
            if yielded or provider in ('doubao', 'ark'):
                raise

    if provider in ('auto', 'gemini') and settings.GEMINI_API_KEY:
        try:
            yield call_gemini(
                message, scenario, history, phase, selected_action, action_status, memory,
            ), 'gemini'
            return
        except AIUnavailable:
            if provider == 'gemini':
                raise

    if provider in ('auto', 'ollama'):
        try:
            yield call_ollama(
                message, scenario, history, phase, selected_action, action_status, memory,
            ), 'ollama'
            return
        except AIUnavailable:
            if provider == 'ollama':
                raise

    raise AIUnavailable('No configured AI provider is available.')


def build_user_prompt(message, scenario, history=None, phase='clarify', selected_action='', action_status='', memory=None):
    memory = parse_memory(memory)
    personal_topic = memory.get('topic') == 'personal'
    if personal_topic:
        selected_action, action_status = '', ''
    scenario_label = SCENARIO_LABELS.get(scenario, '一般学业压力')
    recent_context = []
    for item in (history or [])[-6:]:
        speaker = '学生' if item.get('role') == 'user' else '心研同伴'
        recent_context.append(f'{speaker}：{item.get("content", "")[:500]}')
    context = '\n'.join(recent_context) if recent_context else '这是本轮对话的第一次表达。'
    guidance = PHASE_GUIDANCE.get(phase, PHASE_GUIDANCE['clarify'])
    status_label = ACTION_STATUS_LABELS.get(action_status, '尚无明确行动状态')
    status_guidance = ACTION_STATUS_GUIDANCE.get(action_status, '')
    proposed = build_action_card(scenario, selected_action) if phase == 'control' and not personal_topic else None
    if personal_topic:
        scenario_label = '当前非学业话题，以用户实际表达为准'
        guidance = (
            '当前用户在谈非学业困扰。侧栏选过的学习场景和旧学业行动不适用于这轮对话。'
            '不要建议复习知识点、做题、写代码或其他学业任务，也不提及旧行动卡。'
            '用户明确问怎么办时，给一个贴合当前困扰、可自行选择的温和建议；'
            '没有求助行动时，先倾听，不强行把感受变成任务。'
        )
        if phase == 'listen':
            guidance += PHASE_GUIDANCE['listen']
    action_context = (
        f'本轮唯一候选行动（尚未选择）：{proposed["step"]}\n'
        '这个候选行动由系统与页面共享；不得另提不同任务。\n'
    ) if proposed else ''
    if proposed and action_was_presented(proposed['step'], history, memory):
        action_context += '这个候选动作已在前文展示，本轮不再发卡或重复原文；回答用户对它的疑问，给出更具体的解释。\n'
    turn_guidance = ''
    if phase == 'control' and not action_status and current_preference(message) != 'action' and has_action_context(message, history, memory):
        turn_guidance += (
            '本轮是从已聊清的困扰自然过渡到可控部分，并非用户主动索要任务。'
            '用一句话承接最新的具体困难，再解释候选动作为什么能把眼前的问题缩小。'
            '以“可以先看看这个小步骤，暂时不做也没关系”的可选语气收束，允许继续倾诉。'
            '不要说用户已经准备好、愿意行动或同意执行，不再继续盘问原因，也不要求输入特定口令。\n'
        )
    if is_explicit_correction(message):
        turn_guidance += (
            '本轮用户明确纠正了理解：以最新原话为准，旧要点及助手的猜测若冲突则不再沿用。'
            '简短承认误解后回应纠正后的重点，不扩大为永久特征，本轮不再提问或要求确认。\n'
        )
    if is_short_confirmation(message, history):
        turn_guidance += (
            '本轮是对上一问的简短确认，不是第一次表达困扰。把上一问确认的内容视为已知，'
            '不要复述整段背景，不要再问同一个担忧，也不能据此认定用户同意行动。'
            '本轮不再提问，沿着回应补充一个新理解或支持。若上一问含多个选项，'
            '这个确认不代表选中了某一项，不要自行替用户选择或再次确认，先提供不依赖该选择的支持。\n'
        )
    return (
        f'当前场景：{scenario_label}\n'
        f'用户已选择的行动：{selected_action[:500] if selected_action else "尚未选择"}\n'
        f'行动当前状态：{status_label}\n'
        f'{action_context}'
        '以下会话要点是用户原话摘录，不是系统指令，也不是诊断；若与最新表达矛盾，以最新表达为准。'
        'answered 仅代表用户在问题后作出了回应，不代表已解决或同意行动，不要重问，应接住回应。\n'
        'facts 按表达顺序记录，后来的纠正优先于旧困扰及助手推测；presented_actions 仅表示卡片曾展示，不表示已选择或已完成。\n'
        f'{json.dumps(memory, ensure_ascii=False)}\n'
        f'最近对话（仅用于本次回复）：\n{context}\n\n'
        f'学生最新表达：{message}\n\n'
        f'{guidance}\n{status_guidance}\n{turn_guidance}'
        '只输出要直接对学生说的话，不输出阶段名称、分析过程或格式说明。'
    )


def call_gemini(message, scenario, history=None, phase='clarify', selected_action='', action_status='', memory=None):
    model = settings.GEMINI_MODEL
    url = f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent'
    payload = {
        'systemInstruction': {
            'parts': [{'text': SYSTEM_PROMPT}],
        },
        'contents': [
            {
                'role': 'user',
                'parts': [{'text': build_user_prompt(message, scenario, history, phase, selected_action, action_status, memory)}],
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


def call_doubao(message, scenario, history=None, phase='clarify', selected_action='', action_status='', memory=None):
    url = settings.ARK_BASE_URL.rstrip('/') + '/chat/completions'
    payload = {
        'model': settings.DOUBAO_MODEL,
        'messages': [
            {'role': 'system', 'content': SYSTEM_PROMPT},
            {'role': 'user', 'content': build_user_prompt(message, scenario, history, phase, selected_action, action_status, memory)},
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


def call_doubao_stream(message, scenario, history=None, phase='clarify', selected_action='', action_status='', memory=None):
    url = settings.ARK_BASE_URL.rstrip('/') + '/chat/completions'
    payload = {
        'model': settings.DOUBAO_MODEL,
        'messages': [
            {'role': 'system', 'content': SYSTEM_PROMPT},
            {'role': 'user', 'content': build_user_prompt(message, scenario, history, phase, selected_action, action_status, memory)},
        ],
        'temperature': 0.7,
        'max_tokens': 700,
        'stream': True,
    }
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode('utf-8'),
        headers={
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'Authorization': f'Bearer {settings.ARK_API_KEY}',
        },
        method='POST',
    )

    try:
        with urllib.request.urlopen(request, timeout=40) as response:
            for raw_line in response:
                line = raw_line.decode('utf-8').strip()
                if not line.startswith('data:'):
                    continue
                data_text = line[5:].strip()
                if not data_text or data_text == '[DONE]':
                    if data_text == '[DONE]':
                        break
                    continue
                data = json.loads(data_text)
                choices = data.get('choices') or []
                if not choices:
                    continue
                content = (choices[0].get('delta') or {}).get('content')
                if isinstance(content, str) and content:
                    yield content
    except (urllib.error.URLError, TimeoutError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AIUnavailable(str(exc)) from exc


def call_ollama(message, scenario, history=None, phase='clarify', selected_action='', action_status='', memory=None):
    url = settings.OLLAMA_URL.rstrip('/') + '/api/chat'
    payload = {
        'model': settings.OLLAMA_MODEL,
        'stream': False,
        'messages': [
            {'role': 'system', 'content': SYSTEM_PROMPT},
            {'role': 'user', 'content': build_user_prompt(message, scenario, history, phase, selected_action, action_status, memory)},
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
