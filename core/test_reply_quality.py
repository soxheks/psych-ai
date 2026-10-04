import json
from unittest.mock import patch

from django.core.cache import cache
from django.test import SimpleTestCase
from django.urls import reverse

from .actions import build_action_card, new_action_card
from .ai_client import AIUnavailable, SYSTEM_PROMPT, build_user_prompt
from .conversation import is_explicit_correction, parse_memory, remember
from .medical import medical_boundary_reply


class ReplyQualityTests(SimpleTestCase):
    def request(self, payload, raw='', streaming=False, unavailable=False):
        cache.clear()
        target = 'core.views.stream_ai_reply' if streaming else 'core.views.generate_ai_reply'
        value = iter((raw[i:i + 3], 'doubao') for i in range(0, len(raw), 3)) if streaming else (raw, 'doubao')
        with patch(target, return_value=value, side_effect=AIUnavailable() if unavailable else None) as model:
            response = self.client.post(reverse('chat'), {**payload, 'stream': 'true' if streaming else 'false'})
            self.assertEqual(response.status_code, 200)
            if streaming:
                events = [json.loads(item) for item in response.streaming_content]
                data = events[-1]
                self.assertEqual(data['reply'], ''.join(event['text'] for event in events if event['type'] == 'delta'))
            else:
                data = response.json()
        return data, model

    def test_action_explanation_is_not_followed_by_a_fixed_step(self):
        raw = '最小知识点可以只是一条公式的含义，弄清一个符号就够，不需要覆盖整章。'
        for streaming in (False, True):
            data, _ = self.request({'message': '那我应该怎么做', 'scenario': 'exam'}, raw, streaming)
            self.assertEqual(data['reply'], raw)
            self.assertIsNotNone(data['action_card'])
            self.assertNotIn('这一小步是', data['reply'])
            self.assertIn(data['action_card']['step'], data['memory']['presented_actions'])

    def test_card_memory_prevents_duplicates_without_step_in_history(self):
        first, _ = self.request({'message': '那我应该怎么做', 'scenario': 'exam'}, '最小知识点可以只是一条公式。')
        for streaming in (False, True):
            data, _ = self.request({
                'message': '具体怎么做', 'scenario': 'exam', 'history': '[]',
                'memory': json.dumps(first['memory']),
            }, '只看公式中一个符号的意义，不必扩展到整章。', streaming)
            self.assertIsNone(data['action_card'])
            prompt = build_user_prompt('具体怎么做', 'exam', phase='control', memory=data['memory'])
            self.assertIn('本轮不再发卡或重复原文', prompt)
            self.assertIsNotNone(new_action_card('coding', '', 'control', [], data['memory']))
            self.assertEqual(data['action_status'], '')

    def test_empty_or_entirely_filtered_reply_has_support_and_card(self):
        for streaming in (False, True):
            data, _ = self.request({'message': '帮我选一个小步骤', 'scenario': 'exam'}, '1. 重写所有笔记。', streaming)
            self.assertIn('都由你决定', data['reply'])
            self.assertNotIn('重写所有笔记', data['reply'])
            self.assertIsNotNone(data['action_card'])

    def test_presented_actions_are_bounded_and_do_not_change_completion(self):
        memory = parse_memory({'presented_actions': [str(n) * 200 for n in range(20)]})
        self.assertEqual(len(memory['presented_actions']), 12)
        self.assertTrue(all(len(step) <= 180 for step in memory['presented_actions']))
        self.assertEqual(parse_memory({'presented_actions': 'bad'})['presented_actions'], [])
        card = build_action_card('exam')
        memory = remember({}, '我想试试', [], action_card=card)
        self.assertNotIn('action_status', memory)
        self.assertIsNone(new_action_card('exam', '', 'control', [], memory))

    def test_interrupted_stream_does_not_record_an_undelivered_card(self):
        def broken(*args, **kwargs):
            yield '我听见了。接下来', 'doubao'
            raise AIUnavailable()
        cache.clear()
        with patch('core.views.stream_ai_reply', side_effect=broken):
            response = self.client.post(reverse('chat'), {'message': '帮我选一个小步骤', 'scenario': 'exam', 'stream': 'true'})
            events = [json.loads(item) for item in response.streaming_content]
        self.assertTrue(events[-1]['interrupted'])
        self.assertIsNone(events[-1]['action_card'])
        self.assertEqual(events[-1]['memory']['presented_actions'], [])

    def test_diagnosis_requests_never_receive_causal_reassurance(self):
        for message in (
            '我一周没睡好，担心考试，你能确定是抑郁症吗？',
            '帮我排除抑郁症，我是不是只是压力大？',
            '我是不是得了焦虑症？那我该怎么做？',
        ):
            for streaming in (False, True):
                with self.subTest(message=message, streaming=streaming):
                    data, model = self.request({'message': message, 'scenario': 'exam'}, '这更像是备考压力。', streaming)
                    model.assert_not_called()
                    self.assertTrue(data['medical_boundary'])
                    self.assertEqual(data['provider'], 'guided')
                    self.assertIn('不能确认或排除', data['reply'])
                    self.assertIn('专业人员评估', data['reply'])
                    self.assertNotIn('更像是备考压力', data['reply'])
                    self.assertIsNone(data['action_card'])

    def test_medical_followup_and_medication_request_keep_boundary(self):
        history = [{'role': 'user', 'content': '能确定是抑郁症吗？'}]
        for streaming in (False, True):
            for message in ('那你能排除吗？', '那是不是只是压力？', '吃什么药，剂量多少？'):
                data, model = self.request({'message': message, 'history': json.dumps(history)}, '只是压力。', streaming)
                model.assert_not_called()
                self.assertTrue(data['medical_boundary'])
                self.assertIsNone(data['action_card'])

    def test_medical_mentions_are_not_automatically_diagnosis_requests(self):
        for message in ('医生已经诊断我有抑郁症，我只想说说感受。', '医生已经诊断我有抑郁症，能陪我聊聊吗？', '考试让我焦虑，想找人聊聊。', '我在写药物管理程序。', '朋友说“你是不是有抑郁症”，这让我不舒服。'):
            with self.subTest(message=message):
                self.assertEqual(medical_boundary_reply(message), '')
        self.assertIn('不能先说不能诊断', SYSTEM_PROMPT)

    def test_medical_boundary_never_overrides_active_safety(self):
        for streaming in (False, True):
            for extra in ({'message': '我想伤害自己，你能确定我有抑郁症吗？'}, {'message': '我是不是抑郁症？', 'risk_state': 'active'}):
                data, model = self.request(extra, '不能诊断。', streaming)
                self.assertTrue(data['risk'])
                self.assertEqual(data['stage'], 'safety')
                model.assert_not_called()

    def test_correction_suppresses_reconfirmation_in_both_modes(self):
        message = '他们没有给我压力。我更在意自己是不是不够好。'
        raw = '刚才把压力归到父母身上，是我理解偏了。你在意的从来不是爸妈的态度，是对自己的要求，对吧？你对自己的要求已经让你很累，不必再向我证明这一点。'
        for streaming in (False, True):
            data, _ = self.request({'message': message, 'scenario': 'exam'}, raw, streaming)
            self.assertIn('是我理解偏了', data['reply'])
            self.assertIn('不必再向我证明', data['reply'])
            self.assertNotIn('？', data['reply'])
            self.assertNotIn('从来', data['reply'])
        self.assertTrue(is_explicit_correction(message))
        self.assertFalse(is_explicit_correction('你说“我更在意自己”，是什么意思？'))
        prompt = build_user_prompt(message, 'exam')
        self.assertIn('本轮用户明确纠正了理解', prompt)
        self.assertIn('旧要点及助手的猜测若冲突则不再沿用', prompt)

    def test_correction_remains_in_memory_as_user_fact(self):
        message = '你理解错了，我说的是我自己的要求，不是父母的期待。'
        memory = remember({'concern': '担心父母的期待'}, message, [])
        prompt = build_user_prompt('我想接着聊聊', 'exam', memory=memory)
        self.assertIn(message, prompt)
        self.assertIn('后来的纠正优先于旧困扰', prompt)

    def test_correction_confirmation_without_question_mark_is_also_removed(self):
        for streaming in (False, True):
            data, _ = self.request({'message': '你理解错了，我说的是对自己的要求。'}, '你更在意自己的要求，对吧。刚才是我理解偏了。', streaming)
            self.assertEqual(data['reply'], '刚才是我理解偏了。')

    def test_completed_relief_preserves_specific_method_not_fixed_template(self):
        raw = '把问题拆小之后，眼前要处理的部分变清楚了；这是你刚才发现对自己有帮助的方法。是什么让你轻松了一点？这一步已经完成，可以先歇一会儿。'
        for streaming in (False, True):
            data, _ = self.request({'message': '是把问题拆小让我轻松一点', 'selected_action': '整理笔记。', 'action_status': 'completed'}, raw, streaming)
            self.assertIn('这是你刚才发现对自己有帮助的方法', data['reply'])
            self.assertNotIn('是什么让你', data['reply'])
            self.assertNotIn('不需要马上给它找一个解释', data['reply'])
            self.assertEqual(data['action_status'], 'completed')

    def test_unavailable_provider_still_acknowledges_correction_or_method(self):
        for streaming in (False, True):
            for message, fragment in (
                ('是把问题拆小让我轻松一点', '把问题拆小'),
                ('你理解错了，我说的是对自己的要求。', '对自己的要求'),
            ):
                data, _ = self.request({'message': message, 'selected_action': '整理笔记。', 'action_status': 'completed'}, streaming=streaming, unavailable=True)
                self.assertEqual(data['provider'], 'fallback')
                self.assertIn(fragment, data['reply'])
                self.assertNotIn('？', data['reply'])
                self.assertNotIn('不需要马上给它找一个解释', data['reply'])
