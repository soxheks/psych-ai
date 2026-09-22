import csv

from django.contrib import admin
from django.core.exceptions import PermissionDenied
from django.db.models import Avg, F
from django.http import HttpResponse
from django.urls import path
from django.utils import timezone

from .models import OutcomeRecord


@admin.register(OutcomeRecord)
class OutcomeRecordAdmin(admin.ModelAdmin):
    change_list_template = 'admin/core/outcomerecord/change_list.html'
    list_display = (
        'created_at', 'scenario', 'initial_stress', 'final_stress',
        'action_completed', 'understood_rating', 'actionable_rating',
        'helpful_rating', 'return_intent_rating',
    )
    list_filter = ('scenario', 'action_completed', 'created_at')
    date_hierarchy = 'created_at'
    list_per_page = 50
    readonly_fields = (
        'event_id', 'scenario', 'initial_stress', 'final_stress',
        'action_completed', 'understood_rating', 'actionable_rating',
        'helpful_rating', 'return_intent_rating', 'feedback_note',
        'created_at', 'updated_at',
    )

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def get_urls(self):
        urls = super().get_urls()
        custom = [
            path(
                'export.csv',
                self.admin_site.admin_view(self.export_csv),
                name='core_outcomerecord_export',
            ),
        ]
        return custom + urls

    def changelist_view(self, request, extra_context=None):
        response = super().changelist_view(request, extra_context)
        if not hasattr(response, 'context_data') or 'cl' not in response.context_data:
            return response
        response.context_data['outcome_dashboard'] = self.outcome_dashboard(
            response.context_data['cl'].queryset,
        )
        return response

    def outcome_dashboard(self, queryset):
        total = queryset.count()
        completed = queryset.filter(action_completed=True).count()
        paired = queryset.filter(initial_stress__isnull=False, final_stress__isnull=False)
        paired_count = paired.count()
        improved = paired.filter(final_stress__lt=F('initial_stress')).count()
        averages = queryset.aggregate(
            understood=Avg('understood_rating'),
            actionable=Avg('actionable_rating'),
            helpful=Avg('helpful_rating'),
            return_intent=Avg('return_intent_rating'),
        )
        return {
            'total': total,
            'completed': completed,
            'action_rate': round(completed / total * 100) if total else None,
            'paired': paired_count,
            'missing_initial': queryset.filter(initial_stress__isnull=True).count(),
            'missing_final': queryset.filter(final_stress__isnull=True).count(),
            'unchanged': paired.filter(final_stress=F('initial_stress')).count(),
            'increased': paired.filter(final_stress__gt=F('initial_stress')).count(),
            'improved': improved,
            'improvement_rate': round(improved / paired_count * 100) if paired_count else None,
            'averages': {
                key: round(float(value), 2) if value is not None else None
                for key, value in averages.items()
            },
        }

    def export_csv(self, request):
        if not self.has_view_permission(request):
            raise PermissionDenied
        changelist = self.get_changelist_instance(request)
        queryset = changelist.queryset.order_by('-created_at')
        response = HttpResponse(content_type='text/csv; charset=utf-8')
        response['Content-Disposition'] = 'attachment; filename="mindmate-anonymous-outcomes.csv"'
        response.write('\ufeff')
        writer = csv.writer(response)
        writer.writerow([
            '记录时间', '匿名事件ID', '场景', '开始压力', '结束压力', '行动完成',
            '被理解评分', '建议可执行评分', '帮助程度评分', '再次使用意愿评分', '匿名建议', '完整前后测', '压力变化(开始减结束)',
        ])
        for record in queryset.iterator():
            writer.writerow([
                timezone.localtime(record.created_at).strftime('%Y-%m-%d %H:%M:%S'),
                record.event_id,
                record.get_scenario_display(),
                record.initial_stress or '',
                record.final_stress or '',
                '是' if record.action_completed else '否',
                record.understood_rating or '',
                record.actionable_rating or '',
                record.helpful_rating or '',
                record.return_intent_rating or '',
                self.csv_safe(record.feedback_note),
                '是' if record.initial_stress is not None and record.final_stress is not None else '否',
                record.initial_stress - record.final_stress if record.initial_stress is not None and record.final_stress is not None else '',
            ])
        return response

    @staticmethod
    def csv_safe(value):
        text = str(value or '')
        return f"'{text}" if text.startswith(('=', '+', '-', '@')) else text
