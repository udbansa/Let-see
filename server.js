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
