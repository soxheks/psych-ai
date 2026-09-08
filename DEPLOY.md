# Public Deployment Guide

## Goal

Make this Django AI mental-health demo available to other people through a public HTTPS URL.

Local addresses such as `http://127.0.0.1:8001/` only work on this computer. A public URL requires one of these paths:

- Formal deployment to a cloud platform such as Render or Railway.
- Temporary public tunnel from this computer for short demos.

## Recommended: Render

This project already includes Render-ready files:

- `render.yaml`
- `build.sh`
- `requirements.txt`

Steps:

1. Create a GitHub repository and upload this project.
2. Open Render and create a new Blueprint from the repository.
3. Set environment variables:

```text
AI_PROVIDER=doubao
ARK_API_KEY=your-new-volcengine-ark-api-key
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
DOUBAO_MODEL=ep-20260908200558-l7blb
```

4. Deploy.
5. Render will provide a public URL such as:

```text
https://psych-ai.onrender.com
```

## Important Security Notes

- Do not publish the API key in code, screenshots, or documentation.
- Rotate the current `ARK_API_KEY` because it was pasted into chat.
- Change the Django admin password before public deployment.
- Keep `DEBUG=False` in production.

## Temporary Demo Tunnel

A temporary tunnel can make the local Django server public quickly, but it exposes the local service, including `/admin/`, to the internet while it is running.

Use it only for short controlled demos.
