-- Safe login-only seed for Ledgr.
-- Run this after 01_schema.sql.
--
-- IMPORTANT:
-- Replace PASTE_BCRYPT_HASH_HERE with your real bcrypt hash.
-- Do not put your plain SaaS password here.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

ALTER TABLE public.organizations
ADD COLUMN IF NOT EXISTS slug text;

ALTER TABLE public.organizations
ADD COLUMN IF NOT EXISTS plan text DEFAULT 'starter';

ALTER TABLE public.organizations
ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS org_id uuid;

ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS full_name text;

ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS password_hash text;

ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS role text DEFAULT 'bookkeeper';

ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;

ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

INSERT INTO public.organizations (id, name, slug, plan)
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
  'PASTE_BCRYPT_HASH_HERE',
  'admin',
  true
)
ON CONFLICT (email) DO UPDATE SET
  org_id = EXCLUDED.org_id,
  full_name = EXCLUDED.full_name,
  password_hash = CASE
    WHEN EXCLUDED.password_hash = 'PASTE_BCRYPT_HASH_HERE' THEN public.users.password_hash
    ELSE EXCLUDED.password_hash
  END,
  role = EXCLUDED.role,
  is_active = true,
  updated_at = now();

INSERT INTO public.workspace (org_id, user_id, state)
SELECT
  u.org_id,
  u.id,
  jsonb_build_object(
    'accounts', jsonb_build_array(),
    'bankRules', jsonb_build_array(),
    'manualRules', jsonb_build_array(),
    'vendorNorm', jsonb_build_array(),
    'expenseAP', jsonb_build_array(),
    'ptAP', jsonb_build_array(),
    'bankRows', jsonb_build_array(),
    'manualRows', jsonb_build_array(),
    'openingRows', jsonb_build_array(),
    'posted', false,
    'uploads', jsonb_build_array()
  )
FROM public.users u
WHERE lower(u.email) = lower('s.jauhal@email.com')
ON CONFLICT (org_id, user_id) DO NOTHING;

SELECT
  email,
  org_id,
  full_name,
  role,
  is_active,
  password_hash IS NOT NULL AS has_password
FROM public.users
WHERE lower(email) = lower('s.jauhal@email.com');
