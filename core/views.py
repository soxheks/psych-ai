import json
import hashlib
import re
import time
import uuid

from django.conf import settings
from django.core.cache import cache
from django.db.models import Avg, F, Max, Min
from django.http import JsonResponse, StreamingHttpResponse
from django.middleware.csrf import get_token
from django.shortcuts import render
from django.views.decorators.cache import cache_control, never_cache
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_POST

from .ai_client import AIUnavailable, generate_ai_reply, stream_ai_reply
from .models import OutcomeRecord
from .actions import build_action_card
from .conversation import END_REQUEST, choose_phase, parse_memory, remember, take_sentences


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
    '想死',
    '结束自己',
    '割腕',
    '跳楼',
    '吞药',
    '伤害别人',
    '杀人',
)
RISK_PATTERNS = tuple(re.compile(pattern) for pattern in (
    r'不想(?:再)?醒来',
    r'永远睡(?:着|过去)',
    r'(?:消失|离开这个世界)(?:会不会|是不是|就)?(?:更|比较)?好',
    r'活着(?:真)?(?:没|没有)意思',
    r'(?:真的)?撑不下去',
    r'不想再撑',
    r'(?:想|准备|打算).{0,8}(?:一了百了|结束一切|从楼上跳|让自己消失)',
    r'死了(?:就|也)?算了',
))
RISK_NEGATION_ONLY = re.compile(
    r'^\s*(?:我)?(?:没有|没|从没|从未|不会|并不)(?:真的)?'
    r'(?:想过|想|打算)?(?:自杀|轻生|伤害自己|自残|想死)'
    r'[\s。！？.!?]*$'
)

RISK_STATES = {'active', 'supported'}
CONVERSATION_INTENTS = {'stay', 'lighter', 'end'}
CRISIS_CONTACTS = '在中国大陆，可拨打 12356 心理援助热线；如有立即危险，请拨打 110 或 120。'

ACTION_STATUSES = {'selected', 'started', 'completed', 'stuck', 'adjusting'}
RELIEF_PATTERNS = (
    '我好多了', '好多了', '好一点了', '轻松了', '轻松一点', '轻松了一点',
    '没那么焦虑', '没那么难受', '踏实了', '缓过来了',
)
COMPLETED_RESTART_PATTERNS = (
    '能不能先', '可以先做', '今天能花', '今天先做', '有没有开始',
    '还没开始', '现在开始', '先做一点', '尝试一下',
)



@cache_control(public=True, max_age=60, s_maxage=60, stale_while_revalidate=120)
def landing(request):
    return render(request, 'core/landing.html', outcome_summary())


@ensure_csrf_cookie
@cache_control(private=True, max_age=300)
def home(request):
    return render(request, 'core/home.html', {
        'scenario_prompts': SCENARIO_PROMPTS, 'trial_mode': request.GET.get('trial') == '1',
    })


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


@require_GET
@never_cache
def health(request):
    return JsonResponse({'status': 'ok'})


@require_POST
def chat(request):
    message = request.POST.get('message', '').strip()
    scenario = request.POST.get('scenario', '').strip()
    flow_stage = request.POST.get('flow_stage', 'listen').strip()
    history = parse_history(request.POST.get('history', '[]'))
    selected_action = request.POST.get('selected_action', '').strip()[:500]
    requested_action_status = request.POST.get('action_status', '').strip()
    action_status = requested_action_status if requested_action_status in ACTION_STATUSES else ''
    requested_risk_state = request.POST.get('risk_state', '').strip()
    risk_state = requested_risk_state if requested_risk_state in RISK_STATES else ''
    requested_intent = request.POST.get('conversation_intent', '').strip()
    conversation_intent = requested_intent if requested_intent in CONVERSATION_INTENTS else ''
    wants_stream = request.POST.get('stream') == 'true'

    if not message:
        data = {'reply': '我在这里。你可以先用一句话说说：最近最压着你的那件学业相关的事是什么？'}
        return stream_static_response(data) if wants_stream else JsonResponse(data)

    max_length = int(getattr(settings, 'CHAT_MESSAGE_MAX_LENGTH', 4000))
    if len(message) > max_length:
        return chat_error(
            f'这段话有些长，请先保留最想说的 {max_length} 个字以内，我会认真读。',
            'message_too_long', 400,
        )

    if detects_immediate_risk(message):
        data = build_safety_response('initial')
        return stream_static_response(data) if wants_stream else JsonResponse(data)

    if risk_state:
        data = build_safety_response('followup', message, conversation_intent)
        return stream_static_response(data) if wants_stream else JsonResponse(data)

    if not conversation_intent and END_REQUEST.search(message):
        conversation_intent = 'end'
    memory = remember(parse_memory(request.POST.get('memory', '{}')), message, history, intent=conversation_intent)
    if conversation_intent:
        data = build_intent_response(conversation_intent, flow_stage, action_status)
        if conversation_intent in ('stay', 'lighter'):
            data['stage'] = 'listen'
        data['memory'] = remember(memory, message, history, data['reply'], conversation_intent)
        return stream_static_response(data) if wants_stream else JsonResponse(data)

    client_id, network_id = chat_client_ids(request)
    if client_id == network_id:
        allowed, retry_after = consume_chat_quota(
            network_id,
            limit=int(getattr(settings, 'CHAT_NETWORK_RATE_LIMIT_PER_MINUTE', 120)),
            namespace='network',
        )
    else:
        allowed, retry_after = consume_chat_quota(client_id)
        if allowed:
            allowed, retry_after = consume_chat_quota(
                network_id,
                limit=int(getattr(settings, 'CHAT_NETWORK_RATE_LIMIT_PER_MINUTE', 120)),
                namespace='network',
            )
    if not allowed:
        response = chat_error(
            '你说的话我都想认真接住。请稍等一会儿再继续，刚才的内容还保留在输入框里。',
            'rate_limited', 429,
        )
        response['Retry-After'] = str(retry_after)
        return response

    lock_key = f'mindmate:chat-lock:{client_id}'
    lock_timeout = int(getattr(settings, 'CHAT_CONCURRENT_TIMEOUT_SECONDS', 55))
    if not cache.add(lock_key, '1', timeout=lock_timeout):
        return chat_error(
            '上一条回复还在准备中，请等它完成后再继续。',
            'request_in_progress', 409,
        )

    phase = choose_phase(message, action_status, memory)

    if wants_stream:
        return stream_model_response(
            message, scenario, history, phase, selected_action, action_status, memory,
            lock_key=lock_key,
        )

    try:
        try:
            reply, provider = generate_ai_reply(
                message,
                scenario,
                history=history,
                phase=phase,
                selected_action=selected_action,
                action_status=action_status,
                memory=memory,
            )
        except AIUnavailable:
            reply = build_supportive_reply(message, scenario, phase, selected_action, action_status)
            provider = 'fallback'
    finally:
        cache.delete(lock_key)

    action_card = build_action_card(scenario, selected_action) if phase == 'control' else None
    guard = ReplyGuard(message, history, phase, selected_action, action_status, memory, action_card)
    guard.feed(reply, final=True)
    reply = guard.reply
    return JsonResponse({
        'reply': reply,
        'provider': provider,
        'stage': phase,
        'action_status': action_status,
        'action_card': action_card,
        'memory': remember(memory, message, history, reply),
    })


def stream_event(event_type, **payload):
    return json.dumps({'type': event_type, **payload}, ensure_ascii=False) + '\n'


def configure_stream_response(events):
    response = StreamingHttpResponse(events, content_type='application/x-ndjson; charset=utf-8')
    response['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    response['X-Accel-Buffering'] = 'no'
    return response


def stream_static_response(data):
    def events():
        yield stream_event('delta', text=data.get('reply', ''))
        yield stream_event('done', **data)

    response = configure_stream_response(events())
    response['X-Chat-Mode'] = 'safety' if data.get('risk') else 'guided'
    return response


def chat_error(message, code, status):
    response = JsonResponse({'error': code, 'message': message}, status=status)
    response['Cache-Control'] = 'no-store'
    return response


def detects_immediate_risk(message):
    normalized = re.sub(r'\s+', '', message)
    if RISK_NEGATION_ONLY.fullmatch(normalized):
        return False
    return any(word in normalized for word in RISK_WORDS) or any(
        pattern.search(normalized) for pattern in RISK_PATTERNS
    )


def chat_client_ids(request):
    raw_client_id = request.POST.get('client_id', '').strip()
    try:
        client_identity = f'client:{uuid.UUID(raw_client_id)}'
    except (ValueError, AttributeError):
        client_identity = ''
    network_identity = '|'.join((
        request.META.get('HTTP_X_FORWARDED_FOR', '').split(',')[0].strip()
        or request.META.get('REMOTE_ADDR', 'anonymous'),
        request.META.get('HTTP_USER_AGENT', '')[:200],
    ))
    network_id = hashlib.sha256(f'network:{network_identity}'.encode('utf-8')).hexdigest()[:24]
    client_id = hashlib.sha256(client_identity.encode('utf-8')).hexdigest()[:24] if client_identity else network_id
    return client_id, network_id


def consume_chat_quota(client_id, limit=None, namespace='client', window=None):
    limit = max(1, int(limit or getattr(settings, 'CHAT_RATE_LIMIT_PER_MINUTE', 12)))
    window = max(10, int(window or getattr(settings, 'CHAT_RATE_LIMIT_WINDOW_SECONDS', 60)))
    now = int(time.time())
    bucket = now // window
    key = f'mindmate:chat-rate:{namespace}:{client_id}:{bucket}'
    if cache.add(key, 1, timeout=window + 2):
        count = 1
    else:
        try:
            count = cache.incr(key)
        except ValueError:
            cache.set(key, 1, timeout=window + 2)
            count = 1
    retry_after = window - (now % window)
    return count <= limit, retry_after


class ReplyGuard:
    """Only approved complete sentences can become visible; emitted text is immutable."""

    def __init__(self, message, history, phase, selected_action, action_status, memory, action_card=None):
        self.buffer = ''
        self.parts = []
        self.phase = phase
        self.action_status = action_status
        self.selected_action = selected_action
        self.action_card = action_card
        self.action_presented = False
        self.questions = list(memory.get('questions', []))
        for item in history:
            if item.get('role') == 'assistant':
                self.questions.extend(re.findall(r'[^。！；;\n]*[？?]', item['content']))
        self.question_count = 0
        self.fixed_reply = completed_relief_reply() if (
            phase != 'listen' and action_status == 'completed' and is_relief_message(message, history)
        ) else ''

    @property
    def reply(self):
        return ''.join(self.parts)

    def feed(self, text, final=False):
        if self.fixed_reply:
            if self.parts:
                return []
            self.parts.append(self.fixed_reply)
            return [self.fixed_reply]
        self.buffer += text
        sentences, self.buffer = take_sentences(self.buffer, final)
        emitted = []
        for sentence in sentences:
            sentence = normalize_reply_punctuation(sentence)
            if not sentence:
                continue
            # Action instructions come from the shared card, never a parallel model list.
            if self.phase == 'control' and (
                re.search(r'行动卡|步骤|选项|[0-9一二三][.、：:]|[？?]|你可以|不妨|建议|试[试着]|先.{0,12}(做|写|列|看|打开|保存|复制|喝|休息)|复制|注释|清单|复现|验证|任务|准备好', sentence)
                or (self.action_card and action_text(self.action_card['step']) in sentence)
            ):
                continue
            if self.action_status == 'completed' and (
                any(word in sentence for word in COMPLETED_RESTART_PATTERNS)
                or re.search(r'还没.{0,5}(做|完成|开始)|完成了吗|做完了吗|是否.{0,3}(完成|开始)|再.{0,4}做一点|行动卡', sentence)
            ):
                continue
            if self.action_status in ('selected', 'started', 'stuck', 'adjusting') and re.search(r'你.{0,3}已经完成|你完成了', sentence):
                continue
            is_question = bool(re.search(r'[？?]|吗[。！!]?$', sentence))
            if self.phase == 'listen' and (
                is_question or re.search(r'行动卡|任务清单|建议你|试着|试试|先.{0,8}(做|写|列|完成)|下一步', sentence)
            ):
                continue
            if self.phase != 'control' and '行动卡' in sentence:
                continue
            if is_question:
                if self.question_count or question_is_repeated(sentence, self.questions):
                    continue
                self.question_count += 1
                self.questions.append(sentence)
            if sentence in self.parts:
                continue
            if not self.parts and self.selected_action and self.phase == 'action' and self.action_status != 'completed':
                sentence = anchor_selected_action(sentence, self.phase, self.selected_action, self.action_status)
            self.parts.append(sentence)
            emitted.append(sentence)
        if final and self.action_card and not self.action_presented:
            self.action_presented = True
            lead = '\n\n' if self.parts else '好，我们按你现在愿意尝试的节奏来，不需要一下子解决全部。\n\n'
            sentence = f'{lead}这一小步是：{self.action_card["step"]}\n做到这里就可以停下来，感受一下自己。'
            self.parts.append(sentence)
            emitted.append(sentence)
        if final and not self.parts:
            if self.action_status == 'completed':
                fallback = f'你已经完成了“{action_text(self.selected_action) or "刚才那一小步"}”。这份进展已经发生，现在可以按自己的节奏休息或继续聊。'
            else:
                fallback = '我在听。此刻不用急着给出答案，也不用把所有事情一下子解决。你可以按自己的节奏继续说。'
            self.parts.append(fallback)
            emitted.append(fallback)
        return emitted


def stream_model_response(message, scenario, history, phase, selected_action, action_status, memory, lock_key=''):
    action_card = build_action_card(scenario, selected_action) if phase == 'control' else None
    status_labels = {
        'listen': '正在认真听你说',
        'clarify': '正在理解你此刻最在意的部分',
        'control': '正在寻找一个更轻、更可控的步骤',
        'action': '正在回看这一步带来的变化',
    }

    def events():
        yield stream_event(
            'meta', stage=phase, action_status=action_status, action_card=action_card,
        )
        yield stream_event('status', text=status_labels.get(phase, '正在认真整理回应'))
        guard = ReplyGuard(message, history, phase, selected_action, action_status, memory, action_card)
        provider = 'fallback'
        interrupted = False
        try:
            for chunk, chunk_provider in stream_ai_reply(
                message,
                scenario,
                history=history,
                phase=phase,
                selected_action=selected_action,
                action_status=action_status,
                memory=memory,
            ):
                provider = chunk_provider
                for sentence in guard.feed(chunk):
                    yield stream_event('delta', text=sentence, provider=provider)
        except AIUnavailable:
            if not guard.parts:
                guard.buffer = ''
                fallback = build_supportive_reply(message, scenario, phase, selected_action, action_status)
                provider = 'fallback'
                for sentence in guard.feed(fallback, final=True):
                    yield stream_event('delta', text=sentence, provider=provider)
            else:
                interrupted = True
                guard.buffer = ''
                guard.action_card = None

        for sentence in guard.feed('', final=True):
            yield stream_event('delta', text=sentence, provider=provider)
        reply = guard.reply
        yield stream_event(
            'done',
            reply=reply,
            provider=provider,
            stage=phase,
            action_status=action_status,
            action_card=None if interrupted else action_card,
            interrupted=interrupted,
            memory=remember(memory, message, history, reply),
        )

    def guarded_events():
        try:
            yield from events()
        finally:
            if lock_key:
                cache.delete(lock_key)

    return configure_stream_response(guarded_events())


@require_POST
def record_outcome(request):
    try:
        event_id = uuid.UUID(request.POST.get('event_id', '').strip())
    except (ValueError, AttributeError):
        return JsonResponse({'error': 'invalid_event_id'}, status=400)

    session_event_id = request.session.get('outcome_event_id')
    if session_event_id and session_event_id != str(event_id):
        return JsonResponse({'error': 'event_mismatch'}, status=403)

    if request.POST.get('consent') == 'withdrawn':
        if session_event_id == str(event_id):
            OutcomeRecord.objects.filter(event_id=event_id).delete()
            request.session.pop('outcome_event_id', None)
        return JsonResponse({'deleted': True})

    if request.POST.get('consent') != 'granted':
        return JsonResponse({'error': 'consent_required'}, status=400)
    record_exists = OutcomeRecord.objects.filter(event_id=event_id).exists()
    if session_event_id != str(event_id) and record_exists:
        return JsonResponse({'error': 'event_mismatch'}, status=403)
    if not record_exists:
        network_id = chat_client_ids(request)[1]
        allowed, retry_after = consume_chat_quota(
            network_id,
            limit=int(getattr(settings, 'OUTCOME_CREATE_RATE_LIMIT_PER_HOUR', 5)),
            namespace='outcome-create',
            window=int(getattr(settings, 'OUTCOME_RATE_LIMIT_WINDOW_SECONDS', 3600)),
        )
        if not allowed:
            response = JsonResponse({'error': 'outcome_rate_limited'}, status=429)
            response['Retry-After'] = str(retry_after)
            return response

    scenario = request.POST.get('scenario', 'general').strip()
    valid_scenarios = {value for value, _ in OutcomeRecord.SCENARIOS}
    if scenario not in valid_scenarios:
        scenario = 'general'

    try:
        initial_stress = parse_stress(request.POST.get('initial_stress'))
        final_stress = parse_stress(request.POST.get('final_stress'))
        understood_rating = parse_stress(request.POST.get('understood_rating'))
        actionable_rating = parse_stress(request.POST.get('actionable_rating'))
        helpful_rating = parse_stress(request.POST.get('helpful_rating'))
        return_intent_rating = parse_stress(request.POST.get('return_intent_rating'))
    except ValueError:
        return JsonResponse({'error': 'invalid_rating'}, status=400)

    record, created = OutcomeRecord.objects.get_or_create(
        event_id=event_id,
        defaults={'scenario': scenario},
    )
    record.scenario = scenario
    if initial_stress is not None and record.initial_stress is None and record.final_stress is None:
        record.initial_stress = initial_stress
    if final_stress is not None:
        record.final_stress = final_stress
    if understood_rating is not None:
        record.understood_rating = understood_rating
    if actionable_rating is not None:
        record.actionable_rating = actionable_rating
    if helpful_rating is not None:
        record.helpful_rating = helpful_rating
    if return_intent_rating is not None:
        record.return_intent_rating = return_intent_rating
    if 'feedback_note' in request.POST:
        record.feedback_note = request.POST.get('feedback_note', '').strip()[:300]
    if request.POST.get('action_completed') == 'true':
        record.action_completed = True
    record.save()
    request.session['outcome_event_id'] = str(event_id)
    return JsonResponse({'saved': True, 'created': created})


def parse_stress(raw_value):
    if raw_value in (None, ''):
        return None
    value = int(raw_value)
    if value not in range(1, 6):
        raise ValueError('Stress value must be between 1 and 5.')
    return value


def outcome_summary():
    # Public evidence includes only records reviewed against the controlled
    # trial log. Self-submitted records remain available to administrators.
    records = OutcomeRecord.objects.filter(evidence_approved=True)
    total = records.count()
    completed = records.filter(action_completed=True).count()
    rated = records.filter(initial_stress__isnull=False, final_stress__isnull=False)
    rated_count = rated.count()
    improved = rated.filter(final_stress__lt=F('initial_stress')).count()
    average_change = rated.aggregate(value=Avg(F('initial_stress') - F('final_stress')))['value']
    dates = records.aggregate(first=Min('created_at'), last=Max('created_at'))
    minimum_sample = max(1, int(getattr(settings, 'OUTCOME_MINIMUM_SAMPLE', 10)))
    return {
        'outcome_total': total,
        'outcome_completed': completed,
        'outcome_rated': rated_count,
        'outcome_improved': improved,
        'outcome_unchanged': rated.filter(final_stress=F('initial_stress')).count(),
        'outcome_increased': rated.filter(final_stress__gt=F('initial_stress')).count(),
        'outcome_missing_initial': records.filter(initial_stress__isnull=True).count(),
        'outcome_missing_final': records.filter(final_stress__isnull=True).count(),
        'outcome_action_rate': round(completed / total * 100) if total else None,
        'outcome_improvement_rate': round(improved / rated_count * 100) if rated_count else None,
        'outcome_average_change': round(float(average_change), 1) if average_change is not None else None,
        'outcome_evidence_ready': rated_count >= minimum_sample,
        'outcome_minimum_sample': minimum_sample,
        'outcome_first_date': dates['first'],
        'outcome_last_date': dates['last'],
    }


def build_intent_response(intent, flow_stage, action_status):
    replies = {
        'stay': '可以，我们先不回答任何问题。你不用解释，也不用马上变好。我会安静地陪你在这里停一会儿。',
        'lighter': (
            '好，我们先把沉重的话题放到一边。试着看看身边一种让你觉得还算舒服的颜色，'
            '或感受一下双脚踩着地面的触感；不用告诉我答案，只给大脑一点喘息。'
        ),
        'end': '今天先聊到这里也很好。谢谢你愿意照顾自己的感受，已经完成的小进展不会因为停下来而消失。',
    }
    stage = flow_stage if flow_stage in ('listen', 'clarify', 'control', 'action') else 'listen'
    return {
        'reply': replies[intent],
        'provider': 'guided',
        'risk': False,
        'stage': stage,
        'action_status': action_status,
        'action_card': None,
        'conversation_intent': intent,
        'ended': intent == 'end',
    }


def safety_card(title, prompt, options):
    return {'title': title, 'prompt': prompt, 'options': options}


def build_safety_response(kind, message='', conversation_intent=''):
    if conversation_intent == 'end':
        return {
            'reply': f'可以先结束页面，但请不要独自承受。保持和已经联系到的人在一起或保持通话。{CRISIS_CONTACTS}',
            'provider': 'safety',
            'risk': True,
            'risk_state': 'supported',
            'stage': 'safety',
            'action_status': '',
            'action_card': None,
            'safety_card': None,
            'ended': True,
        }

    if kind == 'initial':
        reply = (
            '谢谢你把这么难受的情况告诉我。现在先不处理学业任务，也不继续普通对话；你的安全最重要。\n\n'
            f'请先远离可能伤害自己或他人的物品，并尽快让一位可信任的人来到你身边，或联系辅导员和学校心理中心。{CRISIS_CONTACTS}'
        )
        card = safety_card('先确认此刻的安全', '请选择最接近你现在情况的一项：', [
            {'label': '我现在安全，身边有人', 'message': '我现在安全，身边有人。'},
            {'label': '我现在安全，但一个人', 'message': '我现在安全，但身边暂时没有人。'},
            {'label': '我现在有危险', 'message': '我现在有立即危险，需要真人帮助。', 'urgent': True},
        ])
    elif '已经联系' in message or '有人正在来' in message:
        reply = (
            '你已经把真人支持连接起来了，这一步非常重要。请继续和对方保持通话或待在一起，'
            f'把可能造成伤害的物品交给对方保管。{CRISIS_CONTACTS}'
        )
        card = safety_card('保持真人支持', '接下来不需要继续解释，可以选择：', [
            {'label': '继续停留在安全模式', 'message': '请继续用简短的话陪我保持安全。'},
            {'label': '结束本次对话', 'message': '我想先结束本次对话。', 'intent': 'end'},
        ])
    elif '有立即危险' in message or '我现在有危险' in message:
        reply = (
            '现在请立即行动：去有人的地方，远离可能造成伤害的物品，大声呼叫身边的人，'
            f'不要独自等待，也不要只依靠这个页面。{CRISIS_CONTACTS}'
        )
        card = safety_card('立即连接真人帮助', '完成其中一项后告诉我：', [
            {'label': '我已经联系真人支持', 'message': '我已经联系真人支持，有人正在来或正和我通话。'},
            {'label': '暂时联系不上', 'message': '我暂时联系不上熟悉的人。', 'urgent': True},
        ])
    elif '一个人' in message or '没有人' in message or '联系不上' in message:
        reply = (
            '先不要一个人待着。请带上手机去宿舍公共区域、值班室、保卫处或其他有人的地方，'
            f'同时联系辅导员、同学或家人。此刻不需要把情况解释得很完整，只要说“我现在需要你来陪我”。{CRISIS_CONTACTS}'
        )
        card = safety_card('去到有人能够看见你的地方', '当你连接到真人支持后，选择下面这项：', [
            {'label': '我已经联系真人支持', 'message': '我已经联系真人支持，有人正在来或正和我通话。'},
            {'label': '我现在有危险', 'message': '我现在有立即危险，需要真人帮助。', 'urgent': True},
        ])
    elif '身边有人' in message:
        reply = (
            '很好，先和这个人待在一起。请直接告诉对方：“我现在状态不安全，需要你先陪着我”，'
            f'并请对方协助联系辅导员或学校心理中心。{CRISIS_CONTACTS}'
        )
        card = safety_card('让身边的人真正加入支持', '告诉对方后，可以选择：', [
            {'label': '我已经联系真人支持', 'message': '我已经联系真人支持，有人正在来或正和我通话。'},
            {'label': '我现在有危险', 'message': '我现在有立即危险，需要真人帮助。', 'urgent': True},
        ])
    else:
        reply = '我会继续把安全放在第一位。现在请只告诉我：你身边有人吗，或者你已经联系到真人支持了吗？'
        card = safety_card('继续确认安全', '请选择最接近的一项：', [
            {'label': '我身边有人', 'message': '我现在身边有人。'},
            {'label': '我现在一个人', 'message': '我现在一个人。'},
            {'label': '我已经联系真人支持', 'message': '我已经联系真人支持，有人正在来或正和我通话。'},
        ])

    return {
        'reply': reply,
        'provider': 'safety',
        'risk': True,
        'risk_state': 'active',
        'stage': 'safety',
        'action_status': '',
        'action_card': None,
        'safety_card': card,
    }


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


def is_relief_message(message, history=None):
    normalized = re.sub(r'[\s。！？!?~～]', '', message)
    if any(pattern in message for pattern in RELIEF_PATTERNS):
        return True
    previous = next((item['content'] for item in reversed(history or []) if item.get('role') == 'assistant'), '')
    return normalized in ('有', '是', '有一点') and bool(re.search(r'轻松|缓解|好一点|好些', previous))


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
        '听到你说现在好一些，我也替你松了一口气。你说的这份变化值得留意，'
        '不需要马上给它找一个解释。\n\n'
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




def build_supportive_reply(message, scenario, phase='clarify', selected_action='', action_status=''):
    if phase == 'listen':
        return (
            '你愿意把这些感受告诉我，我会认真听。此刻不用整理好语言，也不必急着解决问题。'
            '难受的时候可以先停一停，想说多少、说到哪里，都按你的节奏来。'
        )
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
        return '谢谢你告诉我现在需要什么。我们按你的节奏来，不必勉强自己，也不需要一下子解决全部。'
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
