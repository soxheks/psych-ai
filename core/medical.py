"""Narrow, non-diagnostic responses to explicit assessment/prescribing requests."""

import re

from .conversation import unquoted_text


CONDITION = re.compile(r'抑郁症|焦虑症|双相|躁郁|精神分裂|心理疾病|精神疾病|心理障碍|精神障碍')
ASSESSMENT = re.compile(
    r'是不是|是否|有没有|会不会|算不算|可能是|'
    r'(?:能|可以|请|帮我|你|为我).{0,10}(?:确定|确认|诊断|判断|排除)|'
    r'(?:得了|患上|更像|只是|就是).{0,12}[？?吗]'
)
PRESCRIBING = re.compile(
    r'(?:吃|用|开|推荐|给我).{0,8}(?:什么药|哪种药|点药|药名|剂量)|'
    r'(?:药|剂量).{0,8}(?:多少|多大|怎么|能不能|可以|应该)|'
    r'(?:能不能|可以|应该|要不要).{0,6}(?:停药|换药|加药|减药)'
)


def medical_boundary_reply(message, history=None):
    current = unquoted_text(message)
    if PRESCRIBING.search(current):
        return (
            '我听见你希望尽快缓解现在的不适。这里不能为你选药、开药或决定剂量，'
            '也不能指导你自行停药、换药。药物是否适合你，需要由医生评估；'
            '已经在用药时，请联系开药医生或药师核实用法。我们仍可以聊聊这段不适带给你的感受。'
        )
    recent_user = ' '.join(item.get('content', '') for item in (history or [])[-4:]
                           if item.get('role') == 'user')
    diagnostic = CONDITION.search(current) and ASSESSMENT.search(current)
    followup = CONDITION.search(recent_user) and re.search(
        r'(?:能|可以|帮我).{0,6}(?:排除|确定|诊断)|(?:是不是|更像|只是|就是).{0,8}(?:压力|焦虑|紧张)', current,
    )
    if not (diagnostic or followup):
        return ''
    return (
        '担心自己是不是生病了，这份不安值得被认真对待。仅凭这段对话，我不能确认或排除心理疾病，'
        '也不能把这些不适判断成“只是学业压力”。原因需要结合持续时间、生活影响和既往情况由专业人员评估。'
        '如果不适持续或影响睡眠、学习和日常生活，可以联系学校心理中心寻求支持，并到正规医疗机构的精神心理科评估。'
        '在这里，你仍可以按自己的节奏说说感受，不必急着给自己下结论。'
    )
