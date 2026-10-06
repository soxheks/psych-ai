"""One supportive turn before a bounded simplification of the chosen action."""

from .actions import simplify_action
from .conversation import is_explicit_correction, parse_memory


def prepare_action_recovery(message, scenario, phase, selected_action, action_status, memory):
    if (not selected_action or action_status not in ('stuck', 'adjusting')
            or phase not in ('control', 'action') or is_explicit_correction(message)):
        return None
    before = {'phase': 'action', 'selected_action': selected_action, 'action_status': action_status, 'memory': parse_memory(memory)}
    previous = memory.get('action_recovery', {})
    base = previous.get('base_step') or selected_action
    expected = simplify_action(base, scenario, previous['level']) if previous.get('level') else base
    if previous.get('step') != selected_action or expected != selected_action:
        previous = {'base_step': selected_action, 'level': 0}
    updated = parse_memory(memory)
    base = previous.get('base_step') or selected_action
    if previous.get('state') != 'comforted':
        updated['action_recovery'] = {'base_step': base, 'step': selected_action,
                                      'level': previous.get('level', 0), 'state': 'comforted'}
        return {'before': before, 'phase': 'listen', 'selected_action': selected_action,
                'action_status': action_status, 'memory': updated, 'revision': None}
    level = min(previous.get('level', 0) + 1, 2)
    step = simplify_action(base, scenario, level)
    updated['action_recovery'] = {'base_step': base, 'step': step, 'level': level, 'state': 'offered'}
    revision = {'from_step': selected_action, 'step': step, 'title': '更轻的一小步',
                'duration': '约 2 分钟' if level == 1 else '约半分钟',
                'note': '做到这个简化步骤，就可以结束这次尝试。'}
    return {'before': before, 'phase': 'action', 'selected_action': step,
            'action_status': 'selected', 'memory': updated, 'revision': revision}
