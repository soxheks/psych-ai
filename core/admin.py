from django.contrib import admin

from .models import OutcomeRecord


@admin.register(OutcomeRecord)
class OutcomeRecordAdmin(admin.ModelAdmin):
    list_display = ('created_at', 'scenario', 'initial_stress', 'final_stress', 'action_completed')
    list_filter = ('scenario', 'action_completed', 'created_at')
    readonly_fields = (
        'event_id', 'scenario', 'initial_stress', 'final_stress',
        'action_completed', 'created_at', 'updated_at',
    )

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False
