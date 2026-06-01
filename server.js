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
  vendorNorm: [],
  expenseAP: [],
  ptAP: [],
  apVendor: [],
  bankRows: [],
  manualRows: [],
  openingRows: [],
  posted: false,
  uploads: []
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

async function getAccounts(orgId) {
  const { rows } = await pool.query(
    `SELECT
       id,
       code,
       name,
       sub_account AS "subAccount",
       sub_linkage AS "subLinkage",
       fs_label AS "fsLabel",
       account_type AS "accountType"
     FROM public.accounts
     WHERE org_id = $1 AND is_active = true
     ORDER BY code`,
    [orgId]
  );
  return rows;
}

async function getWorkspace(orgId, userId) {
  const { rows } = await pool.query(
    `SELECT state
     FROM public.workspace
     WHERE org_id = $1 AND user_id = $2
     LIMIT 1`,
    [orgId, userId]
  );

  const saved = rows[0]?.state || {};
  const accounts = await getAccounts(orgId);
  return { ...emptyState, ...saved, accounts };
}
