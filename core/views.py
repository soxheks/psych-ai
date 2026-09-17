import json
import re

from django.http import JsonResponse
from django.middleware.csrf import get_token
from django.shortcuts import render
from django.views.decorators.cache import cache_control, never_cache
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_POST

from .ai_client import AIUnavailable, generate_ai_reply


SCENARIO_PROMPTS = {
    'competition': '我正在准备学科竞赛，任务很多，感觉自己一直不够好。',
    'research': '我在做科研或课题，进展很慢，担心辜负老师期待。',
    'coding': '我写代码调试很久都跑不通，开始怀疑自己是不是不适合。',
    'gpa': '我很焦虑绩点，看到同学成绩好就特别慌。',
    'exam': '我在备考，越临近考试越难集中注意力。',
    'setback': '我学业受挫了，感觉努力没有回报。',
}

RISK_WORDS = (
    '自杀',
    '轻生',
    '不想活',
    '结束生命',
    '伤害自己',
    '自残',
    '活不下去',
)

ACTION_STATUSES = {'selected', 'started', 'completed', 'stuck', 'adjusting'}
RELIEF_PATTERNS = (
    '我好多了', '好多了', '好一点了', '轻松了', '轻松一点', '轻松了一点',
    '没那么焦虑', '没那么难受', '踏实了', '缓过来了',
)
COMPLETED_RESTART_PATTERNS = (
    '能不能先', '可以先做', '今天能花', '今天先做', '有没有开始',
    '还没开始', '现在开始', '先做一点', '尝试一下',
)

ACTION_CARDS = {
    'competition': {
        'title': '先圈出最关键的一项',
        'steps': [
            '打开任务清单，只圈出截止最近且最重要的一项，写下它的第一个动作。',
            '把当前竞赛任务分成“必须完成、可以优化、暂时放下”三栏，各写一项。',
            '找出最不确定的一处，用一句话写成准备向队友或老师确认的问题。',
        ],
    },
    'research': {
        'title': '留下一个可见的进展',
        'steps': [
            '写下当前假设、已经尝试的方法，以及下一项可以验证的操作。',
            '只整理一段实验记录或一篇文献的三个要点，不要求今天得出结论。',
            '把卡住的位置写成一个具体问题，准备发给同伴或老师确认。',
        ],
    },
    'coding': {
        'title': '把问题缩小一圈',
        'steps': [
            '保存当前版本，写出最小复现步骤，接下来只验证一个变量。',
            '把报错信息和预期结果各写一句，再定位最早出现差异的位置。',
            '离开屏幕两分钟，回来后只检查输入、状态和边界条件中的一项。',
        ],
    },
    'gpa': {
        'title': '回到能控制的事情',
        'steps': [
            '选出本周最有机会改善的一门课，只写下一次可以完成的具体行动。',
            '暂时关掉成绩比较页面，列出一项已经做到和一项可以调整的事情。',
            '给一位任课老师或同学准备一个关于学习方法的具体问题。',
        ],
    },
    'exam': {
        'title': '开始一个短专注',
        'steps': [
            '选择一个最小知识点，关闭其他窗口，专注十分钟后停下来确认进度。',
            '只做一道最能暴露薄弱点的题，完成后记录卡住的具体步骤。',
            '把今天的复习目标缩成一页、一节或十分钟能完成的范围。',
        ],
    },
    'setback': {
        'title': '把结果和能力分开',
        'steps': [
            '写下这次结果提供的一条信息，再选一个今天能够调整的动作。',
            '分别写一句“这次没有做好什么”和“这不代表我是什么样的人”。',
            '找一位可信任的人，只说明事实和你现在最需要的一种支持。',
        ],
    },
    'general': {
        'title': '只做眼前的一小步',
        'steps': [
            '给自己十分钟，只开始眼前最容易完成的一件小事，时间到就停下来看看感受。',
            '把脑子里的担心写成三句话，再圈出其中唯一能在今天处理的一句。',
            '先喝几口水、慢慢呼气三次，再决定接下来只做哪一件事。',
        ],
    },
}


@cache_control(public=True, max_age=300, s_maxage=3600, stale_while_revalidate=86400)
def landing(request):
    return render(request, 'core/landing.html')


@ensure_csrf_cookie
@cache_control(private=True, max_age=300)
def home(request):
    return render(request, 'core/home.html', {'scenario_prompts': SCENARIO_PROMPTS})


@cache_control(public=True, max_age=300, s_maxage=3600, stale_while_revalidate=86400)
def journal(request):
    return render(request, 'core/journal.html')


@require_GET
@never_cache
def service_worker(request):
    response = render(request, 'core/service-worker.js', content_type='application/javascript')
    response['Service-Worker-Allowed'] = '/'
    return response


@require_GET
@never_cache
@ensure_csrf_cookie
def csrf(request):
    return JsonResponse({'csrfToken': get_token(request)})


@require_POST
def chat(request):
    message = request.POST.get('message', '').strip()
    scenario = request.POST.get('scenario', '').strip()
    flow_stage = request.POST.get('flow_stage', 'listen').strip()
    history = parse_history(request.POST.get('history', '[]'))
    selected_action = request.POST.get('selected_action', '').strip()[:500]
    requested_action_status = request.POST.get('action_status', '').strip()
    action_status = requested_action_status if requested_action_status in ACTION_STATUSES else ''

    if not message:
        return JsonResponse({'reply': '我在这里。你可以先用一句话说说：最近最压着你的那件学业相关的事是什么？'})

    if any(word in message for word in RISK_WORDS):
        return JsonResponse({
            'reply': (
                '我听到你现在可能处在很危险、很痛苦的时刻。请先把安全放在第一位：'
                '尽快联系身边可信任的人、辅导员、学校心理中心，或当地紧急救助渠道。'
                '如果你愿意，也可以先回我一句“我现在身边有人”或“我现在一个人”，我们先一起把当下这几分钟稳住。'
            ),
            'risk': True,
            'stage': 'safety',
            'action_card': None,
        })

    phase = next_phase(flow_stage)

    try:
        reply, provider = generate_ai_reply(
            message,
            scenario,
            history=history,
            phase=phase,
            selected_action=selected_action,
            action_status=action_status,
        )
    except AIUnavailable:
        reply = build_supportive_reply(message, scenario, phase, selected_action, action_status)
        provider = 'fallback'

    reply = enforce_action_state(reply, selected_action, action_status)
    reply = enforce_conversation_quality(reply, message, history, action_status)
    reply = anchor_selected_action(reply, phase, selected_action, action_status)
    reply = normalize_reply_punctuation(reply)
    action_card = build_action_card(scenario, selected_action) if phase == 'control' else None
    return JsonResponse({
        'reply': reply,
        'provider': provider,
        'stage': phase,
        'action_status': action_status,
        'action_card': action_card,
    })


def parse_history(raw_history):
    try:
        candidate = json.loads(raw_history)
    except (TypeError, json.JSONDecodeError):
        return []
    if not isinstance(candidate, list):
        return []
    history = []
    for item in candidate[-6:]:
        if not isinstance(item, dict) or item.get('role') not in ('user', 'assistant'):
            continue
        content = item.get('content')
        if isinstance(content, str) and content.strip():
            history.append({'role': item['role'], 'content': content.strip()[:500]})
    return history


def next_phase(flow_stage):
    return {
        'listen': 'clarify',
        'clarify': 'control',
        'control': 'control',
        'action': 'action',
    }.get(flow_stage, 'clarify')


def action_text(selected_action):
    return selected_action.strip().rstrip('。！？!?；;，, ')


def anchor_selected_action(reply, phase, selected_action, action_status=''):
    clean_action = action_text(selected_action)
    if (
        not clean_action
        or phase not in ('control', 'action')
        or action_status == 'completed'
        or clean_action in reply
    ):
        return reply
    if phase == 'control':
        lead = f'你刚才选择的“{clean_action}”现在感觉有些难，我们把它再缩小一点。'
    elif action_status == 'stuck':
        lead = f'你已经尝试了“{clean_action}”，现在遇到了阻碍。'
    else:
        lead = f'你当前选择的是“{clean_action}”。'
    return f'{lead}\n\n{reply}'


def enforce_action_state(reply, selected_action, action_status):
    if action_status != 'completed' or not any(pattern in reply for pattern in COMPLETED_RESTART_PATTERNS):
        return reply
    clean_action = action_text(selected_action) or '刚才那一小步'
    return (
        f'你已经完成了“{clean_action}”，这一步已经真实发生了，不需要再从头开始。\n\n'
        '能感觉到压力轻了一点，是很值得记住的反馈。先让自己缓一缓；愿意时再回看有效的方法，也完全来得及。'
    )


def is_relief_message(message):
    normalized = re.sub(r'[\s。！？!?~～]', '', message)
    return normalized in ('有', '是', '有一点') or any(pattern in message for pattern in RELIEF_PATTERNS)


def normalize_question(question):
    return re.sub(r'[\s“”‘’"《》：，、。！？!?~～]', '', question)


def question_is_repeated(question, previous_questions):
    normalized = normalize_question(question)
    if len(normalized) < 5:
        return False
    for previous in previous_questions:
        old = normalize_question(previous)
        if normalized == old or normalized in old or old in normalized:
            return True
        shorter, longer = sorted((normalized, old), key=len)
        if len(shorter) >= 8 and len(set(shorter) & set(longer)) / len(set(shorter)) >= 0.86:
            return True
    return False


def remove_repeated_questions(reply, history):
    previous_questions = []
    for item in history:
        if item.get('role') == 'assistant':
            previous_questions.extend(re.findall(r'[^。！；;\n～~]*[？?]', item.get('content', '')))
    if not previous_questions:
        return reply, False

    repeated = False

    def keep_or_remove(match):
        nonlocal repeated
        question = match.group(0)
        if question_is_repeated(question, previous_questions):
            repeated = True
            return ''
        return question

    cleaned = re.sub(r'[^。！；;\n～~]*[？?]', keep_or_remove, reply)
    cleaned = re.sub(r'[ \t]+\n', '\n', cleaned)
    cleaned = re.sub(r'\n{3,}', '\n\n', cleaned).strip(' \n，,；;')
    return cleaned, repeated


def completed_relief_reply():
    return (
        '听到你说“好多了”，我也替你松了一口气。你已经让混乱的事情清楚了一点，'
        '也重新找回了一些掌控感，这份变化很真实。\n\n'
        '刚才这一小步已经完成了，现在不用急着回答更多问题。先让自己在这份轻松里停一会儿吧。'
    )


def enforce_conversation_quality(reply, message, history, action_status):
    reply, repeated = remove_repeated_questions(reply, history)
    if action_status == 'completed' and is_relief_message(message):
        return completed_relief_reply()
    if repeated and not reply:
        return '我不继续追问了。你已经说得很清楚，我们可以先在这里停一会儿，我会陪着你。'
    return reply


def normalize_reply_punctuation(reply):
    reply = re.sub(r'([。！？!?])([”’"])。', r'\1\2', reply)
    reply = re.sub(r'([。！？!?])\1+', r'\1', reply)
    reply = re.sub(r'([，、；：])\1+', r'\1', reply)
    return reply.strip()


def build_action_card(scenario, excluded_step=''):
    card = ACTION_CARDS.get(scenario, ACTION_CARDS['general'])
    steps = [step for step in card['steps'] if step != excluded_step]
    if excluded_step in card['steps']:
        steps.append(excluded_step)
    return {
        'title': card['title'],
        'step': steps[0],
        'alternatives': steps[1:],
        'duration': '约 10 分钟',
        'note': '不求一次做好，只确认这一步是否适合现在的你。',
    }


def build_supportive_reply(message, scenario, phase='clarify', selected_action='', action_status=''):
    scene = {
        'competition': '竞赛压力常常来自高强度比较和截止日期',
        'research': '科研和课题的不确定性会把人拖进“没有进展”的挫败感里',
        'coding': '调试卡住时，大脑很容易把“这个 bug 很难”误读成“我不行”',
        'gpa': '绩点焦虑会让人把一次成绩看成对整个人的评判',
        'exam': '备考焦虑常常会同时消耗注意力和信心',
        'setback': '学业受挫后，最难的是把一次结果和长期能力分开看',
    }.get(scenario, '学业压力会让人同时感到疲惫、焦虑和孤单')

    excerpt = message[:80]
    if phase == 'control':
        if selected_action:
            return (
                f'你刚才选择的“{selected_action}”对现在的你来说还是有些难，这个反馈很重要。'
                '我们不勉强自己硬撑，而是把动作继续缩小。\n\n'
                '我在下面换了一张行动卡。你可以看看，哪一步更接近“现在就能开始”？'
            )
        return (
            f'我听见了，你现在面对的不只是任务本身，还有“{excerpt}”带来的担心。'
            '结果和别人的评价暂时不完全由你控制，但今天从哪里开始、把步骤缩到多小，是可以由你决定的。\n\n'
            '我在下面放了一张“今日行动卡”。你可以直接选它，也可以换一个更轻的步骤。'
            '哪一种安排会让你觉得更容易开始一点？'
        )
    if phase == 'action':
        action = action_text(selected_action) or '刚才选定的那一步'
        if action_status == 'completed':
            if is_relief_message(message):
                return completed_relief_reply()
            return (
                f'收到啦，你已经完成了“{action}”。在有压力的时候还能迈出并完成这一小步，很不容易。\n\n'
                '如果你愿意，我们可以把有效的方法留给下一次；如果现在只想休息一下，也完全可以。'
            )
        if action_status == 'stuck' or '卡住' in message:
            return (
                f'你尝试的是“{action}”，现在卡住了。卡住说明这一步里还有需要继续拆开的地方，不代表你没有行动。\n\n'
                '具体停在哪个位置：不知道怎么开始、过程中遇到问题，还是担心做得不够好？'
            )
        return (
            f'你正在尝试“{action}”。你提到“{excerpt}”，这已经让我知道当前进展在哪里了。\n\n'
            '接下来你更需要继续做一点，还是先把遇到的阻碍拆小？'
        )
    return (
        f'{scene}。你提到“{excerpt}”，我能感觉到这件事正在占用你很多精力。'
        '我们先不急着解决全部。\n\n'
        '如果把它分开看：现在已经发生的事实是什么，而你最担心接下来会发生什么？'
        '你可以只说其中比较容易回答的一部分。'
    )
