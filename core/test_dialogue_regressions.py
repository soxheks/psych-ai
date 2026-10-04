import json
from unittest.mock import patch

from django.core.cache import cache
from django.test import SimpleTestCase
from django.urls import reverse

from .ai_client import AIUnavailable, build_user_prompt
from .conversation import choose_phase, parse_memory, remember, resolve_action_status
from .views import detects_immediate_risk


class RiskDenialTests(SimpleTestCase):
    def test_clear_denial_in_a_compound_statement(self):
        for message in (
            '我没有想伤害自己，只是考试前有点焦虑，希望聊一聊。',
            '我现在没有想过自杀，但是很担心考试。',
            '最近有点难过。我不会自残。',
            '我没有自杀的念头，只是想找人说说话。',
        ):
            with self.subTest(message=message):
                self.assertFalse(detects_immediate_risk(message))

    def test_denial_does_not_hide_a_separate_or_uncertain_risk(self):
        for message in (
            '我没有想伤害自己，但是现在想自杀。',
            '我没有想伤害自己，不过我控制不住了。',
            '我没有想伤害自己，但不能保证今晚安全。',
            '我没有想伤害自己，但活不下去了。',
            '我没想自杀，可是想伤害别人。',
            '我没有想伤害自己吗？我不知道。',
            '我没有想伤害自己吧。',
            '不是我没有想自杀。',
            '我不想再醒来。',
            '我想伤害自己。没有人知道。',
            '我没有想伤害自己我现在想自杀。',
            '我朋友说他想自杀。',
        ):
            with self.subTest(message=message):
                self.assertTrue(detects_immediate_risk(message))

    def test_denial_enters_normal_chat_in_both_response_modes(self):
        for streaming in (False, True):
            cache.clear()
            target = 'core.views.stream_ai_reply' if streaming else 'core.views.generate_ai_reply'
            response_value = iter([('我们可以聊聊考试带来的焦虑。', 'doubao')]) if streaming else ('我们可以聊聊考试带来的焦虑。', 'doubao')
            with patch(target, return_value=response_value) as provider:
                response = self.client.post(reverse('chat'), {
                    'message': '我没有想伤害自己，只是考试前有点焦虑，希望聊一聊。',
                    'stream': 'true' if streaming else 'false',
                })
                data = [json.loads(item) for item in response.streaming_content][-1] if streaming else response.json()
            self.assertEqual(data['provider'], 'doubao')
            self.assertFalse(data.get('risk', False))
            provider.assert_called_once()

    def test_denial_cannot_clear_an_already_active_safety_state(self):
        with patch('core.views.generate_ai_reply') as provider:
            data = self.client.post(reverse('chat'), {
                'message': '我没有想伤害自己，只是考试前有点焦虑。', 'risk_state': 'active',
            }).json()
        self.assertTrue(data['risk'])
        provider.assert_not_called()


class NaturalCompletionTests(SimpleTestCase):
    def setUp(self):
        cache.clear()

    def test_explicit_completion_of_a_selected_step(self):
        for message in (
            '我刚才那一步已经做完了，现在感觉轻松了。',
            '我说我已经完成了，不是还没开始。',
            '完成了。', '这一步我已经完成了。', '我把这一步做完了。',
            '我今天完成了这一步，想复盘一下。', '搞定啦！',
        ):
            with self.subTest(message=message):
                self.assertEqual(resolve_action_status(message, '整理笔记。', 'selected'), 'completed')
                self.assertEqual(choose_phase(message, 'completed'), 'action')

    def test_ambiguous_negative_partial_quoted_or_other_tasks_do_not_complete(self):
        for message in (
            '我还没完成。', '如果我完成了会怎样？', '我准备做完了再来。',
            '我可能做完了。', '我差点完成了。', '我完成了一半。',
            '我完成了部分。', '我完成了，其实还没做完。',
            '我朋友完成了。', '你说“我完成了”，但我不理解。',
            '我做完了作业，现在才开始行动卡。', '这算完成了吗？',
        ):
            with self.subTest(message=message):
                self.assertEqual(resolve_action_status(message, '整理笔记。', 'selected'), 'selected')
        self.assertEqual(resolve_action_status('完成了。', '', ''), '')

    def test_completion_reaches_provider_and_final_response_in_both_modes(self):
        payload = {'message': '我刚才那一步已经做完了，现在感觉轻松了。',
                   'selected_action': '整理笔记。', 'action_status': 'selected'}
        for streaming in (False, True):
            cache.clear()
            target = 'core.views.stream_ai_reply' if streaming else 'core.views.generate_ai_reply'
            value = iter([('这一步已经完成。', 'doubao')]) if streaming else ('这一步已经完成。', 'doubao')
            with patch(target, return_value=value) as provider:
                response = self.client.post(reverse('chat'), {**payload, 'stream': 'true' if streaming else 'false'})
                if streaming:
                    events = [json.loads(item) for item in response.streaming_content]
                    data = events[-1]
                    self.assertEqual(''.join(item['text'] for item in events if item['type'] == 'delta'), data['reply'])
                else:
                    data = response.json()
            self.assertEqual(data['action_status'], 'completed')
            self.assertEqual(data['stage'], 'action')
            self.assertEqual(provider.call_args.kwargs['action_status'], 'completed')
            self.assertIsNone(data['action_card'])

    def test_completion_survives_explicit_pause_and_end(self):
        with patch('core.views.generate_ai_reply', return_value=('先歇一会儿。', 'doubao')):
            data = self.client.post(reverse('chat'), {
                'message': '我做完了，但现在不想听建议，想先休息。',
                'selected_action': '整理笔记。', 'action_status': 'started',
            }).json()
        self.assertEqual(data['action_status'], 'completed')
        self.assertEqual(data['stage'], 'listen')
        data = self.client.post(reverse('chat'), {
            'message': '我完成了，今天先聊到这里。',
            'selected_action': '整理笔记。', 'action_status': 'selected',
        }).json()
        self.assertTrue(data['ended'])
        self.assertEqual(data['action_status'], 'completed')

    def test_explicit_completion_can_follow_a_listening_pause(self):
        memory = remember({}, '只想聊聊，不想听建议。', [])
        self.assertEqual(choose_phase('我刚才那一步已经做完了。', 'completed', memory), 'action')


class TopicApplicabilityTests(SimpleTestCase):
    def setUp(self):
        cache.clear()

    def test_personal_topic_survives_history_truncation_and_can_return_to_study(self):
        memory = remember({}, '我失恋了，跟考试和学习没有关系。', [])
        for _ in range(8):
            memory = remember(memory, '我想再说说这件事。', [])
        self.assertEqual(memory['topic'], 'personal')
        self.assertEqual(choose_phase('那我应该怎么做？', memory=memory), 'clarify')
        memory = remember(memory, '现在想回到备考，帮我选一个小步骤。', [])
        self.assertEqual(memory['topic'], 'academic')
        self.assertEqual(choose_phase('帮我选一个小步骤。', memory=memory), 'control')

    def test_quoted_topic_does_not_change_current_topic(self):
        memory = remember({}, '老师举了“失恋”的例子，我担心考试。', [])
        self.assertNotEqual(memory['topic'], 'personal')
        self.assertEqual(parse_memory({'topic': 'arbitrary'})['topic'], '')

    def test_a_new_explicit_study_message_can_restore_academic_scope(self):
        from .views import SCENARIO_PROMPTS
        for message in SCENARIO_PROMPTS.values():
            with self.subTest(message=message):
                memory = remember({'topic': 'personal'}, message, [])
                self.assertEqual(memory['topic'], 'academic')

    def test_personal_prompt_has_no_compulsory_study_action(self):
        memory = remember({}, '我刚分手，跟学习没有关系。', [])
        prompt = build_user_prompt('那我应该怎么做？', 'exam', phase='control',
                                   selected_action='复习十分钟。', action_status='completed', memory=memory)
        self.assertNotIn('本轮唯一候选行动', prompt)
        self.assertNotIn('复习十分钟', prompt)
        self.assertNotIn('用户已经明确完成该行动', prompt)
        self.assertIn('当前非学业话题', prompt)

    def test_personal_advice_does_not_create_an_academic_card_in_both_modes(self):
        memory = remember({}, '我刚分手，跟考试和学习没有关系。', [])
        for streaming in (False, True):
            target = 'core.views.stream_ai_reply' if streaming else 'core.views.generate_ai_reply'
            value = iter([('想念的时候，不必责怪自己。', 'doubao')]) if streaming else ('想念的时候，不必责怪自己。', 'doubao')
            with patch(target, return_value=value):
                response = self.client.post(reverse('chat'), {
                    'message': '那我应该怎么做才能面对分手后的难过？', 'scenario': 'exam',
                    'selected_action': '复习十分钟。', 'action_status': 'selected',
                    'memory': json.dumps(memory), 'stream': 'true' if streaming else 'false',
                })
                data = [json.loads(item) for item in response.streaming_content][-1] if streaming else response.json()
            self.assertIsNone(data['action_card'])
            self.assertEqual(data['stage'], 'clarify')
            self.assertEqual(data['memory']['topic'], 'personal')
            self.assertNotIn('复习', data['reply'])

    def test_personal_fallback_does_not_reuse_study_step(self):
        with patch('core.views.generate_ai_reply', side_effect=AIUnavailable('offline')):
            data = self.client.post(reverse('chat'), {
                'message': '我失恋了，该怎么做？', 'scenario': 'exam',
                'selected_action': '复习十分钟。', 'action_status': 'completed',
            }).json()
        self.assertEqual(data['provider'], 'fallback')
        self.assertNotIn('已经完成', data['reply'])
        self.assertNotIn('复习', data['reply'])
        self.assertIsNone(data['action_card'])

    def test_personal_topic_does_not_bypass_safety(self):
        with patch('core.views.generate_ai_reply') as provider:
            data = self.client.post(reverse('chat'), {
                'message': '分手后我想伤害自己。', 'memory': '{"topic":"personal"}',
            }).json()
        self.assertTrue(data['risk'])
        provider.assert_not_called()
