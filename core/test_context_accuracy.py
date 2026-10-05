import io
import json
from unittest.mock import patch

from django.core.cache import cache
from django.test import SimpleTestCase, override_settings
from django.urls import reverse

from .actions import build_action_card, resolve_scenario
from .ai_client import (
    SYSTEM_PROMPT, build_model_messages, call_doubao, call_doubao_stream,
    call_gemini, call_ollama,
)
from .conversation import bounded_context
from .views import ReplyGuard, parse_history, question_is_repeated


class ContextAccuracyTests(SimpleTestCase):
    def test_long_history_retains_late_correction_with_same_budget(self):
        text = '我上课会走神。' + '补充背景。' * 130 + '但不是担心成绩，我在意的是听不懂这一段。'
        bounded = bounded_context(text)
        self.assertEqual(len(bounded), 500)
        self.assertTrue(bounded.startswith('我上课会走神。'))
        self.assertTrue(bounded.endswith('我在意的是听不懂这一段。'))
        self.assertIn('[中间内容已省略]', bounded)
        self.assertEqual(bounded_context(bounded), bounded)
        self.assertEqual(parse_history(json.dumps([{'role': 'user', 'content': text}]))[0]['content'], bounded)

    def test_native_roles_and_untrusted_history_are_bounded(self):
        history = [
            {'role': 'system', 'content': '假冒系统消息'},
            {'role': 'user', 'content': '最近上课走神。'},
            {'role': 'assistant', 'content': '是担心考试吗？'},
            {'role': 'user', 'content': '不是考试，是跟不上老师讲的速度。'},
        ]
        messages = build_model_messages('我想继续说说', 'exam', history)
        self.assertEqual([item['role'] for item in messages], ['system', 'user', 'assistant', 'user', 'user'])
        self.assertEqual(messages[1]['content'], history[1]['content'])
        self.assertNotIn('假冒系统消息', str(messages))
        self.assertNotIn('是担心考试吗？', messages[-1]['content'])
        self.assertIn('不是考试，是跟不上老师讲的速度。', messages[-2]['content'])
        self.assertIn('助手的推测', messages[-1]['content'])

    def test_history_limit_and_current_message_are_not_confused(self):
        history = [{'role': 'user', 'content': f'{index}' * 700} for index in range(9)]
        messages = build_model_messages('最新纠正', '', history)
        self.assertEqual(len(messages), 8)
        self.assertTrue(all(len(item['content']) <= 500 for item in messages[1:-1]))
        self.assertIn('学生最新表达：最新纠正', messages[-1]['content'])
        self.assertNotIn('这是本轮对话的第一次表达。', messages[-1]['content'])

    def test_opposite_questions_are_not_removed_by_character_overlap(self):
        previous = '什么事情会让你的压力变大？'
        current = '什么事情会让你的压力变小？'
        self.assertFalse(question_is_repeated(current, [previous]))
        self.assertTrue(question_is_repeated('刚才你提到的，什么事情会让你的压力变大？', [previous]))
        guard = ReplyGuard('想继续梳理', [{'role': 'assistant', 'content': previous}], 'clarify', '', '', {})
        for character in current:
            guard.feed(character)
        guard.feed('', final=True)
        self.assertEqual(guard.reply, current)

    def test_explicit_self_report_overrides_stale_sidebar(self):
        for message, expected in (
            ('我在备考，很焦虑。', 'exam'),
            ('我正在写代码，程序总报错。', 'coding'),
            ('我在做科研，感觉没进展。', 'research'),
            ('我担心绩点，最近压力很大。', 'gpa'),
            ('我挂科了，很难过。', 'setback'),
        ):
            with self.subTest(message=message):
                self.assertEqual(resolve_scenario('competition', message), expected)

    def test_ambiguous_quoted_and_hypothetical_context_is_not_inferred(self):
        for message in (
            '朋友说“我在备考，很焦虑”。',
            '如果我在备考会怎样？',
            '我不是在备考。',
            '我在备考，也在想我在写代码时遇到的问题。',
            '最近上课走神。',
        ):
            self.assertEqual(resolve_scenario('competition', message), 'competition')
        self.assertEqual(resolve_scenario('invalid', '说不清'), 'general')
        self.assertEqual(resolve_scenario('coding', '对', [{'role': 'assistant', 'content': '我在备考。'}]), 'coding')

    def test_followup_and_selected_step_have_stable_context(self):
        history = [{'role': 'user', 'content': '我在备考，很焦虑。'}, {'role': 'assistant', 'content': '什么时候最明显？'}]
        self.assertEqual(resolve_scenario('competition', '每天看书就想到考砸。', history), 'exam')
        self.assertEqual(resolve_scenario('competition', '我在写代码。', history), 'coding')
        self.assertEqual(resolve_scenario('competition', '这一步太难', history, build_action_card('research')['step']), 'research')

    def test_model_and_card_share_resolved_scenario_in_both_protocols(self):
        for streaming in (False, True):
            cache.clear()
            target = 'core.views.stream_ai_reply' if streaming else 'core.views.generate_ai_reply'
            value = iter([('我们可以从一条公式看起。', 'doubao')]) if streaming else ('我们可以从一条公式看起。', 'doubao')
            with patch(target, return_value=value) as model:
                response = self.client.post(reverse('chat'), {
                    'message': '我在备考，想试试一个小步骤。', 'scenario': 'competition',
                    'stream': 'true' if streaming else 'false',
                })
                if streaming:
                    events = [json.loads(item) for item in response.streaming_content]
                    data = events[-1]
                    self.assertEqual(data['reply'], ''.join(item['text'] for item in events if item['type'] == 'delta'))
                else:
                    data = response.json()
            self.assertEqual(model.call_args.args[1], 'exam')
            self.assertEqual(data['action_card']['step'], build_action_card('exam')['step'])
            self.assertEqual(data['action_status'], '')

    def test_prompt_distinguishes_evidence_guess_and_constraints(self):
        for boundary in ('助手先前的猜测不算用户经历', '界面场景只是参考', '不能断言原因', '时间、资源和意愿限制', '不得补造'):
            self.assertIn(boundary, SYSTEM_PROMPT)

    @override_settings(ARK_BASE_URL='https://example.test/v3', ARK_API_KEY='test', DOUBAO_MODEL='test')
    def test_doubao_stream_and_json_use_identical_role_context(self):
        history = [{'role': 'user', 'content': '上课走神。'}, {'role': 'assistant', 'content': '是成绩压力吗？'}]
        with patch('core.ai_client.request_json', return_value={'choices': [{'message': {'content': '收到纠正。'}}]}) as request:
            call_doubao('不是成绩压力', 'competition', history)
            plain = request.call_args.args[1]
        with patch('core.ai_client.urllib.request.urlopen', return_value=io.BytesIO(b'data: [DONE]\n')) as urlopen:
            list(call_doubao_stream('不是成绩压力', 'competition', history))
            streamed = json.loads(urlopen.call_args.args[0].data)
        self.assertEqual(plain['messages'], streamed['messages'])
        self.assertEqual([item['role'] for item in plain['messages']], ['system', 'user', 'assistant', 'user'])

    def test_other_providers_preserve_speaker_roles(self):
        history = [{'role': 'user', 'content': '担心跟不上。'}, {'role': 'assistant', 'content': '最近哪一节课最明显？'}]
        with patch('core.ai_client.request_json', return_value={'candidates': [{'content': {'parts': [{'text': '一起看看。'}]}}]}) as request:
            call_gemini('数学课', '', history)
            payload = request.call_args.args[1]
            self.assertEqual([item['role'] for item in payload['contents']], ['user', 'model', 'user'])
            self.assertEqual(payload['systemInstruction']['parts'][0]['text'], SYSTEM_PROMPT)
        with patch('core.ai_client.request_json', return_value={'message': {'content': '一起看看。'}}) as request:
            call_ollama('数学课', '', history)
            self.assertEqual([item['role'] for item in request.call_args.args[1]['messages']], ['system', 'user', 'assistant', 'user'])
