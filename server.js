require('dotenv').config();

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { Pool } = require('pg');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret';
const FRONTEND_URL = process.env.FRONTEND_URL || '*';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('supabase.com')
    ? { rejectUnauthorized: false }
    : undefined
});

app.use(cors({ origin: FRONTEND_URL === '*' ? true : FRONTEND_URL }));
app.use(express.json({ limit: '25mb' }));

const emptyState = {
  accounts: [],
  bankRules: [],
  manualRules: [],
  intercompanyRules: [],
  vendorNorm: [],
  vendors: [],
  expenseAP: [],
  ptAP: [],
  apVendor: [],
  bankRows: [],
  bankStagingRows: [],
  manualRows: [],
  openingRows: [],
  arRows: [],
  apBills: [],
  icLinks: [],
  posted: false,
  uploads: [],
  statementYear: '2021'
};

function publicUser(user) {
  return {
    id: user.id,
    orgId: user.org_id,
    email: user.email,
    fullName: user.full_name,
    role: user.role
  };
}

function signToken(user) {
  return jwt.sign(publicUser(user), JWT_SECRET, { expiresIn: '7d' });
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function getAccounts(orgId, corporationId) {
  const { rows } = await pool.query(
    `SELECT
       id,
       corporation_id AS "corporationId",
       code,
       name,
       sub_account AS "subAccount",
       sub_linkage AS "subLinkage",
       fs_label AS "fsLabel",
       account_type AS "accountType"
     FROM public.accounts
     WHERE org_id = $1
       AND corporation_id = $2
       AND is_active = true
     ORDER BY code`,
    [orgId, corporationId]
  );

  return rows;
}

async function getWorkspace(orgId, corporationId) {
  const { rows } = await pool.query(
    `SELECT corporation_id, corporation_name, state
     FROM public.workspace
     WHERE org_id = $1
       AND corporation_id = $2
     LIMIT 1`,
    [orgId, corporationId]
  );

  if (!rows.length) return null;

  const row = rows[0];
  const saved = row.state || {};
  const accounts = await getAccounts(orgId, corporationId);

  return {
    corporationId: row.corporation_id,
    corporationName: row.corporation_name,
    state: {
      ...emptyState,
      ...saved,
      accounts
    }
  };
}

async function saveAccounts(orgId, corporationId, accounts, mode = 'replace') {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    if (mode === 'replace') {
      await client.query(
        `UPDATE public.accounts
         SET is_active = false,
             updated_at = now()
         WHERE org_id = $1
           AND corporation_id = $2`,
        [orgId, corporationId]
      );
    }

    for (const account of accounts || []) {
      if (!account.code || !account.name) continue;

      await client.query(
        `INSERT INTO public.accounts
           (org_id, corporation_id, code, name, sub_account, sub_linkage, fs_label, account_type, is_active)
         VALUES
           ($1, $2, $3, $4, $5, $6, $7, $8, true)
         ON CONFLICT (org_id, corporation_id, code)
         DO UPDATE SET
           name = EXCLUDED.name,
           sub_account = EXCLUDED.sub_account,
           sub_linkage = EXCLUDED.sub_linkage,
           fs_label = EXCLUDED.fs_label,
           account_type = EXCLUDED.account_type,
           is_active = true,
           updated_at = now()`,
        [
          orgId,
          corporationId,
          account.code,
          account.name,
          account.subAccount || account.sub_account || null,
          account.subLinkage || account.sub_linkage || null,
          account.fsLabel || account.fs_label || 'Balance Sheet',
          account.accountType || account.account_type || 'Asset'
        ]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    app: 'Ledgr API',
    ts: new Date().toISOString()
  });
});

app.get(['/health', '/api/health'], async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ status: 'error', db: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const { rows } = await pool.query(
      `SELECT u.*, o.slug AS org_slug
       FROM public.users u
       LEFT JOIN public.organizations o ON o.id = u.org_id
       WHERE lower(u.email) = lower($1)
         AND u.is_active = true
       LIMIT 1`,
      [email]
    );

    const user = rows[0];

    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);

    if (!ok) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    await pool.query(
      'UPDATE public.users SET last_login_at = now() WHERE id = $1',
      [user.id]
    );

    res.json({
      token: signToken(user),
      user: publicUser(user)
    });
  } catch (error) {
    console.error('login error', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/state', auth, async (req, res) => {
  try {
    const corporationId = String(req.query.corporationId || 'corp-919');
    const workspace = await getWorkspace(req.user.orgId, corporationId);

    if (!workspace) {
      return res.status(404).json({ notFound: true });
    }

    res.json(workspace);
  } catch (error) {
    console.error('state get error', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/state', auth, async (req, res) => {
  try {
    const corporationId = String(req.body.corporationId || 'corp-919');
    const corporationName = String(req.body.corporationName || '919 Corporation');

    const incoming = {
      ...emptyState,
      ...(req.body.state || req.body)
    };

    delete incoming.corporationId;
    delete incoming.corporationName;
    delete incoming.corporation;
    delete incoming.recordCount;
    delete incoming.reason;
    delete incoming.updatedAt;
    delete incoming.state;

    const accounts = Array.isArray(incoming.accounts) ? incoming.accounts : [];
    delete incoming.accounts;

    await pool.query(
      `INSERT INTO public.workspace
         (org_id, user_id, corporation_id, corporation_name, state)
       VALUES
         ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (org_id, corporation_id)
       DO UPDATE SET
         user_id = EXCLUDED.user_id,
         corporation_name = EXCLUDED.corporation_name,
         state = EXCLUDED.state,
         updated_at = now()`,
      [
        req.user.orgId,
        req.user.id,
        corporationId,
        corporationName,
        JSON.stringify(incoming)
      ]
    );

    await saveAccounts(
      req.user.orgId,
      corporationId,
      accounts,
      req.body.accountSyncMode || incoming.accountSyncMode || 'replace'
    );

    res.json({
      ok: true,
      corporationId,
      corporationName,
      state: {
        ...incoming,
        accounts
      }
    });
  } catch (error) {
    console.error('state save error', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post(['/api/backup', '/api/cloud-backup'], auth, async (req, res) => {
  try {
    const corporationId = String(req.body.corporationId || 'corp-919');
    const corporationName = String(req.body.corporationName || '919 Corporation');
    const backupJson = req.body.state || req.body.backup || req.body;
    const recordCount = Number(req.body.recordCount || 0);
    const reason = String(req.body.reason || 'cloud backup');

    await pool.query(
      `INSERT INTO public.workspace_backups
         (org_id, user_id, corporation_id, corporation_name, backup_json, backup_reason, record_count)
       VALUES
         ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [
        req.user.orgId,
        req.user.id,
        corporationId,
        corporationName,
        JSON.stringify(backupJson),
        reason,
        recordCount
      ]
    );

    res.json({
      ok: true,
      corporationId,
      corporationName
    });
  } catch (error) {
    console.error('backup save error', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get(['/api/backup', '/api/cloud-backup'], auth, async (req, res) => {
  try {
    const corporationId = String(req.query.corporationId || 'corp-919');

    const { rows } = await pool.query(
      `SELECT corporation_id, corporation_name, backup_json
       FROM public.workspace_backups
       WHERE org_id = $1
         AND corporation_id = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [req.user.orgId, corporationId]
    );

    if (!rows.length) {
      return res.status(404).json({ notFound: true });
    }

    res.json({
      corporationId: rows[0].corporation_id,
      corporationName: rows[0].corporation_name,
      state: rows[0].backup_json
    });
  } catch (error) {
    console.error('backup get error', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/accounts', auth, async (req, res) => {
  try {
    const corporationId = String(req.query.corporationId || 'corp-919');
    res.json(await getAccounts(req.user.orgId, corporationId));
  } catch {
    res.json([]);
  }
});

app.get('/api/workflow/specs', auth, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT spec_key, display_name, purpose, headers, dependencies
       FROM public.workflow_specs
       ORDER BY spec_key`
    );
    res.json(rows);
  } catch {
    res.json([]);
  }
});

app.post('/api/ingest/upload', auth, upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const corporationId = String(req.body.corporationId || req.query.corporationId || 'corp-919');

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { rows } = await pool.query(
      `INSERT INTO public.uploads
         (org_id, user_id, corporation_id, name, rows, status, payload)
       VALUES
         ($1, $2, $3, $4, 0, 'synced', $5::jsonb)
       RETURNING id`,
      [
        req.user.orgId,
        req.user.id,
        corporationId,
        file.originalname,
        JSON.stringify({
          mimetype: file.mimetype,
          size: file.size
        })
      ]
    );

    res.json({
      uploadId: rows[0].id,
      total: 0,
      matched: 0,
      review: 0
    });
  } catch (error) {
    console.error('upload error', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Ledgr API running on 0.0.0.0:${PORT}`);
});  expenseAP: [],
  ptAP: [],
  apVendor: [],
  bankRows: [],
  bankStagingRows: [],
  manualRows: [],
  openingRows: [],
  arRows: [],
  apBills: [],
  icLinks: [],
  posted: false,
  uploads: [],
  statementYear: '2021'
};

function publicUser(user) {
  return {
    id: user.id,
    orgId: user.org_id,
    email: user.email,
    fullName: user.full_name,
    role: user.role
  };
}

function signToken(user) {
  return jwt.sign(publicUser(user), JWT_SECRET, { expiresIn: '7d' });
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function getAccounts(orgId, corporationId) {
  const { rows } = await pool.query(
    `SELECT
       id,
       corporation_id AS "corporationId",
       code,
       name,
       sub_account AS "subAccount",
       sub_linkage AS "subLinkage",
       fs_label AS "fsLabel",
       account_type AS "accountType"
     FROM public.accounts
     WHERE org_id = $1
       AND corporation_id = $2
       AND is_active = true
     ORDER BY code`,
    [orgId, corporationId]
  );

  return rows;
}

async function getWorkspace(orgId, corporationId) {
  const { rows } = await pool.query(
    `SELECT corporation_id, corporation_name, state
     FROM public.workspace
     WHERE org_id = $1
       AND corporation_id = $2
     LIMIT 1`,
    [orgId, corporationId]
  );

  if (!rows.length) return null;

  const row = rows[0];
  const saved = row.state || {};
  const accounts = await getAccounts(orgId, corporationId);

  return {
    corporationId: row.corporation_id,
    corporationName: row.corporation_name,
    state: {
      ...emptyState,
      ...saved,
      accounts
    }
  };
}

async function saveAccounts(orgId, corporationId, accounts, mode = 'replace') {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    if (mode === 'replace') {
      await client.query(
        `UPDATE public.accounts
         SET is_active = false,
             updated_at = now()
         WHERE org_id = $1
           AND corporation_id = $2`,
        [orgId, corporationId]
      );
    }

    for (const account of accounts || []) {
      if (!account.code || !account.name) continue;

      await client.query(
        `INSERT INTO public.accounts
           (org_id, corporation_id, code, name, sub_account, sub_linkage, fs_label, account_type, is_active)
         VALUES
           ($1, $2, $3, $4, $5, $6, $7, $8, true)
         ON CONFLICT (org_id, corporation_id, code)
         DO UPDATE SET
           name = EXCLUDED.name,
           sub_account = EXCLUDED.sub_account,
           sub_linkage = EXCLUDED.sub_linkage,
           fs_label = EXCLUDED.fs_label,
           account_type = EXCLUDED.account_type,
           is_active = true,
           updated_at = now()`,
        [
          orgId,
          corporationId,
          account.code,
          account.name,
          account.subAccount || account.sub_account || null,
          account.subLinkage || account.sub_linkage || null,
          account.fsLabel || account.fs_label || 'Balance Sheet',
          account.accountType || account.account_type || 'Asset'
        ]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    app: 'Ledgr API',
    ts: new Date().toISOString()
  });
});

app.get(['/health', '/api/health'], async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ status: 'error', db: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const { rows } = await pool.query(
      `SELECT u.*, o.slug AS org_slug
       FROM public.users u
       LEFT JOIN public.organizations o ON o.id = u.org_id
       WHERE lower(u.email) = lower($1)
         AND u.is_active = true
       LIMIT 1`,
      [email]
    );

    const user = rows[0];

    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);

    if (!ok) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    await pool.query(
      'UPDATE public.users SET last_login_at = now() WHERE id = $1',
      [user.id]
    );

    res.json({
      token: signToken(user),
      user: publicUser(user)
    });
  } catch (error) {
    console.error('login error', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/state', auth, async (req, res) => {
  try {
    const corporationId = String(req.query.corporationId || 'corp-919');
    const workspace = await getWorkspace(req.user.orgId, corporationId);

    if (!workspace) {
      return res.status(404).json({ notFound: true });
    }

    res.json(workspace);
  } catch (error) {
    console.error('state get error', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/state', auth, async (req, res) => {
  try {
    const corporationId = String(req.body.corporationId || 'corp-919');
    const corporationName = String(req.body.corporationName || '919 Corporation');

    const incoming = {
      ...emptyState,
      ...(req.body.state || req.body)
    };

    delete incoming.corporationId;
    delete incoming.corporationName;
    delete incoming.corporation;
    delete incoming.recordCount;
    delete incoming.reason;
    delete incoming.updatedAt;
    delete incoming.state;

    const accounts = Array.isArray(incoming.accounts) ? incoming.accounts : [];
    delete incoming.accounts;

    await pool.query(
      `INSERT INTO public.workspace
         (org_id, user_id, corporation_id, corporation_name, state)
       VALUES
         ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (org_id, corporation_id)
       DO UPDATE SET
         user_id = EXCLUDED.user_id,
         corporation_name = EXCLUDED.corporation_name,
         state = EXCLUDED.state,
         updated_at = now()`,
      [
        req.user.orgId,
        req.user.id,
        corporationId,
        corporationName,
        JSON.stringify(incoming)
      ]
    );

    await saveAccounts(
      req.user.orgId,
      corporationId,
      accounts,
      req.body.accountSyncMode || incoming.accountSyncMode || 'replace'
    );

    res.json({
      ok: true,
      corporationId,
      corporationName,
      state: {
        ...incoming,
        accounts
      }
    });
  } catch (error) {
    console.error('state save error', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post(['/api/backup', '/api/cloud-backup'], auth, async (req, res) => {
  try {
    const corporationId = String(req.body.corporationId || 'corp-919');
    const corporationName = String(req.body.corporationName || '919 Corporation');
    const backupJson = req.body.state || req.body.backup || req.body;
    const recordCount = Number(req.body.recordCount || 0);
    const reason = String(req.body.reason || 'cloud backup');

    await pool.query(
      `INSERT INTO public.workspace_backups
         (org_id, user_id, corporation_id, corporation_name, backup_json, backup_reason, record_count)
       VALUES
         ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [
        req.user.orgId,
        req.user.id,
        corporationId,
        corporationName,
        JSON.stringify(backupJson),
        reason,
        recordCount
      ]
    );

    res.json({
      ok: true,
      corporationId,
      corporationName
    });
  } catch (error) {
    console.error('backup save error', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get(['/api/backup', '/api/cloud-backup'], auth, async (req, res) => {
  try {
    const corporationId = String(req.query.corporationId || 'corp-919');

    const { rows } = await pool.query(
      `SELECT corporation_id, corporation_name, backup_json
       FROM public.workspace_backups
       WHERE org_id = $1
         AND corporation_id = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [req.user.orgId, corporationId]
    );

    if (!rows.length) {
      return res.status(404).json({ notFound: true });
    }

    res.json({
      corporationId: rows[0].corporation_id,
      corporationName: rows[0].corporation_name,
      state: rows[0].backup_json
    });
  } catch (error) {
    console.error('backup get error', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/accounts', auth, async (req, res) => {
  try {
    const corporationId = String(req.query.corporationId || 'corp-919');
    res.json(await getAccounts(req.user.orgId, corporationId));
  } catch {
    res.json([]);
  }
});

app.get('/api/workflow/specs', auth, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT spec_key, display_name, purpose, headers, dependencies
       FROM public.workflow_specs
       ORDER BY spec_key`
    );
    res.json(rows);
  } catch {
    res.json([]);
  }
});

app.post('/api/ingest/upload', auth, upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const corporationId = String(req.body.corporationId || req.query.corporationId || 'corp-919');

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { rows } = await pool.query(
      `INSERT INTO public.uploads
         (org_id, user_id, corporation_id, name, rows, status, payload)
       VALUES
         ($1, $2, $3, $4, 0, 'synced', $5::jsonb)
       RETURNING id`,
      [
        req.user.orgId,
        req.user.id,
        corporationId,
        file.originalname,
        JSON.stringify({
          mimetype: file.mimetype,
          size: file.size
        })
      ]
    );

    res.json({
      uploadId: rows[0].id,
      total: 0,
      matched: 0,
      review: 0
    });
  } catch (error) {
    console.error('upload error', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Ledgr API running on 0.0.0.0:${PORT}`);
});
