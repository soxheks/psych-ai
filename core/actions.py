import re

from .conversation import unquoted_text


SCENARIO_STATEMENTS = {
    'competition': r'我(?:现在|正在|最近|在|要|准备)*准备(?:学科)?竞赛|我(?:正在|在)参加(?:学科)?竞赛',
    'research': r'我(?:现在|正在|最近|在)*(?:做科研|做课题|做实验|写论文)',
    'coding': r'我(?:现在|正在|最近|在)*(?:写代码|调试代码|调试程序)',
    'gpa': r'我(?:现在|最近)?(?:很)?(?:担心|焦虑)(?:自己的|我的)?绩点|我的绩点(?:下降|掉)',
    'exam': r'我(?:现在|正在|最近|在)*(?:备考|准备考试|复习考试)',
    'setback': r'我(?:这次|最近)?(?:考试没过|挂科了|考试不及格)',
}


def resolve_scenario(scenario, message, history=None, selected_action=''):
    # Existing action identity wins over later mentions; never replace a chosen step.
    if selected_action:
        for key, card in ACTION_CARDS.items():
            variants = [step for pair in SIMPLE_ACTIONS.get(key, []) for step in pair]
            if selected_action in [*card['steps'], *variants]:
                return key
        return scenario if scenario in ACTION_CARDS else 'general'
    expressions = [item.get('content', '') for item in (history or []) if item.get('role') == 'user']
    expressions.append(message)
    for expression in reversed(expressions):
        current = unquoted_text(expression)
        # Questions and hypothetical/third-party reports are not self-reported context.
        if re.search(r'如果|假如|要是|比如|例如|朋友说|同学说|[？?]', current):
            continue
        matches = {key for key, pattern in SCENARIO_STATEMENTS.items() if re.search(pattern, current)}
        if len(matches) == 1:
            return matches.pop()
        if len(matches) > 1:
            break
    return scenario if scenario in ACTION_CARDS else 'general'


def action_was_presented(step, history, memory=None):
    def normalize(text):
        return re.sub(r'[\s。！？!?，,；;：:“”]', '', text)

    action = normalize(step)
    return bool(action) and (action in {
        normalize(item) for item in (memory or {}).get('presented_actions', [])
    } or any(
        action in normalize(item.get('content', ''))
        for item in (history or []) if item.get('role') == 'assistant'
    ))


def new_action_card(scenario, selected_action, phase, history, memory=None):
    if phase != 'control':
        return None
    card = build_action_card(scenario, selected_action)
    return None if action_was_presented(card['step'], history, memory) else card


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


# Each pair shrinks the same action, rather than substituting a different task.
SIMPLE_ACTIONS = {
    'competition': [
        ('只看截止最近的一项任务，写下一个开头，花两分钟就停。', '只写出截止最近的那项任务名称，写到这里就可以停。'),
        ('只写一项必须完成的竞赛任务，暂时不用分类其他任务。', '只圈出当前最要紧的一个任务。'),
        ('只写一句最想向队友确认的问题，不需要现在发送。', '只写下那处不确定的关键词。'),
    ],
    'research': [
        ('只写一句已经尝试的方法，暂时不用整理全部假设和验证计划。', '只记下最近一次尝试的名称或关键词。'),
        ('只看一段记录或文献，记下一个要点，两分钟就停。', '只圈出一条想保留的记录或文献句子。'),
        ('只写一句目前卡住的问题，暂时不用联系任何人。', '只写下卡住位置的一个关键词。'),
    ],
    'coding': [
        ('只记录报错信息和触发它的一个动作，暂时不用完成最小复现。', '只抄下最后一行报错，做到这里就可以停。'),
        ('只写一句实际结果，暂时不用追查全部差异。', '只记下一个与预期不一样的结果。'),
        ('先离开屏幕半分钟，回来只看一处输入，不要求修好。', '只把视线从屏幕移开，停半分钟。'),
    ],
    'gpa': [
        ('只选一门想改善的课，写下一件能试两分钟的事。', '只写出那门课的名称，暂时不用拟计划。'),
        ('先关掉成绩比较页面，只写一件自己已经做到的事。', '只关掉成绩比较页面，先停在这里。'),
        ('只写一句学习方法的问题，暂时不用发给老师或同学。', '只记下想问的学习方法关键词。'),
    ],
    'exam': [
        ('只看一条公式或一小段内容，专注两分钟，到点就停。', '只读一条公式或一句内容，读完就可以停。'),
        ('只看一道题的第一步，试两分钟，不要求做完整题。', '只读一道题的题干，圈出一个已知条件。'),
        ('只选一小段复习内容，看两分钟就停。', '只圈出今天想看的那一小段内容。'),
    ],
    'setback': [
        ('只写下这次结果让你知道的一条信息，暂时不拟调整计划。', '只记下这次最想回看的一个细节。'),
        ('只写一句这次没做好的具体事情，不评价自己整个人。', '只写下那个具体事情的名称。'),
        ('只写一句想告诉可信任的人的事实，暂时不用发出。', '只选一个愿意联系的可信任的人，不必现在联系。'),
    ],
    'general': [
        ('只开始原来那件事的一个小开头，两分钟就停。', '只为原来那件事做一个准备动作，做到这里就停。'),
        ('只写一句脑子里的担心，暂时不用想办法处理。', '只记下这份担心的一个关键词。'),
        ('只喝一小口水或慢慢呼气一次，不需要立刻决定下一件事。', '只慢慢呼气一次，按自己的节奏停下来。'),
    ],
}


def simplify_action(selected_action, scenario, level=1):
    for key, card in ACTION_CARDS.items():
        for index, original in enumerate(card['steps']):
            pair = SIMPLE_ACTIONS[key][index]
            if selected_action in (original, *pair):
                return pair[min(max(level, 1), 2) - 1]
    # Unknown restored actions keep their identity rather than inventing a new task.
    return f'只为“{selected_action[:160].rstrip("。") }”做一个最小准备动作，做到这里就停。'


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
        'note': '这是一个可选的小步骤；现在只想聊聊也可以。',
    }
