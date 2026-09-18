import uuid

from django.db import models


class OutcomeRecord(models.Model):
    SCENARIOS = [
        ('competition', '学科竞赛'),
        ('research', '科研课题'),
        ('coding', '代码调试'),
        ('gpa', '绩点焦虑'),
        ('exam', '备考压力'),
        ('setback', '学业受挫'),
        ('general', '一般压力'),
    ]

    event_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    scenario = models.CharField(max_length=20, choices=SCENARIOS, default='general')
    initial_stress = models.PositiveSmallIntegerField(null=True, blank=True)
    final_stress = models.PositiveSmallIntegerField(null=True, blank=True)
    action_completed = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ('-created_at',)
        verbose_name = '匿名成效记录'
        verbose_name_plural = '匿名成效记录'

    def __str__(self):
        return f'{self.get_scenario_display()} / {self.created_at:%Y-%m-%d}'
