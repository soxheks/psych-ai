from django.apps import AppConfig
from django.conf import settings


class CoreConfig(AppConfig):
    name = 'core'

    def ready(self):
        # SimpleUI removes this middleware during its startup; restore same-origin framing protection.
        middleware = 'django.middleware.clickjacking.XFrameOptionsMiddleware'
        if middleware not in settings.MIDDLEWARE:
            settings.MIDDLEWARE.append(middleware)
