-- Safe login-only seed for Ledgr.
-- Run this after 01_schema.sql.
-- No chart of accounts. No business data.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

INSERT INTO public.organizations (
  id,
  name,
  slug,
  plan
)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Jauhals Real Estate',
  'jauhals-real-estate',
  'enterprise'
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  slug = EXCLUDED.slug,
  plan = EXCLUDED.plan,
  updated_at = now();

INSERT INTO public.users (
  id,
  org_id,
  email,
  full_name,
  password_hash,
  role,
  is_active
)
VALUES (
  '11111111-1111-1111-1111-111111111111',
  '00000000-0000-0000-0000-000000000001',
  's.jauhal@email.com',
  'Surinder Jauhal',
  '$2a$12$nb0kaOiEuK15OmjlRVSrZ.mTaYPUcZSY85PdDjtqbXzb8bcddMrem',
  'admin',
  true
)
ON CONFLICT (email) DO UPDATE SET
  org_id = EXCLUDED.org_id,
  full_name = EXCLUDED.full_name,
  password_hash = CASE
    WHEN EXCLUDED.password_hash = '$2a$12$nb0kaOiEuK15OmjlRVSrZ.mTaYPUcZSY85PdDjtqbXzb8bcddMrem' THEN public.users.password_hash
    ELSE EXCLUDED.password_hash
  END,
  role = EXCLUDED.role,
  is_active = true,
  updated_at = now();

INSERT INTO public.workspace (
  org_id,
  user_id,
  corporation_id,
  corporation_name,
  state
)
SELECT
  u.org_id,
  u.id,
  'corp-919',
  '919 Corporation',
  jsonb_build_object(
    'accounts', jsonb_build_array(),
    'bankRules', jsonb_build_array(),
    'manualRules', jsonb_build_array(),
    'intercompanyRules', jsonb_build_array(),
    'vendorNorm', jsonb_build_array(),
    'vendors', jsonb_build_array(),
    'expenseAP', jsonb_build_array(),
    'ptAP', jsonb_build_array(),
    'apVendor', jsonb_build_array(),
    'bankRows', jsonb_build_array(),
    'bankStagingRows', jsonb_build_array(),
    'manualRows', jsonb_build_array(),
    'openingRows', jsonb_build_array(),
    'arRows', jsonb_build_array(),
    'apBills', jsonb_build_array(),
    'icLinks', jsonb_build_array(),
    'posted', false,
    'uploads', jsonb_build_array(),
    'statementYear', '2021'
  )
FROM public.users u
WHERE lower(u.email) = lower('s.jauhal@email.com')
ON CONFLICT (org_id, corporation_id) DO NOTHING;

SELECT
  email,
  org_id,
  full_name,
  role,
  is_active,
  password_hash IS NOT NULL AS has_password
FROM public.users
WHERE lower(email) = lower('s.jauhal@email.com');

SELECT
  corporation_id,
  corporation_name,
  state
FROM public.workspace
ORDER BY corporation_name;
