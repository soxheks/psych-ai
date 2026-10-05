import json
from unittest.mock import patch

from django.core.cache import cache
from django.test import SimpleTestCase
from django.urls import reverse

from .ai_client import AIUnavailable, build_user_prompt
from .conversation import choose_phase, has_action_context, remember


class StageHandoffTests(SimpleTestCase):
    def test_general_companionship_does_not_persist_a_pause(self):
        for message in ('先陪我聊聊', '先陪我说说最近的考试吧。', '先陪我聊一会儿，我在备考。'):
            memory = remember({}, message, [])
            self.assertNotEqual(memory['preference'], 'listen')
            self.assertEqual(choose_phase(message, memory=memory), 'clarify')

    def test_mild_distress_after_support_can_progress_without_action_password(self):
        first = '我在备考，最近好累。'
        self.assertEqual(choose_phase(first), 'listen')
        memory = remember({}, first, [], '我听见这段时间的疲惫了。')
        history = [{'role': 'user', 'content': first}, {'role': 'assistant', 'content': '我听见这段时间的疲惫了。'}]
        self.assertEqual(choose_phase('还是好累，想接着说说。', memory=memory, history=history), 'clarify')
        for streaming in (False, True):
            data, _ = self.request('我还是很难受，每天复习都卡在公式上。', history, memory, streaming)
            self.assertEqual(data['stage'], 'control')
            self.assertIsNotNone(data['action_card'])
            self.assertEqual(data['action_status'], '')

    def test_explicit_pause_and_overwhelm_still_win_after_support(self):
        for message in ('我只想倾诉，不想听建议。', '先陪我待一会儿。', '一直哭，脑子很乱，主要担心考试。'):
            data, _ = self.request(message, self.history())
            self.assertEqual(data['stage'], 'listen')
            self.assertIsNone(data['action_card'])
        memory = remember({}, '先别给建议，听我说。', [])
        data, _ = self.request('我很难受，每天都卡在公式上。', self.history(), memory)
        self.assertEqual(data['stage'], 'listen')

    def test_explicit_resume_releases_saved_listening_preference(self):
        memory = remember({}, '先陪我待一会儿。', [])
        resume = '我现在想一起梳理，看看最困扰我的部分。'
        updated = remember(memory, resume, self.history())
        self.assertEqual(updated['preference'], 'clarify')
        data, _ = self.request(resume, self.history(), updated)
        self.assertEqual(data['stage'], 'clarify')
        data, _ = self.request('每天复习都会走神，脑子里想着考砸。', self.history(), data['memory'])
        self.assertEqual(data['stage'], 'control')

    def test_resume_fallback_uses_existing_concern_not_button_text(self):
        from .views import build_supportive_reply
        reply = build_supportive_reply(
            '我现在想一起梳理，看看最困扰我的部分。', 'competition', phase='clarify',
            memory={'concern': '最近上课走神很焦虑。'},
        )
        self.assertIn('最近上课走神很焦虑', reply)
        self.assertNotIn('竞赛', reply)
        self.assertNotIn('我现在想一起梳理', reply)

    def test_short_concrete_obstacle_is_not_lost_to_length_threshold(self):
        for message in ('卡在公式推导', '证明跟不上', '总是听不懂'):
            self.assertEqual(choose_phase(message, history=self.history()), 'control')
        for message in ('好吧', '说不清', '不知道原因', '还没说完'):
            self.assertEqual(choose_phase(message, history=self.history()), 'clarify')

    def test_progression_never_completes_action_without_user_report(self):
        data, _ = self.request('每次复习都卡在公式上，很难受。', self.history())
        self.assertEqual(data['stage'], 'control')
        step = data['action_card']['step']
        data, _ = self.request('我准备开始这一步了', self.history(), data['memory'], selected_action=step, action_status='selected')
        self.assertEqual(data['stage'], 'action')
        self.assertEqual(data['action_status'], 'selected')
        data, _ = self.request('我已经完成了这一步，现在轻松一点了。', self.history(), data['memory'], selected_action=step, action_status='started')
        self.assertEqual(data['stage'], 'action')
        self.assertEqual(data['action_status'], 'completed')

    def setUp(self):
        cache.clear()

    def history(self, concern='我在备考，越临近考试越难集中注意力。'):
        return [
            {'role': 'user', 'content': concern},
            {'role': 'assistant', 'content': '现在最影响你复习的是哪一处？'},
        ]

    def request(self, message, history, memory=None, streaming=False, **fields):
        cache.clear()
        raw = '眼前难的是范围太大，可以把注意力先放到一小块上；暂时不做也没关系。'
        target = 'core.views.stream_ai_reply' if streaming else 'core.views.generate_ai_reply'
        value = iter([(raw[:15], 'doubao'), (raw[15:], 'doubao')]) if streaming else (raw, 'doubao')
        with patch(target, return_value=value) as model:
            response = self.client.post(reverse('chat'), {
                'message': message, 'scenario': 'exam', 'history': json.dumps(history),
                'memory': json.dumps(memory or {}), 'stream': 'true' if streaming else 'false', **fields,
            })
            self.assertEqual(response.status_code, 200)
            if streaming:
                events = [json.loads(chunk) for chunk in response.streaming_content]
                data = events[-1]
                self.assertEqual(data['reply'], ''.join(event['text'] for event in events if event['type'] == 'delta'))
            else:
                data = response.json()
        return data, model

    def test_concrete_followup_naturally_offers_a_step_in_six_scenarios(self):
        scenarios = (
            ('exam', '我在备考，很担心考试发挥。', '每天看书都会走神，脑子里一直想着考砸。'),
            ('competition', '我准备竞赛，任务很多，怕来不及。', '主要是周五就要演示，我负责的部分还没跑通。'),
            ('research', '课题进展很慢，我越来越焦虑。', '实验结果反复不一致，我不知道哪次记录可以用。'),
            ('coding', '代码总跑不通，我开始怀疑自己。', '报错一直指向数据库的空值，试了几种改法都没好。'),
            ('gpa', '我的绩点下降了，很担心自己不够好。', '主要是数学成绩拖后腿，每次看到排名都会慌。'),
            ('setback', '考试没过，我觉得努力没有回报。', '每次都卡在大题的最后两步，前面其实会做。'),
        )
        for scenario, concern, detail in scenarios:
            for streaming in (False, True):
                with self.subTest(scenario=scenario, streaming=streaming):
                    data, model = self.request(detail, self.history(concern), streaming=streaming, scenario=scenario)
                    self.assertEqual(data['stage'], 'control')
                    self.assertIsNotNone(data['action_card'])
                    self.assertEqual(data['action_status'], '')
                    self.assertEqual(model.call_args.kwargs['phase'], 'control')
                    self.assertNotEqual(data['memory']['preference'], 'action')
                    self.assertIn('可选', data['action_card']['note'])

    def test_first_turn_or_vague_replies_do_not_advance_by_turn_count(self):
        concern = '我在备考，越临近考试越难集中注意力。'
        for reply in ('对', '嗯', '谢谢你', '我也说不清楚为什么会这样。', '我不知道原因，只觉得心里堵。', '为什么我每次复习都会走神？', concern):
            with self.subTest(reply=reply):
                data, _ = self.request(reply, self.history(concern))
                self.assertEqual(data['stage'], 'clarify')
                self.assertIsNone(data['action_card'])
        self.assertFalse(has_action_context('主要是明天就要考试，我担心来不及。', []))
        self.assertFalse(has_action_context('主要是明天就要考试，我担心来不及。', self.history('我想找个人说说自己的心情。')))
        # The current message is already copied into bounded memory before routing.
        long_message = '我在备考，主要担心来不及。' * 20
        self.assertFalse(has_action_context(long_message, [{'role': 'assistant', 'content': '我在听。'}], remember({}, long_message, [])))

    def test_declining_pausing_and_distress_take_priority(self):
        for message in (
            '主要是内容太多，但我现在只想说说，不想听建议。',
            '主要是时间不够，我还没准备好。',
            '主要担心考试，一直哭，脑子很乱。',
        ):
            data, _ = self.request(message, self.history())
            self.assertEqual(data['stage'], 'listen')
            self.assertIsNone(data['action_card'])
        paused = remember({}, '先陪我说说，不想行动。', [])
        data, _ = self.request('主要是周五考试，内容太多了。', self.history(), paused)
        self.assertEqual(data['stage'], 'listen')
        # After prior support, uncertainty invites clarification, not an automatic task.
        data, _ = self.request('我很难受，不知道怎么办。', self.history())
        self.assertEqual(data['stage'], 'clarify')
        self.assertIsNone(data['action_card'])

    def test_personal_medical_and_safety_branches_still_take_priority(self):
        for message, expected in (
            ('我刚分手，主要是想念他，这跟考试没关系。', 'clarify'),
            ('我是不是抑郁症，主要是一直睡不着？', 'listen'),
            ('我主要担心自己控制不住，我想伤害自己。', 'safety'),
        ):
            data, _ = self.request(message, self.history())
            self.assertEqual(data['stage'], expected)
            self.assertIsNone(data.get('action_card'))

    def test_explicit_correction_or_request_to_clarify_is_not_rushed(self):
        for message in ('你理解错了，我说的是对自己的要求。', '主要是内容太多，先帮我梳理一下。'):
            data, _ = self.request(message, self.history())
            self.assertEqual(data['stage'], 'clarify')
            self.assertIsNone(data['action_card'])

    def test_natural_help_requests_do_not_require_exact_phrase(self):
        for message in ('那现在怎么办？', '有没有更轻一点的办法？', '有什么建议吗？', '我不知道从哪里开始。'):
            with self.subTest(message=message):
                self.assertEqual(choose_phase(message), 'control')
        self.assertEqual(choose_phase('不知道怎么办，我很难受。'), 'listen')

    def test_decline_after_proactive_offer_does_not_resurface_tasks(self):
        detail = '主要是周五考试，复习内容太多了。'
        first, _ = self.request(detail, self.history())
        history = [*self.history(), {'role': 'user', 'content': detail}, {'role': 'assistant', 'content': first['reply']}]
        paused, _ = self.request('先陪我待一会儿', history, first['memory'], conversation_intent='stay')
        next_turn, _ = self.request('每次翻到后面我都会紧张。', history, paused['memory'])
        self.assertEqual(next_turn['stage'], 'listen')
        self.assertIsNone(next_turn['action_card'])
        resumed, _ = self.request('现在愿意试试一个小步骤。', history, next_turn['memory'])
        self.assertEqual(resumed['stage'], 'control')
        self.assertEqual(resumed['action_status'], '')

    def test_followup_detail_does_not_generate_duplicate_cards(self):
        detail = '主要是周五考试，复习内容太多了。'
        first, _ = self.request(detail, self.history())
        history = [*self.history(), {'role': 'user', 'content': detail}, {'role': 'assistant', 'content': first['reply']}]
        second, _ = self.request('我每次翻书都会被后面的章节分心。', history, first['memory'])
        self.assertIsNone(second['action_card'])
        self.assertEqual(second['action_status'], '')

    def test_prior_selected_or_completed_actions_are_not_overridden(self):
        for status in ('selected', 'started', 'completed', 'stuck'):
            data, _ = self.request('主要是周五考试，我担心内容太多。', self.history(), action_status=status, selected_action='整理笔记。')
            self.assertEqual(data['stage'], 'action')
            self.assertEqual(data['action_status'], status)
            self.assertIsNone(data['action_card'])

    def test_proactive_prompt_does_not_claim_consent(self):
        message = '主要是周五考试，复习内容太多了。'
        history = self.history()
        memory = remember({}, message, history)
        prompt = build_user_prompt(message, 'exam', history=history, phase='control', memory=memory)
        self.assertIn('并非用户主动索要任务', prompt)
        self.assertIn('允许继续倾诉', prompt)
        self.assertNotIn('用户在寻求具体帮助', prompt)

    def test_fallback_also_bridges_from_concern_to_optional_action(self):
        for streaming in (False, True):
            cache.clear()
            target = 'core.views.stream_ai_reply' if streaming else 'core.views.generate_ai_reply'
            with patch(target, side_effect=AIUnavailable()):
                response = self.client.post(reverse('chat'), {
                    'message': '主要是周五考试，复习内容太多了。', 'scenario': 'exam',
                    'history': json.dumps(self.history()), 'stream': 'true' if streaming else 'false',
                })
                data = [json.loads(item) for item in response.streaming_content][-1] if streaming else response.json()
            self.assertEqual(data['stage'], 'control')
            self.assertEqual(data['provider'], 'fallback')
            self.assertIn('暂时不做也没关系', data['reply'])
            self.assertIsNotNone(data['action_card'])
