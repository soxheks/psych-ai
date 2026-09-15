from django.urls import path

from . import views

urlpatterns = [
    path('', views.landing, name='landing'),
    path('chat/', views.home, name='home'),
    path('journal/', views.journal, name='journal'),
    path('api/chat/', views.chat, name='chat'),
]
