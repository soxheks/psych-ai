"""Bounded, extractive session context and conservative conversation pacing."""

import json
import re


LISTEN_REQUEST = re.compile(r'只想.{0,8}(聊|说|倾诉|听)|不想.{0,8}(建议|办法|行动|任务|回答|分析)|别.{0,5}(问|催|建议)|先.{0,6}听我|先陪我(?:安静|待|坐|缓|歇)|暂时.{0,5}(不做|不聊任务)')
DISTRESS = re.compile(r'崩溃|撑不住|喘不过气|一直哭|哭了|想哭|很难受|好难受|太难受|好累|很疲惫|脑子很乱')
OVERWHELMED = re.compile(r'崩溃|撑不住|喘不过气|一直哭|脑子很乱|太难受')
ACTION_REQUEST = re.compile(r'怎么(做|开始)|(?<!不知道)怎么办|如何.{0,5}(开始|做)|(?:有什么|有没有).{0,8}(办法|建议)|不知道.{0,8}(从哪.{0,3}开始|怎么下手)|给我.{0,6}(建议|步骤|行动)|帮我.{0,10}(拆|计划|安排|选|找.{0,4}步骤)|(?:想|愿意|可以|打算).{0,8}(试试|行动|做一点|开始)|准备好了|可以开始|选.{0,8}(小步骤|小行动)')
CONTROL_COMMITMENT = re.compile(
    r'(?:能|可以)控制的(?:是|有)|'
    r'(?:先|马上|接下来)(?:花|用)?\s*(?:\d+|[一二三四五六七八九十几]+)\s*分钟|'
    r'(?:先|马上|接下来).{0,12}(?:检查|修改|测试|整理|复现|练习|复习|处理|准备|完成)'
)
CLARIFY_REQUEST = re.compile(r'帮我.{0,6}(梳理|分析|理清)|想.{0,4}(梳理|分析|理清)')
NOT_READY = re.compile(r'还没想好|不想做|不想开始|(不|没|别|暂不).{0,5}(想做|想开始|准备好|行动|建议|开始|办法)|不要.{0,6}怎么(办|做)')
QUESTION = re.compile(r'[^。！!；;\n？?]+[？?]')
END_REQUEST = re.compile(r'(今天|这次|本次|我们)?先?聊到这[里儿]?|结束本次对话|今天不聊了|先不聊了')
PERSONAL_TOPIC = re.compile(r'失恋|分手|感情问题|恋爱|想念[他她]|室友关系|家庭矛盾|朋友绝交')
NOT_ACADEMIC = re.compile(
    r'(?:跟|和|与).{0,10}(?:学习|考试|学业|备考).{0,5}(?:无关|没有关系|没关系)|'
    r'不是.{0,4}(?:考试|学习|学业|备考)(?:的)?(?:事情|问题|事)|不想把.{0,12}变成学习任务'
)
ACADEMIC_RETURN = re.compile(
    r'(?:回到|重新聊|继续聊|现在聊|先聊|还是聊|现在想聊|再聊).{0,6}'
    r'(?:学习|考试|备考|学业|代码|调试|论文|科研|竞赛|绩点)|'
    r'我(?:现在|正在|在)?(?:备考|复习|写代码|做科研|学业受挫|很焦虑绩点)|'
    r'我(?:正在|在)?准备(?:学科)?竞赛'
)
COMPLETION = re.compile(
    r'^(?:我(?:说)?(?:刚才|刚刚)?(?:把|的)?)?'
    r'(?:(?:刚才|选好|选定|行动卡里)的?)?'
    r'(?:(?:这|那)一步|这步|那步|这个(?:步骤|行动|任务))?'
    r'(?:我)?(?:(?:已经|刚刚|刚才|现在|今天|终于|确实|真的|都|全部|也))*'
    r'(?:完成|做完|做好|写完|整理完|搞定)(?:了|啦)'
    r'(?=$|[呀啊啦]|(?:这|那)一步|行动卡|你(?:说|给)|刚才|现在|想|感觉|心里|但|不)'
)
ACADEMIC_CONTEXT = re.compile(r'竞赛|比赛|课题|科研|实验|论文|文献|代码|调试|报错|程序|绩点|成绩|备考|复习|考试|挂科|学业|作业|课程|上课|听课')
PRESSURE_CONTEXT = re.compile(r'担心|害怕|怕|焦虑|紧张|压力|不够好|怀疑|来不及|赶不上|太多|很多|卡|失败|不懂|不会|不通|受挫|没有回报|没进展|很慢|难|没过|走神|分心|疲惫|好累')
CLARIFY_DETAIL = re.compile(
    r'因为|主要|最怕|最担心|担心|卡在|卡住|每次|每天|一.{0,12}就|总是|反复|'
    r'还有|只剩|截止|周[一二三四五六日天]|明天|后天|下周|'
    r'看不懂|不知道|找不到|集中不了|进不去|没进展|没有进展|'
    r'报错|空值|数据库|实验|公式|章节|文献|结果|排名|及格|考砸|走神|刷手机|熬夜|听不懂|跟不上|证明'
)
SHORT_DETAIL = re.compile(r'卡在|章节|公式|数据库|实验|截止|明天|后天|下周|证明|听不懂|跟不上')


def unquoted_text(message):
    return re.sub(r'[“「"].*?[”」"]', '', message)


def bounded_context(text, limit=500):
    """Keep late corrections without increasing the existing context budget."""
    text = text.strip()
    if len(text) <= limit:
        return text
    marker = '\n[中间内容已省略]\n'
    head = (limit - len(marker)) // 2
    return text[:head] + marker + text[-(limit - len(marker) - head):]


def update_topic(message, previous=''):
    topic = previous
    for clause in re.split(r'[。！？!?；;，,\n]|但是|不过|可是|但', unquoted_text(message)):
        if NOT_ACADEMIC.search(clause) or PERSONAL_TOPIC.search(clause):
            topic = 'personal'
        elif ACADEMIC_RETURN.search(clause):
            topic = 'academic'
    return topic


def resolve_action_status(message, selected_action, current):
    """Only clear reports about the current selected step can mark it complete."""
    if not selected_action or current not in ('selected', 'started', 'stuck', 'completed'):
        return current
    resolved = current
    for sentence in re.split(r'[。！!；;\n]', unquoted_text(message)):
        if re.search(r'如果|假如|要是|等我|准备|打算|希望|争取|可能|大概|应该|差不多|好像|似乎|[？?]|吗', sentence):
            continue
        for clause in re.split(r'[，,]|但是|不过', sentence):
            clause = re.sub(r'\s+', '', clause)
            clause = re.sub(r'(?:并不是|不是|并非)(?:还|尚)?没(?:有)?开始', '', clause)
            if re.search(r'(?:还没|没有|没|未)(?:完成|做完|做好|开始|做)', clause):
                resolved = current
                continue
            if re.search(r'一半|部分|一点|一些|还剩|差点|(?:还|尚)?没|没有|未完成|不算|不是', clause):
                continue
            if COMPLETION.search(clause):
                resolved = 'completed'
    return resolved


def is_short_confirmation(message, history):
    answer = re.sub(r'[\s，。！？!?嗯啊的]', '', message)
    previous = next((item.get('content', '') for item in reversed(history or [])
                     if item.get('role') == 'assistant'), '')
    return answer in ('对', '是', '是这样', '没错', '确实', '就是这样', '是这样子') and bool(QUESTION.search(previous))


def is_explicit_correction(message):
    current = unquoted_text(message)
    return bool(re.search(
        r'你(?:理解|听|弄|猜)错|不是这个意思|我(?:刚才|已经)?说的是|'
        r'不是.{1,60}(?:而是|是我)|没有.{1,40}(?:我更|更在意)|'
        r'我更在意|纠正一下', current,
    ))


def exploration_answers(message, history=None, memory=None):
    """Count distinct questions with user responses, including bounded older context."""
    context = remember(memory or {}, message, history or [])
    answers = {}
    for pair in context.get('answered', []):
        key = re.sub(r'[\s，,。！？!?；;：:]', '', pair['question'])
        if key:
            answers[key] = pair['answer']
    return list(answers.values())


def has_action_context(message, history=None, memory=None):
    """Bridge after two useful questions, or three responses with limited information."""
    history = history or []
    memory = memory or {}
    if not any(item.get('role') == 'assistant' for item in history):
        return False
    current = unquoted_text(message).strip()
    if is_explicit_correction(current):
        return False
    if re.search(r'还没说完|等我说完|不是.{0,4}重点|[？?]|吗[。！!]*$', current):
        return False
    answers = exploration_answers(message, history, memory)
    if len(answers) < 2:
        return False
    normalize = lambda text: re.sub(r'[\s，,。！？!?；;]', '', text)
    previous = [item.get('content', '') for item in history if item.get('role') == 'user']
    previous.extend(memory.get('facts', []))
    previous.append(memory.get('concern', ''))
    previous = [unquoted_text(text) for text in previous
                if len(text) >= 4 and normalize(text) not in (normalize(message), normalize(message[:180]))]
    previous_context = '。'.join(previous)
    if not (ACADEMIC_CONTEXT.search(previous_context) and PRESSURE_CONTEXT.search(previous_context + current)):
        return False
    if len(answers) >= 3:
        return True
    for answer in answers:
        detail = unquoted_text(answer)
        if re.search(r'说不清|不知道怎么说|不知道怎么办|不知道原因|不确定', detail):
            continue
        if len(detail) >= 4 and CLARIFY_DETAIL.search(detail) and (len(detail) >= 8 or SHORT_DETAIL.search(detail)):
            return True
    return False


def current_preference(message):
    """Resolve explicit changes in order; quoted past wishes do not set the pace."""
    current = unquoted_text(message)
    current = re.sub(r'(?:并不是|不是|并非)(?:还|尚)?没(?:有)?开始', '', current)
    preference = ''
    for clause in re.split(r'[。！？!?；;，,\n]|但是|不过|但现在|现在', current):
        willingness = re.sub(r'不知道.{0,8}(?:从哪.{0,3}开始|怎么下手)', '', clause)
        if NOT_READY.search(willingness) or LISTEN_REQUEST.search(clause):
            preference = 'listen'
        elif CLARIFY_REQUEST.search(clause):
            preference = 'clarify'
        elif ACTION_REQUEST.search(clause) or CONTROL_COMMITMENT.search(clause):
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
    for key, limit in (('facts', 8), ('questions', 12), ('presented_actions', 12)):
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
    result['topic'] = value.get('topic') if value.get('topic') in ('personal', 'academic') else ''
    return result


def remember(memory, message, history, reply='', intent='', action_card=None):
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
            result['topic'] = update_topic(content, result.get('topic', ''))
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
    if action_card:
        result.setdefault('presented_actions', []).append(action_card['step'])
    return parse_memory(result)


def choose_phase(message, action_status='', memory=None, history=None):
    memory = memory or {}
    preference = current_preference(message)
    if preference == 'listen':
        return 'listen'
    # Ordinary distress can coexist with exploration after support; acute overwhelm cannot.
    current = unquoted_text(message)
    supported = any(item.get('role') == 'assistant' for item in (history or []))
    if preference != 'action' and (OVERWHELMED.search(current) or (DISTRESS.search(current) and not supported)):
        return 'listen'
    if preference == 'clarify':
        return 'clarify'
    action_update = re.search(r'我.{0,3}(完成|开始|卡住)|这一步太难|已经完成', message) or (
        resolve_action_status(message, '当前步骤', 'selected') == 'completed'
    )
    if memory.get('preference') == 'listen' and preference != 'action' and not action_update:
        return 'listen'
    if memory.get('topic') == 'personal':
        return 'clarify'
    if action_status == 'completed':
        return 'action'
    if action_status == 'adjusting':
        return 'control'
    if action_status in ('selected', 'started', 'stuck'):
        return 'action'
    if preference == 'action':
        return 'control'
    if has_action_context(message, history, memory):
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
