# Render to Neon Database Migration

## Scope

Keep the existing Render web service, public URL, and server-side AI settings.
Replace only the PostgreSQL database connection with a Neon database. This
supports the competition's project implementation and verifiable outcomes
requirements without creating or changing usage evidence.

The cloud database contains Django accounts, admin records, and anonymous
outcome records. Chat history and journal drafts stored only in a visitor's
browser are not transferred through a database migration.

## Preserve Existing Data First

1. Open `psych-ai-db` in Render and inspect the full suspension reason.
2. If the database is accessible, export it before switching the web service.
3. If the free database has expired, Render requires a paid upgrade during its
   recovery grace period to access the data. Obtain the owner's decision before
   any paid upgrade or proceeding with an empty replacement database.
4. Keep the original database until data counts and administrator access have
   been verified. Removing its definition from `render.yaml` does not delete it
   on Render, but Render's own expiration/deletion policy still applies.
5. Never copy the development SQLite database or test fixtures into production
   as a substitute for real production records.

Prefer `pg_dump` / `pg_restore` with direct, non-pooled connection strings for a
complete PostgreSQL backup. Use matching PostgreSQL tool versions and do not
print credentials or backups in logs. Store local backups in `.private-backups/`,
which is excluded from Git.

For this project's Django-owned data, Django's `dumpdata` and `loaddata` are an
alternative when PostgreSQL command-line tools are unavailable. With the source
connection set securely in `DATABASE_URL`, export:

```powershell
.\.venv\Scripts\python.exe manage.py dumpdata --all --natural-foreign --natural-primary --exclude contenttypes --exclude auth.permission --output .private-backups/render-production.json
```

Create the private backup directory first. After securely setting `DATABASE_URL`
to the empty Neon database, apply migrations, then import:

```powershell
.\.venv\Scripts\python.exe manage.py migrate --no-input
.\.venv\Scripts\python.exe manage.py loaddata .private-backups/render-production.json
```

Migrations recreate Django's standard content types and permissions. If the
source has manually created permissions or tables outside Django, use a complete
PostgreSQL backup instead. Compare account, admin-log, and outcome-record counts
between source and target without displaying record contents.

## Switch the Existing Web Service

1. Create a Neon project on the Free plan. Prefer AWS US West (Oregon) to match
   this Render web service when the region is available.
2. Obtain the application's connection string with `sslmode=require`. A pooled
   connection is supported; Django server-side cursors are disabled and reused
   connections are checked before database access.
3. Set `DATABASE_URL` in the existing `psych-ai` service's Environment page. Keep
   the connection string in the dashboard, never in Git or submission materials.
4. Publish the updated `render.yaml` and sync the existing Blueprint. It uses
   `sync: false` for `DATABASE_URL` and no longer defines `psych-ai-db`.
5. Redeploy the existing web service. Confirm Django migrations succeed and the
   new deployment becomes Live.
6. If recovery was explicitly declined and the new database starts empty,
   create a new administrator using `createsuperuser` interactively. Do not reuse
   a weak example password or fabricate old anonymous outcomes.

## Verify Before Calling the Migration Complete

- The deployment logs confirm successful migrations against the target database.
- `/health/`, the homepage, `/chat/`, the journal, and the admin login load.
- A real chat reply reports the configured Doubao provider.
- Restored account and outcome counts match the source backup when recovery was
  possible; missing data is documented when it was not recovered.
- Administrator sign-in succeeds. Test database writes through an isolated test
  or admin-owned record, never by adding fabricated production outcome records.
- A fresh request after database idling can reconnect successfully.
- Existing AI secrets, the public hostname, and optional browser-only history
  remain correctly configured after Blueprint sync.

## References

- Render free database limits: https://render.com/docs/free
- Blueprint resource removal: https://render.com/docs/infrastructure-as-code
- Dashboard-managed secrets: https://render.com/docs/blueprint-spec
- Neon plans: https://neon.com/docs/introduction/plans
