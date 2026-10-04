import re


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
