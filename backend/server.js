const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

app.get('/', (req, res) => {
  res.json({ message: '1099 Document Portal API is running' });
});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, database: true });
  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json({ ok: false, database: false, error: error.message });
  }
});

/*
  STEP 1 DATABASE UPGRADE ROUTE
  Run once after deploy:
  /setup-v2
*/
app.get('/setup-v2', async (req, res) => {
  try {
    await pool.query(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";

      CREATE TABLE IF NOT EXISTS contractors (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        contractor_name TEXT NOT NULL,
        business_name TEXT,
        email TEXT,
        phone TEXT,
        ra_contact_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_contractors_ra_contact_id
      ON contractors(ra_contact_id);

      ALTER TABLE contractors
        ADD COLUMN IF NOT EXISTS business_name TEXT,
        ADD COLUMN IF NOT EXISTS phone TEXT,
        ADD COLUMN IF NOT EXISTS ra_contact_id TEXT,
        ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

      CREATE TABLE IF NOT EXISTS financial_entries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        contractor_id UUID REFERENCES contractors(id) ON DELETE CASCADE,
        entry_type TEXT NOT NULL,
        source_type TEXT NOT NULL DEFAULT 'manual',
        entry_date DATE NOT NULL,
        month INT NOT NULL,
        year INT NOT NULL,
        original_amount NUMERIC(12,2) NOT NULL,
        original_category TEXT,
        original_description TEXT,
        original_vendor_or_payor TEXT,
        reviewed_amount NUMERIC(12,2),
        reviewed_category TEXT,
        reviewed_description TEXT,
        reviewed_vendor_or_payor TEXT,
        included_in_pl BOOLEAN NOT NULL DEFAULT true,
        is_overridden BOOLEAN NOT NULL DEFAULT false,
        override_reason TEXT,
        reviewed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      ALTER TABLE financial_entries
        ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'manual',
        ADD COLUMN IF NOT EXISTS original_description TEXT,
        ADD COLUMN IF NOT EXISTS original_vendor_or_payor TEXT,
        ADD COLUMN IF NOT EXISTS reviewed_description TEXT,
        ADD COLUMN IF NOT EXISTS reviewed_vendor_or_payor TEXT,
        ADD COLUMN IF NOT EXISTS included_in_pl BOOLEAN NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS is_overridden BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS override_reason TEXT,
        ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

      CREATE TABLE IF NOT EXISTS entry_notes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        entry_id UUID NOT NULL REFERENCES financial_entries(id) ON DELETE CASCADE,
        note TEXT NOT NULL,
        author_name TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS monthly_summaries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        contractor_id UUID NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
        month INT NOT NULL,
        year INT NOT NULL,
        gross_income NUMERIC(12,2) NOT NULL DEFAULT 0,
        total_expenses NUMERIC(12,2) NOT NULL DEFAULT 0,
        net_profit NUMERIC(12,2) NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (contractor_id, month, year)
      );

      CREATE TABLE IF NOT EXISTS pl_reports (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        contractor_id UUID NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
        month INT NOT NULL,
        year INT NOT NULL,
        version_number INT NOT NULL DEFAULT 1,
        report_json JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        contractor_id UUID NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
        document_type TEXT,
        file_name TEXT,
        storage_reference TEXT,
        period_month INT,
        period_year INT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    res.json({ message: 'Database setup v2 complete' });
  } catch (error) {
    console.error('Setup v2 error:', error);
    res.status(500).json({ error: error.message });
  }
});

/*
  CONTRACTORS
*/
app.post('/api/contractors', async (req, res) => {
  const {
    contractor_name,
    business_name,
    email,
    phone,
    ra_contact_id,
    status
  } = req.body;

  if (!contractor_name) {
    return res.status(400).json({ error: 'contractor_name is required' });
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO contractors (
        contractor_name,
        business_name,
        email,
        phone,
        ra_contact_id,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [
        contractor_name,
        business_name || null,
        email || null,
        phone || null,
        ra_contact_id || null,
        status || 'active'
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create contractor error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/contractors', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM contractors
      ORDER BY created_at DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('List contractors error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/contractors/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM contractors WHERE id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Contractor not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get contractor error:', error);
    res.status(500).json({ error: error.message });
  }
});

/*
  FINANCIAL ENTRIES
*/
app.post('/api/entries', async (req, res) => {
  const {
    contractor_id,
    entry_type,
    source_type,
    entry_date,
    month,
    year,
    amount,
    category,
    description,
    vendor_or_payor
  } = req.body;

  if (!contractor_id || !entry_type || !entry_date || !month || !year || amount == null) {
    return res.status(400).json({
      error: 'contractor_id, entry_type, entry_date, month, year, and amount are required'
    });
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO financial_entries (
        contractor_id,
        entry_type,
        source_type,
        entry_date,
        month,
        year,
        original_amount,
        original_category,
        original_description,
        original_vendor_or_payor
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
      `,
      [
        contractor_id,
        entry_type,
        source_type || 'manual',
        entry_date,
        month,
        year,
        amount,
        category || null,
        description || null,
        vendor_or_payor || null
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create entry error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/entries/:contractorId/:year/:month', async (req, res) => {
  const { contractorId, year, month } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT *
      FROM financial_entries
      WHERE contractor_id = $1
        AND year = $2
        AND month = $3
      ORDER BY entry_date DESC, created_at DESC
      `,
      [contractorId, year, month]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Load entries error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/entries/:entryId/notes', async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT *
      FROM entry_notes
      WHERE entry_id = $1
      ORDER BY created_at DESC
      `,
      [req.params.entryId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Load notes error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/entries/:entryId/notes', async (req, res) => {
  const { note, author_name } = req.body;

  if (!note) {
    return res.status(400).json({ error: 'note is required' });
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO entry_notes (entry_id, note, author_name)
      VALUES ($1, $2, $3)
      RETURNING *
      `,
      [req.params.entryId, note, author_name || 'Admin']
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Add note error:', error);
    res.status(500).json({ error: error.message });
  }
});

/*
  ADMIN REVIEW / CORRECTION
*/
app.patch('/api/entries/:id/review', async (req, res) => {
  const {
    reviewed_amount,
    reviewed_category,
    reviewed_description,
    reviewed_vendor_or_payor,
    included_in_pl,
    override_reason
  } = req.body;

  try {
    const result = await pool.query(
      `
      UPDATE financial_entries
      SET
        reviewed_amount = COALESCE($1, reviewed_amount),
        reviewed_category = COALESCE($2, reviewed_category),
        reviewed_description = COALESCE($3, reviewed_description),
        reviewed_vendor_or_payor = COALESCE($4, reviewed_vendor_or_payor),
        included_in_pl = COALESCE($5, included_in_pl),
        override_reason = COALESCE($6, override_reason),
        is_overridden = true,
        reviewed_at = NOW(),
        updated_at = NOW()
      WHERE id = $7
      RETURNING *
      `,
      [
        reviewed_amount ?? null,
        reviewed_category ?? null,
        reviewed_description ?? null,
        reviewed_vendor_or_payor ?? null,
        included_in_pl ?? null,
        override_reason ?? null,
        req.params.id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Entry not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Review entry error:', error);
    res.status(500).json({ error: error.message });
  }
});

/*
  MONTHLY SUMMARY
*/
app.get('/api/monthly-summary/:contractorId/:year/:month', async (req, res) => {
  const { contractorId, year, month } = req.params;

  try {
    const entriesResult = await pool.query(
      `
      SELECT
        entry_type,
        COALESCE(reviewed_amount, original_amount) AS amount,
        COALESCE(reviewed_category, original_category, 'Uncategorized') AS category,
        included_in_pl
      FROM financial_entries
      WHERE contractor_id = $1
        AND year = $2
        AND month = $3
        AND included_in_pl = true
      `,
      [contractorId, year, month]
    );

    let gross_income = 0;
    let total_expenses = 0;
    const expense_categories = {};

    for (const row of entriesResult.rows) {
      const amount = Number(row.amount || 0);

      if (row.entry_type === 'income') {
        gross_income += amount;
      } else if (row.entry_type === 'expense') {
        total_expenses += amount;
        expense_categories[row.category] = (expense_categories[row.category] || 0) + amount;
      }
    }

    const net_profit = gross_income - total_expenses;

    res.json({
      contractor_id: contractorId,
      month: Number(month),
      year: Number(year),
      gross_income,
      total_expenses,
      net_profit,
      expense_categories
    });
  } catch (error) {
    console.error('Monthly summary error:', error);
    res.status(500).json({ error: error.message });
  }
});

/*
  DRAFT P&L GENERATOR
*/
app.post('/api/reports/generate/:contractorId', async (req, res) => {
  const { contractorId } = req.params;
  const { month, year } = req.body;

  if (!month || !year) {
    return res.status(400).json({ error: 'month and year are required' });
  }

  try {
    const contractorResult = await pool.query(
      `SELECT * FROM contractors WHERE id = $1`,
      [contractorId]
    );

    if (contractorResult.rows.length === 0) {
      return res.status(404).json({ error: 'Contractor not found' });
    }

    const entriesResult = await pool.query(
      `
      SELECT
        entry_type,
        COALESCE(reviewed_amount, original_amount) AS amount,
        COALESCE(reviewed_category, original_category, 'Uncategorized') AS category,
        included_in_pl
      FROM financial_entries
      WHERE contractor_id = $1
        AND month = $2
        AND year = $3
        AND included_in_pl = true
      `,
      [contractorId, month, year]
    );

    let gross_income = 0;
    let total_expenses = 0;
    const expense_categories = {};

    for (const row of entriesResult.rows) {
      const amount = Number(row.amount || 0);

      if (row.entry_type === 'income') {
        gross_income += amount;
      } else if (row.entry_type === 'expense') {
        total_expenses += amount;
        expense_categories[row.category] = (expense_categories[row.category] || 0) + amount;
      }
    }

    const net_profit = gross_income - total_expenses;

    const versionResult = await pool.query(
      `
      SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
      FROM pl_reports
      WHERE contractor_id = $1
        AND month = $2
        AND year = $3
      `,
      [contractorId, month, year]
    );

    const version_number = Number(versionResult.rows[0].next_version);

    const reportPayload = {
      contractor: contractorResult.rows[0],
      month,
      year,
      gross_income,
      total_expenses,
      net_profit,
      expense_categories,
      generated_at: new Date().toISOString()
    };

    const reportInsert = await pool.query(
      `
      INSERT INTO pl_reports (
        contractor_id,
        month,
        year,
        version_number,
        report_json,
        status
      )
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *
      `,
      [
        contractorId,
        month,
        year,
        version_number,
        JSON.stringify(reportPayload),
        'draft'
      ]
    );

    await pool.query(
      `
      INSERT INTO monthly_summaries (
        contractor_id,
        month,
        year,
        gross_income,
        total_expenses,
        net_profit,
        status,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT (contractor_id, month, year)
      DO UPDATE SET
        gross_income = EXCLUDED.gross_income,
        total_expenses = EXCLUDED.total_expenses,
        net_profit = EXCLUDED.net_profit,
        status = EXCLUDED.status,
        updated_at = NOW()
      `,
      [
        contractorId,
        month,
        year,
        gross_income,
        total_expenses,
        net_profit,
        'draft'
      ]
    );

    res.json({
      message: 'Draft P&L generated',
      report: reportInsert.rows[0],
      summary: reportPayload
    });
  } catch (error) {
    console.error('Generate report error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports/:contractorId', async (req, res) => {
  const { contractorId } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT *
      FROM pl_reports
      WHERE contractor_id = $1
      ORDER BY year DESC, month DESC, version_number DESC
      `,
      [contractorId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('List reports error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
