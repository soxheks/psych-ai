# Agent Notes

## Project Overview

This is a Django project for the `心理AI比赛` workspace.

- Project package: `psych_ai`
- Main app: `core`
- Python environment: `.venv`
- Database: SQLite, `db.sqlite3`
- Admin UI: `django-simpleui`
- Language: Simplified Chinese
- Time zone: `Asia/Shanghai`

## Competition Development Standard (Required)

Before changing product behavior, UI, AI features, data collection, deployment, or submission materials, read `docs/COMPETITION_GUIDE.md` and use it as the acceptance baseline.

- Map meaningful work to one or more official scoring items: innovation (25), needs analysis (15), AI technology application (20), project implementation (15), application outcomes (15), and summary/future plan (10).
- Prefer features that create verifiable user value for university students under academic pressure, especially competition, research, coding/debugging, GPA anxiety, exam preparation, and academic setbacks.
- Keep evidence for claims. Never fabricate user research, usage data, effectiveness data, feedback, application cases, or technical indicators.
- Treat psychological safety and privacy as product requirements: use clear non-diagnostic boundaries, crisis guidance and human referral, data minimization, and secure server-side secret handling.
- Record the source, license, authorization, and role of third-party models, code, datasets, documents, and visual assets. Do not claim third-party work as original.
- Do not include the team school name or instructor information in competition plans, presentations, or demo videos.
- For each substantial feature, preserve test results, screenshots or demo steps, implementation notes, and measurable acceptance criteria so the work can support the technical report and evidence package.

## Environment

Use the project virtual environment:

```powershell
.\.venv\Scripts\Activate.ps1
```

Run Python and Django commands through the virtual environment:

```powershell
.\.venv\Scripts\python.exe manage.py check
.\.venv\Scripts\python.exe manage.py migrate
.\.venv\Scripts\python.exe manage.py runserver
```

## Dependencies

Dependencies are tracked in `requirements.txt`.

Installed packages include:

- Django
- django-simpleui
- asgiref
- sqlparse
- tzdata

To install dependencies in a fresh environment:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## Django Admin

Admin URL:

```text
http://127.0.0.1:8000/admin/
```

Existing superuser:

```text
Username: WN
Password: 123456
```

Note: This password is weak and should be changed before any real deployment or shared use.

## Current Apps

`INSTALLED_APPS` includes:

- `simpleui`
- Django built-in admin/auth/session apps
- `core`

Keep `simpleui` before `django.contrib.admin` so it can override the default Django admin templates.

## Development Notes

- Keep project-level settings in `psych_ai/settings.py`.
- Put app-specific models, views, admin registrations, tests, and migrations under `core/`.
- Run `manage.py check` after changing Django settings.
- Run migrations after adding or changing models:

```powershell
.\.venv\Scripts\python.exe manage.py makemigrations
.\.venv\Scripts\python.exe manage.py migrate
```

## AI Chat Provider

The frontend chat endpoint is `POST /api/chat/`.

The app supports server-side AI provider paths without adding extra Python packages:

- Doubao through Volcengine Ark when `ARK_API_KEY` is configured.
- Gemini REST API when `GEMINI_API_KEY` is configured.
- Local Ollama when Ollama is running on `http://127.0.0.1:11434`.
- Rule-based fallback when no AI provider is available.

The browser chat calls the Django `/api/chat/` endpoint directly, so visitors do not need to install anything or log in to a third-party AI service. For real model output without visitor login, configure a server-side provider key or run a local model on the server.

Optional environment variables:

```powershell
$env:AI_PROVIDER = "auto"
$env:ARK_API_KEY = "your_ark_api_key"
$env:ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
$env:DOUBAO_MODEL = "doubao-seed-2-0-lite-260215"
$env:GEMINI_API_KEY = "your_api_key"
$env:GEMINI_MODEL = "gemini-2.0-flash"
$env:OLLAMA_URL = "http://127.0.0.1:11434"
$env:OLLAMA_MODEL = "qwen2.5:7b"
```

Restart the Django server after changing environment variables.

## Useful Commands

Start development server:

```powershell
.\.venv\Scripts\python.exe manage.py runserver 127.0.0.1:8000
```

Create another app:

```powershell
.\.venv\Scripts\python.exe manage.py startapp app_name
```

## Public Deployment

This project includes Render deployment files:

- `render.yaml`
- `build.sh`
- `.env.example`

Public deployments must configure secrets as environment variables. Do not commit `ARK_API_KEY`, `.env`, or a production `SECRET_KEY`.

Create or update a superuser non-interactively:

```powershell
.\.venv\Scripts\python.exe manage.py shell -c "from django.contrib.auth import get_user_model; User=get_user_model(); user, _ = User.objects.get_or_create(username='WN'); user.is_staff=True; user.is_superuser=True; user.set_password('123456'); user.save()"
```
