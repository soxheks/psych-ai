from django.urls import path

from . import views

urlpatterns = [
    path('', views.landing, name='landing'),
    path('chat/', views.home, name='home'),
    path('journal/', views.journal, name='journal'),
    path('service-worker.js', views.service_worker, name='service_worker'),
    path('api/csrf/', views.csrf, name='csrf'),
    path('api/chat/', views.chat, name='chat'),
    path('api/outcomes/', views.record_outcome, name='record_outcome'),
]
