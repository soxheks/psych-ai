from django.http import JsonResponse
from django.shortcuts import render
from django.views.decorators.http import require_POST

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


def home(request):
    return render(request, 'core/home.html', {'scenario_prompts': SCENARIO_PROMPTS})


@require_POST
def chat(request):
    message = request.POST.get('message', '').strip()
    scenario = request.POST.get('scenario', '').strip()

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
        })

    try:
        reply, provider = generate_ai_reply(message, scenario)
    except AIUnavailable:
        reply = build_supportive_reply(message, scenario)
        provider = 'fallback'

    return JsonResponse({'reply': reply, 'provider': provider})


def build_supportive_reply(message, scenario):
    scene = {
        'competition': '竞赛压力常常来自高强度比较和截止日期',
        'research': '科研和课题的不确定性会把人拖进“没有进展”的挫败感里',
        'coding': '调试卡住时，大脑很容易把“这个 bug 很难”误读成“我不行”',
        'gpa': '绩点焦虑会让人把一次成绩看成对整个人的评判',
        'exam': '备考焦虑常常会同时消耗注意力和信心',
        'setback': '学业受挫后，最难的是把一次结果和长期能力分开看',
    }.get(scenario, '学业压力会让人同时感到疲惫、焦虑和孤单')

    return (
        f'{scene}。我先不急着给你下结论，先陪你把问题拆小一点。\n\n'
        f'从你刚才说的“{message[:80]}”里，我会先关注三个层面：'
        '发生了什么、它让你最担心什么、以及今天能不能先做一个很小的可控动作。\n\n'
        '你可以按这个格式回我：\n'
        '1. 现在最卡住我的点是：\n'
        '2. 我最害怕的结果是：\n'
        '3. 今天我还有力气做的一小步是：\n\n'
        '如果你现在脑子很乱，也可以只回答第 1 条。'
    )
