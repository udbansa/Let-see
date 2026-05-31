-- Clean seed for index-9.
-- Do not insert entities, properties, vendors, rules, fiscal periods, raw transactions, or journal entries.

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

-- Replace PASTE_BCRYPT_HASH_HERE with your bcrypt password hash.
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
