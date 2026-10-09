# Public Deployment Guide

## Goal

Make this Django AI mental-health demo available to other people through a public HTTPS URL.

Local addresses such as `http://127.0.0.1:8001/` only work on this computer. A public URL requires one of these paths:

- Formal deployment to a cloud platform such as Render or Railway.
- Temporary public tunnel from this computer for short demos.

## Recommended: Render with Neon Postgres

This project already includes Render-ready files:

- `render.yaml`
- `build.sh`
- `requirements.txt`

Steps:

1. Create a GitHub repository and upload this project.
2. Open Render and create a new Blueprint from the repository.
3. Create a Neon project on the Free plan, preferably in the same region as the
   Render web service. The current web service is in Oregon, so use AWS US West
   (Oregon) when available. Copy the PostgreSQL connection string with SSL enabled.
4. Set environment variables in the Render dashboard:

```text
AI_PROVIDER=doubao
ARK_API_KEY=your-new-volcengine-ark-api-key
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
DOUBAO_MODEL=ep-20260908200558-l7blb
DATABASE_URL=your-neon-postgresql-connection-string-with-ssl
```

5. Deploy. `build.sh` collects static assets and applies Django migrations.
6. Render will provide a public URL such as:

```text
https://psych-ai.onrender.com
```

`render.yaml` no longer creates a free Render database. `DATABASE_URL` is a
dashboard-managed secret, so future Blueprint syncs do not replace a Neon URL
with the old Render database URL. Updating an existing Blueprint does not prompt
for this value; set it manually before deploying.

For the existing site's data migration, recovery decision, and verification,
follow [the Neon migration guide](docs/NEON_MIGRATION.md).

## Important Security Notes

- Do not publish the API key in code, screenshots, or documentation.
- Rotate the current `ARK_API_KEY` because it was pasted into chat.
- Change the Django admin password before public deployment.
- Keep `DEBUG=False` in production.

## Temporary Demo Tunnel

A temporary tunnel can make the local Django server public quickly, but it exposes the local service, including `/admin/`, to the internet while it is running.

Use it only for short controlled demos.
