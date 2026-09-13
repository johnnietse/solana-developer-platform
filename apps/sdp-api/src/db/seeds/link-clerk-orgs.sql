-- Link existing Clerk organizations into the local database.
--
-- Why this file exists: clerk-auth.ts resolves the JWT's org_id against
-- auth_organization_identities, and rows only reach that table through Clerk's
-- organization.created webhook. Clerk's servers cannot POST to localhost, so on
-- a local stack the organization never syncs and every authenticated API call
-- answers 401 "Clerk organization is not linked" - after a successful sign-in,
-- which is what makes it look like an auth bug rather than a missing row.
--
-- seeds/local.sql creates a fictional org, which does not help: the id has to
-- match a real Clerk organization the signed-in user actually belongs to.
--
-- The Clerk org ids below were read from the Clerk Backend API
-- (GET /v1/users/<id>/organization_memberships), not invented. Both accounts
-- are org:admin of their respective organization.
--
-- Idempotent: safe to re-run after a database reset.
--
--   docker compose exec -T postgres psql -U sdp -d sdp -f - < this-file
--   (or: psql "$DATABASE_URL" -f apps/sdp-api/src/db/seeds/link-clerk-orgs.sql)

BEGIN;

-- ── johnnietse39@gmail.com → "Org For Testing" ───────────────────────────────
INSERT INTO organizations (id, name, slug, tier, status, created_at, updated_at)
VALUES ('org_local_testing', 'Org For Testing', 'org-for-testing', 'individual', 'active',
        now()::text, now()::text)
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth_organization_identities
       (id, provider, provider_org_id, organization_id, slug, created_at, updated_at)
VALUES ('aoi_local_testing', 'clerk', 'org_3FjuoVFmd7hxf7GQrgpYfkQp13n',
        'org_local_testing', 'org-for-testing', now()::text, now()::text)
ON CONFLICT (id) DO NOTHING;

INSERT INTO organization_members (id, organization_id, user_id, role, status, created_at)
VALUES ('mem_local_testing', 'org_local_testing',
        'usr_e63b4abe-6890-4bf6-9cbc-5276a86c13f7', 'admin', 'active', now()::text)
ON CONFLICT (organization_id, user_id) DO NOTHING;

-- proxy.ts bootstraps a selected project and prefers the slug "default-sandbox";
-- without one the dashboard has an organization but no project to scope to.
INSERT INTO projects (id, organization_id, name, slug, environment, status,
                      created_by, created_at, updated_at)
VALUES ('prj_local_testing', 'org_local_testing', 'Default Sandbox', 'default-sandbox',
        'sandbox', 'active', 'usr_e63b4abe-6890-4bf6-9cbc-5276a86c13f7',
        now()::text, now()::text)
ON CONFLICT (id) DO NOTHING;

-- project-context.ts:43 gates every project-scoped request on a JOIN against
-- project_members. Creating the project is not enough: being the organization
-- admin and even the project's own created_by grants nothing, because that
-- query only looks at this table. Without a row here the dashboard answers
-- 403 "Requested project is not accessible" on every wallet, key and issuance
-- call, having already passed the organization check.
INSERT INTO project_members (id, project_id, user_id, role, created_at)
VALUES ('prm_local_testing', 'prj_local_testing',
        'usr_e63b4abe-6890-4bf6-9cbc-5276a86c13f7', 'admin', now()::text)
ON CONFLICT (project_id, user_id) DO NOTHING;

-- ── johnnietse994@gmail.com → "Johnnie Yan Ho's Organization" ────────────────
INSERT INTO organizations (id, name, slug, tier, status, created_at, updated_at)
VALUES ('org_local_personal', 'Johnnie Yan Ho''s Organization', 'johnnie-yan-ho-org',
        'individual', 'active', now()::text, now()::text)
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth_organization_identities
       (id, provider, provider_org_id, organization_id, slug, created_at, updated_at)
VALUES ('aoi_local_personal', 'clerk', 'org_3HbEqMvuCJoax7EB5QhcnoTc288',
        'org_local_personal', 'johnnie-yan-ho-org', now()::text, now()::text)
ON CONFLICT (id) DO NOTHING;

INSERT INTO organization_members (id, organization_id, user_id, role, status, created_at)
VALUES ('mem_local_personal', 'org_local_personal',
        'usr_7aaaaa7e-3345-44ec-982e-9dfacfb78a97', 'admin', 'active', now()::text)
ON CONFLICT (organization_id, user_id) DO NOTHING;

INSERT INTO projects (id, organization_id, name, slug, environment, status,
                      created_by, created_at, updated_at)
VALUES ('prj_local_personal', 'org_local_personal', 'Default Sandbox', 'default-sandbox',
        'sandbox', 'active', 'usr_7aaaaa7e-3345-44ec-982e-9dfacfb78a97',
        now()::text, now()::text)
ON CONFLICT (id) DO NOTHING;

INSERT INTO project_members (id, project_id, user_id, role, created_at)
VALUES ('prm_local_personal', 'prj_local_personal',
        'usr_7aaaaa7e-3345-44ec-982e-9dfacfb78a97', 'admin', now()::text)
ON CONFLICT (project_id, user_id) DO NOTHING;

COMMIT;
