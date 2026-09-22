"""Bounded, extractive session context and conservative conversation pacing."""

import json
import re


LISTEN_REQUEST = re.compile(r'只想.{0,8}(聊|说|倾诉|听)|不想.{0,8}(建议|办法|行动|任务|回答|分析)|别.{0,5}(问|催|建议)|先.{0,6}(陪|听我)|暂时.{0,5}(不做|不聊任务)')
DISTRESS = re.compile(r'崩溃|撑不住|喘不过气|一直哭|哭了|想哭|很难受|好难受|太难受|好累|很疲惫|脑子很乱')
ACTION_REQUEST = re.compile(r'怎么(做|开始)|如何.{0,5}(开始|做)|给我.{0,6}(建议|步骤|行动)|帮我.{0,10}(拆|计划|安排|选|找.{0,4}步骤)|(?:想|愿意|可以|打算).{0,8}(试试|行动|做一点|开始)|准备好了|可以开始|选.{0,8}(小步骤|小行动)')
CLARIFY_REQUEST = re.compile(r'帮我.{0,6}(梳理|分析|理清)|想.{0,4}(梳理|分析|理清)')
NOT_READY = re.compile(r'还没想好|不想做|不想开始|(不|没|别|暂不).{0,5}(想做|想开始|准备好|行动|建议|开始|办法)|不要.{0,6}怎么(办|做)')
QUESTION = re.compile(r'[^。！!；;\n？?]+[？?]')
END_REQUEST = re.compile(r'(今天|这次|本次|我们)?先?聊到这[里儿]?|结束本次对话|今天不聊了|先不聊了')


def current_preference(message):
    """Resolve explicit changes in order; quoted past wishes do not set the pace."""
    current = re.sub(r'[“「].*?[”」]', '', message)
    preference = ''
    for clause in re.split(r'[。！？!?；;，,\n]|但是|不过|但现在|现在', current):
        if NOT_READY.search(clause) or LISTEN_REQUEST.search(clause):
            preference = 'listen'
        elif CLARIFY_REQUEST.search(clause):
            preference = 'clarify'
        elif ACTION_REQUEST.search(clause):
            preference = 'action'
    return preference


def clean_text(value, limit=180):
    return value.strip()[:limit] if isinstance(value, str) else ''


def parse_memory(value):
    if isinstance(value, str):
        if len(value) > 16000:
            return {}
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            return {}
    if not isinstance(value, dict):
        return {}
    result = {'concern': clean_text(value.get('concern'), 240)}
    for key, limit in (('facts', 8), ('questions', 12)):
        items = value.get(key)
        result[key] = list(dict.fromkeys(
            clean_text(item) for item in items if clean_text(item)
        ))[-limit:] if isinstance(items, list) else []
    pairs = value.get('answered')
    result['answered'] = [
        {'question': clean_text(item.get('question')), 'answer': clean_text(item.get('answer'))}
        for item in pairs[-6:] if isinstance(item, dict)
        and clean_text(item.get('question')) and clean_text(item.get('answer'))
    ] if isinstance(pairs, list) else []
    result['preference'] = value.get('preference') if value.get('preference') in ('listen', 'clarify', 'action') else ''
    return result


def remember(memory, message, history, reply='', intent=''):
    result = parse_memory(memory)
    result.setdefault('concern', '')
    facts = result.setdefault('facts', [])
    questions = result.setdefault('questions', [])
    answered = result.setdefault('answered', [])
    previous_question = ''
    for item in [*history, {'role': 'user', 'content': message}]:
        content = clean_text(item.get('content'), 500)
        if item.get('role') == 'assistant':
            found = QUESTION.findall(content)
            for question in found:
                if question not in questions:
                    questions.append(question[:180])
            previous_question = found[-1][:180] if found else ''
        elif item.get('role') == 'user' and content:
            if not result['concern'] or (len(result['concern']) < 8 and len(content) >= 8):
                result['concern'] = content[:240]
            if len(content) >= 8 and content[:180] not in facts:
                facts.append(content[:180])
            if previous_question:
                pair = {'question': previous_question, 'answer': content[:180]}
                if pair not in answered:
                    answered.append(pair)
                previous_question = ''
    for question in QUESTION.findall(reply):
        if question[:180] not in questions:
            questions.append(question[:180])
    preference = current_preference(message)
    if intent in ('stay', 'lighter'):
        result['preference'] = 'listen'
    elif preference:
        result['preference'] = preference
    return parse_memory(result)


def choose_phase(message, action_status='', memory=None):
    memory = memory or {}
    preference = current_preference(message)
    if preference == 'listen':
        return 'listen'
    if DISTRESS.search(message) and preference != 'action':
        return 'listen'
    if preference == 'clarify':
        return 'clarify'
    action_update = re.search(r'我.{0,3}(完成|开始|卡住)|这一步太难|已经完成', message)
    if memory.get('preference') == 'listen' and preference != 'action' and not action_update:
        return 'listen'
    if action_status == 'completed':
        return 'action'
    if action_status == 'adjusting':
        return 'control'
    if action_status in ('selected', 'started', 'stuck'):
        return 'action'
    if preference == 'action':
        return 'control'
    return 'clarify'


def take_sentences(buffer, final=False):
    """Hold the final boundary until the next chunk to absorb split punctuation."""
    sentences = []
    end = 0
    for match in re.finditer(r'[^。！？!?；;\n]*[。！？!?；;\n]+(?:[”’"]+[。！？!?；;\n]*)*', buffer):
        if not final and match.end() == len(buffer):
            break
        sentences.append(match.group())
        end = match.end()
    remainder = buffer[end:]
    if final and remainder.strip():
        sentences.append(remainder)
        remainder = ''
    return sentences, remainder
