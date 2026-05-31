require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');
const multer   = require('multer');
const { Pool } = require('pg');

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT   = process.env.PORT || 3000;
const JWT_SECRET    = process.env.JWT_SECRET || 'change-this-secret';
const FRONTEND_URL  = process.env.FRONTEND_URL || '*';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('supabase.com')
    ? { rejectUnauthorized: false }
    : undefined
});

app.use(cors({ origin: FRONTEND_URL === '*' ? true : FRONTEND_URL }));
app.use(express.json({ limit: '25mb' }));

// ── Empty state — NO pre-fed data ────────────────────────────
const emptyState = {
  accounts:    [],
  bankRules:   [],
  manualRules: [],
  vendorNorm:  [],
  expenseAP:   [],
  ptAP:        [],
  apVendor:    [],
  bankRows:    [],
  manualRows:  [],
  openingRows: [],
  posted:      false,
  uploads:     []
};

// ── Helpers ───────────────────────────────────────────────────
function publicUser(user) {
  return {
    id:       user.id,
    orgId:    user.org_id,
    email:    user.email,
    fullName: user.full_name,
    role:     user.role
  };
}

function signToken(user) {
  return jwt.sign(publicUser(user), JWT_SECRET, { expiresIn: '7d' });
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ── DB helpers ────────────────────────────────────────────────
async function getAccounts(orgId) {
  try {
    const { rows } = await pool.query(
      `SELECT id, code, name,
         sub_account AS "subAccount",
         sub_linkage AS "subLinkage",
         fs_label    AS "fsLabel",
         account_type AS "accountType"
       FROM accounts
       WHERE org_id = $1 AND is_active = true
       ORDER BY code`,
      [orgId]
    );
    return rows;
  } catch { return []; }
}

async function getWorkspace(orgId, userId) {
  try {
    const col   = orgId ? 'org_id = $1 AND user_id = $2' : 'user_id = $1';
    const params = orgId ? [orgId, userId] : [userId];
    const { rows } = await pool.query(
      `SELECT state FROM workspace WHERE ${col} LIMIT 1`, params
    );
    const saved = rows[0]?.state || {};
    const accounts = orgId ? await getAccounts(orgId) : (saved.accounts || []);
    return { ...emptyState, ...saved, accounts };
  } catch { return { ...emptyState }; }
}

async function saveWorkspace(orgId, userId, state) {
  const col    = orgId ? 'org_id, user_id' : 'user_id';
  const vals   = orgId ? '$1, $2' : '$1';
  const params = orgId ? [orgId, userId, JSON.stringify(state)] : [userId, JSON.stringify(state)];
  const stateIdx = orgId ? '$3' : '$2';
  const conflictCol = orgId ? 'org_id, user_id' : 'user_id';

  await pool.query(
    `INSERT INTO workspace (${col}, state, updated_at)
     VALUES (${vals}, ${stateIdx}, now())
     ON CONFLICT (${conflictCol})
     DO UPDATE SET state = ${stateIdx}, updated_at = now()`,
    params
  ).catch(async () => {
    // Fallback: try user_id only
    await pool.query(
      `INSERT INTO workspace (user_id, state, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id)
       DO UPDATE SET state = $2, updated_at = now()`,
      [userId, JSON.stringify(state)]
    );
  });
}

// ════════════════════════════════════════════════════════
// HEALTH
// ════════════════════════════════════════════════════════
app.get('/', (_req, res) => {
  res.json({ status: 'ok', app: 'Ledgr API v3.0', ts: new Date().toISOString() });
});

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
  } catch(e) {
    res.status(500).json({ status: 'error', db: e.message });
  }
});

// ════════════════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════════════════
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });
  try {
    // Try enterprise schema first (with org_id), fall back to simple
    let user;
    try {
      const { rows } = await pool.query(
        `SELECT u.*, o.slug as org_slug
         FROM users u
         LEFT JOIN organizations o ON o.id = u.org_id
         WHERE u.email = $1 AND u.is_active = true LIMIT 1`,
        [email.toLowerCase()]
      );
      user = rows[0];
    } catch {
      const { rows } = await pool.query(
        `SELECT * FROM users WHERE email = $1 AND is_active = true LIMIT 1`,
        [email.toLowerCase()]
      );
      user = rows[0];
    }
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const hash  = user.password_hash || user.password;
    const valid = await bcrypt.compare(password, hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    pool.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id]).catch(() => {});

    const token = signToken(user);
    res.json({
      token,
      user: {
        id:       user.id,
        email:    user.email,
        fullName: user.full_name,
        name:     user.full_name,
        role:     user.role,
        orgId:    user.org_id || null,
        orgSlug:  user.org_slug || null
      }
    });
  } catch(e) {
    console.error('login error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ════════════════════════════════════════════════════════
// STATE — full workspace JSON blob
// This is what index.html uses to save/load everything
// ════════════════════════════════════════════════════════
app.get('/api/state', auth, async (req, res) => {
  try {
    const state = await getWorkspace(req.user.orgId, req.user.id);
    res.json(state);
  } catch(e) {
    console.error('get state error:', e.message);
    res.json({ ...emptyState });
  }
});

app.post('/api/state', auth, async (req, res) => {
  try {
    await saveWorkspace(req.user.orgId, req.user.id, req.body);
    res.json({ ok: true });
  } catch(e) {
    console.error('post state error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════
// ACCOUNTS (COA)
// ════════════════════════════════════════════════════════
app.get('/api/accounts', auth, async (req, res) => {
  try {
    const rows = await getAccounts(req.user.orgId);
    res.json(rows);
  } catch { res.json([]); }
});

app.post('/api/accounts', auth, async (req, res) => {
  const { code, name, subAccount, subLinkage, fsLabel, accountType } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO accounts (org_id, code, name, sub_account, sub_linkage, fs_label, account_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.orgId, code, name, subAccount, subLinkage, fsLabel, accountType]
    );
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/accounts/:id', auth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE accounts SET is_active = false WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.user.orgId]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════
// ENTITIES
// ════════════════════════════════════════════════════════
app.get('/api/entities', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.*, COUNT(p.id) as property_count
       FROM entities e LEFT JOIN properties p ON p.entity_id = e.id
       WHERE e.org_id = $1 GROUP BY e.id ORDER BY e.name`,
      [req.user.orgId]
    );
    res.json(rows);
  } catch { res.json([]); }
});

// ════════════════════════════════════════════════════════
// PROPERTIES
// ════════════════════════════════════════════════════════
app.get('/api/properties', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, e.name as entity_name
       FROM properties p JOIN entities e ON e.id = p.entity_id
       WHERE p.org_id = $1 ORDER BY p.address`,
      [req.user.orgId]
    );
    res.json(rows);
  } catch { res.json([]); }
});

// ════════════════════════════════════════════════════════
// JOURNAL ENTRIES
// ════════════════════════════════════════════════════════
app.get('/api/journal-entries', auth, async (req, res) => {
  const { limit = 75, offset = 0, source, ruleType } = req.query;
  try {
    let sql = `SELECT je.*,
                 da.code as debit_code,   da.name as debit_name,
                 ca.code as credit_code,  ca.name as credit_name,
                 p.address as property_address,
                 v.name as vendor_name
               FROM journal_entries je
               JOIN accounts da ON da.id = je.debit_account_id
               JOIN accounts ca ON ca.id = je.credit_account_id
               LEFT JOIN properties p ON p.id = je.property_id
               LEFT JOIN vendors v ON v.id = je.vendor_id
               WHERE je.org_id = $1`;
    const params = [req.user.orgId];
    if (source)   { sql += ` AND je.source = $${params.length+1}`;    params.push(source); }
    if (ruleType) { sql += ` AND je.rule_type = $${params.length+1}`; params.push(ruleType); }
    sql += ` ORDER BY je.entry_date DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    params.push(limit, offset);
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch { res.json([]); }
});

app.post('/api/journal-entries', auth, async (req, res) => {
  const { referenceKey, entryDate, description, ruleType, source,
          amount, hstAmount, debitAccountId, creditAccountId } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount must be positive' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO journal_entries
         (org_id, reference_key, entry_date, description, rule_type, source,
          amount, hst_amount, debit_account_id, credit_account_id, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'posted',$11) RETURNING *`,
      [req.user.orgId, referenceKey, entryDate, description, ruleType,
       source||'MANUAL', amount, hstAmount||0, debitAccountId, creditAccountId, req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════
// INGEST / UPLOAD
// ════════════════════════════════════════════════════════
app.post('/api/ingest/upload', auth, upload.single('file'), async (req, res) => {
  // Classification happens in the browser engine.
  // This endpoint just records the upload.
  res.json({
    ok:       true,
    uploadId: require('crypto').randomUUID(),
    total:    0,
    matched:  0,
    review:   0
  });
});

app.post('/api/ingest/:uploadId/post', auth, async (req, res) => {
  res.json({ posted: 0, suspense: 0 });
});

// ════════════════════════════════════════════════════════
// REPORTS
// ════════════════════════════════════════════════════════
app.get('/api/reports/trial-balance', auth, async (req, res) => {
  try {
    // Try materialized view first, fall back to live query
    let rows;
    try {
      ({ rows } = await pool.query(
        `SELECT * FROM trial_balance WHERE org_id = $1 ORDER BY account_code`,
        [req.user.orgId]
      ));
    } catch {
      ({ rows } = await pool.query(
        `SELECT
           a.code as account_code, a.name as account_name,
           a.account_type, a.sub_linkage, a.fs_label,
           COALESCE(SUM(CASE WHEN je.debit_account_id=a.id THEN je.amount ELSE 0 END),0) as total_debit,
           COALESCE(SUM(CASE WHEN je.credit_account_id=a.id THEN je.amount ELSE 0 END),0) as total_credit,
           COALESCE(SUM(CASE WHEN je.debit_account_id=a.id THEN je.amount ELSE 0 END),0)
          -COALESCE(SUM(CASE WHEN je.credit_account_id=a.id THEN je.amount ELSE 0 END),0) as net_balance
         FROM accounts a
         LEFT JOIN journal_entries je ON (je.debit_account_id=a.id OR je.credit_account_id=a.id)
           AND je.status='posted' AND je.org_id=$1
         WHERE a.org_id=$1 AND a.is_active=true
         GROUP BY a.id,a.code,a.name,a.account_type,a.sub_linkage,a.fs_label
         ORDER BY a.code`,
        [req.user.orgId]
      ));
    }
    res.json(rows);
  } catch { res.json([]); }
});

app.get('/api/reports/income-statement', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.code, a.name, a.account_type, a.sub_account,
         COALESCE(SUM(CASE WHEN je.debit_account_id=a.id THEN je.amount ELSE 0 END),0) as debit_total,
         COALESCE(SUM(CASE WHEN je.credit_account_id=a.id THEN je.amount ELSE 0 END),0) as credit_total,
         CASE WHEN a.account_type='Revenue'
           THEN COALESCE(SUM(CASE WHEN je.credit_account_id=a.id THEN je.amount ELSE 0 END),0)
               -COALESCE(SUM(CASE WHEN je.debit_account_id=a.id THEN je.amount ELSE 0 END),0)
           ELSE COALESCE(SUM(CASE WHEN je.debit_account_id=a.id THEN je.amount ELSE 0 END),0)
               -COALESCE(SUM(CASE WHEN je.credit_account_id=a.id THEN je.amount ELSE 0 END),0)
         END as net_amount
       FROM accounts a
       LEFT JOIN journal_entries je ON (je.debit_account_id=a.id OR je.credit_account_id=a.id)
         AND je.status='posted' AND je.org_id=$1
       WHERE a.fs_label='Income Statement' AND a.org_id=$1 AND a.is_active=true
       GROUP BY a.id,a.code,a.name,a.account_type,a.sub_account ORDER BY a.account_type DESC,a.code`,
      [req.user.orgId]
    );
    const revenue  = rows.filter(r => r.account_type === 'Revenue');
    const expenses = rows.filter(r => r.account_type === 'Expense');
    const totalRev = revenue.reduce((s,r)  => s + parseFloat(r.net_amount||0), 0);
    const totalExp = expenses.reduce((s,r) => s + parseFloat(r.net_amount||0), 0);
    res.json({ revenue, expenses, totalRevenue: totalRev, totalExpenses: totalExp, netIncome: totalRev - totalExp });
  } catch { res.json({ revenue:[], expenses:[], totalRevenue:0, totalExpenses:0, netIncome:0 }); }
});

app.get('/api/reports/balance-sheet', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.code, a.name, a.account_type, a.sub_account,
         COALESCE(SUM(CASE WHEN je.debit_account_id=a.id THEN je.amount ELSE 0 END),0)
        -COALESCE(SUM(CASE WHEN je.credit_account_id=a.id THEN je.amount ELSE 0 END),0) as balance
       FROM accounts a
       LEFT JOIN journal_entries je ON (je.debit_account_id=a.id OR je.credit_account_id=a.id)
         AND je.status='posted' AND je.org_id=$1
       WHERE a.fs_label='Balance Sheet' AND a.org_id=$1 AND a.is_active=true
       GROUP BY a.id,a.code,a.name,a.account_type,a.sub_account ORDER BY a.account_type,a.code`,
      [req.user.orgId]
    );
    const byType = t => rows.filter(r => r.account_type === t);
    const sum    = arr => arr.reduce((s,r) => s + parseFloat(r.balance||0), 0);
    const assets      = [...byType('Asset'), ...byType('Contra-Asset')];
    const liabilities = byType('Liability');
    const equity      = byType('Equity');
    res.json({
      assets, liabilities, equity,
      totalAssets:      sum(assets),
      totalLiabilities: sum(liabilities),
      totalEquity:      sum(equity),
      balanced: Math.abs(sum(assets) + sum(liabilities) + sum(equity)) < 0.01
    });
  } catch { res.json({ assets:[], liabilities:[], equity:[], balanced:false }); }
});

// ════════════════════════════════════════════════════════
// USERS
// ════════════════════════════════════════════════════════
app.get('/api/users/me', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, email, full_name, role FROM users WHERE id = $1`, [req.user.id]
    );
    res.json(rows[0] || {});
  } catch { res.json({}); }
});

app.get('/api/users', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, full_name, email, role, is_active, created_at
       FROM users WHERE org_id = $1 ORDER BY full_name`,
      [req.user.orgId]
    );
    res.json(rows);
  } catch { res.json([]); }
});

// ════════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`Ledgr API v3.0 running on port ${PORT}`);
});

module.exports = app;
