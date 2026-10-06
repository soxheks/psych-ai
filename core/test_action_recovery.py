import json
from unittest.mock import patch

from django.core.cache import cache
from django.test import SimpleTestCase
from django.urls import reverse

from .actions import ACTION_CARDS, SIMPLE_ACTIONS, resolve_scenario, simplify_action
from .ai_client import AIUnavailable, build_user_prompt
from .conversation import parse_memory, resolve_action_status


class ActionRecoveryTests(SimpleTestCase):
    def request(self, message, step, status, memory=None, streaming=False, model_chunks=None, **extra):
        cache.clear()
        target = 'core.views.stream_ai_reply' if streaming else 'core.views.generate_ai_reply'
        kwargs = {'side_effect': AIUnavailable()} if model_chunks is None else {'return_value': iter(model_chunks)}
        with patch(target, **kwargs):
            response = self.client.post(reverse('chat'), {
                'message': message, 'scenario': 'exam', 'selected_action': step, 'action_status': status,
                'memory': json.dumps(memory or {}), 'stream': 'true' if streaming else 'false', **extra,
            })
            self.assertEqual(response.status_code, 200)
            if streaming:
                events = [json.loads(item) for item in response.streaming_content]
                data = events[-1]
                self.assertEqual(data['reply'], ''.join(item['text'] for item in events if item['type'] == 'delta'))
                return data
            return response.json()

    def test_stuck_and_too_hard_comfort_then_revise_same_action_then_complete(self):
        for scenario, card in ACTION_CARDS.items():
            for status in ('stuck', 'adjusting'):
                for streaming in (False, True):
                    with self.subTest(scenario=scenario, status=status, streaming=streaming):
                        step = card['steps'][0]
                        first = self.request('这一步我做不下去了。', step, status, streaming=streaming)
                        self.assertEqual(first['stage'], 'action')
                        self.assertEqual(first['action_status'], status)
                        self.assertIsNone(first['action_card'])
                        self.assertIsNone(first['action_revision'])
                        self.assertNotIn('？', first['reply'])
                        second = self.request('嗯', step, status, first['memory'], streaming)
                        self.assertEqual(second['stage'], 'action')
                        self.assertEqual(second['action_status'], 'selected')
                        self.assertIsNone(second['action_card'])
                        self.assertEqual(second['action_revision']['from_step'], step)
                        simplified = second['action_revision']['step']
                        self.assertEqual(simplified, SIMPLE_ACTIONS[scenario][0][0])
                        self.assertEqual(second['memory']['action_recovery']['step'], simplified)
                        completed = self.request('我完成了这一步。', simplified, 'selected', second['memory'], streaming)
                        self.assertEqual(completed['action_status'], 'completed')
                        self.assertIsNone(completed['action_revision'])

    def test_all_alternative_steps_have_two_matching_simplifications(self):
        for scenario, card in ACTION_CARDS.items():
            for index, step in enumerate(card['steps']):
                for level in (1, 2):
                    simplified = simplify_action(step, scenario, level)
                    self.assertEqual(simplified, SIMPLE_ACTIONS[scenario][index][level - 1])
                    self.assertEqual(resolve_scenario('competition', '嗯', selected_action=simplified), scenario)
                    self.assertLess(len(simplified), 180)

    def test_another_obstacle_gets_comfort_and_a_smaller_version_not_false_completion(self):
        step = ACTION_CARDS['exam']['steps'][0]
        first = self.request('卡住了', step, 'stuck')
        second = self.request('嗯', step, 'stuck', first['memory'])
        step = second['action_revision']['step']
        third = self.request('还是太难', step, 'selected', second['memory'])
        self.assertEqual(third['stage'], 'action')
        fourth = self.request('好', step, third['action_status'], third['memory'])
        self.assertEqual(fourth['action_revision']['step'], SIMPLE_ACTIONS['exam'][0][1])
        self.assertEqual(fourth['action_status'], 'selected')
        self.assertEqual(fourth['memory']['action_recovery']['level'], 2)

    def test_comfort_does_not_resume_over_user_boundaries_or_wrong_action(self):
        step = ACTION_CARDS['exam']['steps'][0]
        first = self.request('卡住了', step, 'stuck')
        for message in ('我只想倾诉，不要建议。', '一直哭，脑子很乱。', '你理解错了，我不是这个意思。'):
            data = self.request(message, step, 'stuck', first['memory'])
            self.assertIsNone(data['action_revision'])
        for fields in ({'conversation_intent': 'end'}, {'risk_state': 'active'}):
            data = self.request('先停一停', step, 'stuck', first['memory'], **fields)
            self.assertIsNone(data.get('action_revision'))
        data = self.request('还是卡住了', ACTION_CARDS['coding']['steps'][0], 'stuck', first['memory'])
        self.assertEqual(data['memory']['action_recovery']['level'], 0)
        self.assertIsNone(data['action_revision'])

    def test_started_action_and_negative_or_hypothetical_reports_are_not_rewritten(self):
        step = ACTION_CARDS['exam']['steps'][0]
        data = self.request('我正在进行', step, 'started')
        self.assertEqual(data['stage'], 'action')
        self.assertIsNone(data['action_revision'])
        for message in ('如果完成不了怎么办？', '我并不是卡住了。'):
            self.assertEqual(resolve_action_status(message, step, 'started'), 'started')
        self.assertEqual(resolve_action_status('我完成不了。', step, 'started'), 'stuck')

    def test_recovery_metadata_is_bounded_and_does_not_invent_model_completion(self):
        self.assertNotIn('action_recovery', parse_memory({'action_recovery': {'state': 'comforted', 'level': 100}}))
        memory = parse_memory({'action_recovery': {'state': 'comforted', 'level': 0, 'step': '字' * 1000}})
        self.assertEqual(len(memory['action_recovery']['step']), 500)
        step = ACTION_CARDS['exam']['steps'][0]
        first = self.request('卡住了', step, 'stuck')
        prompt = build_user_prompt('卡住了', 'exam', phase='listen', selected_action=step, action_status='stuck', memory=first['memory'])
        self.assertIn('本轮只接住', prompt)
        completed_prompt = build_user_prompt('我做完了', 'exam', phase='action', selected_action=step, action_status='completed', memory={
            'action_recovery': {'state': 'offered', 'step': step, 'level': 1},
        })
        self.assertNotIn('不声称已开始或完成', completed_prompt)

    def test_partial_stream_does_not_commit_comfort_or_revision(self):
        step = ACTION_CARDS['exam']['steps'][0]
        def failing_chunks():
            yield '这确实会让人挫败。还可以', 'doubao'
            raise AIUnavailable()
        for memory in ({}, {'action_recovery': {'step': step, 'base_step': step, 'level': 0, 'state': 'comforted'}}):
            cache.clear()
            with patch('core.views.stream_ai_reply', return_value=failing_chunks()):
                response = self.client.post(reverse('chat'), {
                    'message': '嗯', 'selected_action': step, 'action_status': 'stuck',
                    'memory': json.dumps(memory), 'stream': 'true',
                })
                data = [json.loads(item) for item in response.streaming_content][-1]
            self.assertTrue(data['interrupted'])
            self.assertIsNone(data['action_revision'])
            self.assertEqual(data['action_status'], 'stuck')
            self.assertEqual(data['memory'].get('action_recovery'), parse_memory(memory).get('action_recovery'))
