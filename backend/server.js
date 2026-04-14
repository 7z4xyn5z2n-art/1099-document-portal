const express = require('express');
const { DocumentProcessorServiceClient } = require('@google-cloud/documentai').v1;
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const bcrypt = require('bcrypt');

const app = express();
let documentAiClient;

try {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

  documentAiClient = new DocumentProcessorServiceClient({
    credentials,
  });
} catch (err) {
  console.error('Google Document AI init error:', err);
}
const port = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024
  }
});

/*
  AUTH MIDDLEWARE
*/

async function requireStaffAuth(req, res, next) {
  try {
    const userId = req.headers['x-user-id'];

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized: missing user id' });
    }

    const result = await pool.query(
      `
      SELECT *
      FROM staff_users
      WHERE id = $1
        AND is_active = true
      `,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Unauthorized: invalid user' });
    }

    req.staffUser = result.rows[0];

    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    res.status(500).json({ error: err.message });
  }
}

function requireAdmin(req, res, next) {
  if (!req.staffUser) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.staffUser.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  next();
}

function generateAccessToken() {
  return crypto.randomBytes(32).toString('hex');
}
function getGoogleCredentials() {
  return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
}

function getDocumentAiLocation() {
  return process.env.GOOGLE_DOCUMENT_AI_LOCATION || 'us';
}

function getProcessorIdByDocType(documentType) {
  const type = String(documentType || '').toLowerCase();

  if (type === 'invoice') {
    return process.env.GOOGLE_DOCUMENT_AI_INVOICE_PROCESSOR_ID || '';
  }

  if (type === 'statement') {
    return process.env.GOOGLE_DOCUMENT_AI_BANK_STATEMENT_PROCESSOR_ID || '';
  }

  return process.env.GOOGLE_DOCUMENT_AI_EXPENSE_PROCESSOR_ID || '';
}

function extractEntityText(entities, type) {
  const match = (entities || []).find(entity => entity.type === type);
  return match?.mentionText || '';
}

function normalizeAmount(value) {
  if (!value) return '';
  const cleaned = String(value).replace(/[^0-9.-]/g, '');
  return cleaned || '';
}

function guessCategoryFromText(textSource) {
  const text = String(textSource || '').toLowerCase();

  if (
    text.includes('shell') ||
    text.includes('chevron') ||
    text.includes('exxon') ||
    text.includes('bp') ||
    text.includes('fuel') ||
    text.includes('gas')
  ) {
    return { category: 'Gas', confidence: 'high' };
  }

  if (
    text.includes('restaurant') ||
    text.includes('meal') ||
    text.includes('food') ||
    text.includes('doordash') ||
    text.includes('uber eats') ||
    text.includes('mcdonald') ||
    text.includes('chick-fil-a')
  ) {
    return { category: 'Meals', confidence: 'high' };
  }

  if (
    text.includes('insurance') ||
    text.includes('geico') ||
    text.includes('progressive') ||
    text.includes('allstate')
  ) {
    return { category: 'Insurance', confidence: 'high' };
  }

  if (
    text.includes('office') ||
    text.includes('staples') ||
    text.includes('depot') ||
    text.includes('supplies')
  ) {
    return { category: 'Office Supplies', confidence: 'medium' };
  }

  if (
    text.includes('ad') ||
    text.includes('ads') ||
    text.includes('facebook') ||
    text.includes('meta') ||
    text.includes('google ads')
  ) {
    return { category: 'Advertising', confidence: 'medium' };
  }

  return { category: 'Uncategorized', confidence: 'low' };
}

async function analyzeDocumentWithGoogle(doc, fileBuffer, mimeType) {
  if (!documentAiClient) {
    throw new Error('Document AI client not initialized');
  }

  const processorId = getProcessorIdByDocType(doc.document_type);

  if (!processorId) {
    throw new Error(`Missing processor ID for document type: ${doc.document_type || 'receipt'}`);
  }

  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  const location = getDocumentAiLocation();

  const name = `projects/${projectId}/locations/${location}/processors/${processorId}`;

  const [result] = await documentAiClient.processDocument({
    name,
    rawDocument: {
      content: fileBuffer.toString('base64'),
      mimeType,
    },
  });

  const entities = result?.document?.entities || [];
  const fullText = result?.document?.text || '';

  let rawAmount =
    extractEntityText(entities, 'total_amount') ||
    extractEntityText(entities, 'net_amount') ||
    extractEntityText(entities, 'amount_due') ||
    '';

  if (!rawAmount && fullText) {
    const matches = fullText.match(/\$?\d{1,3}(,\d{3})*(\.\d{2})/g);
    if (matches && matches.length > 0) {
      rawAmount = matches[matches.length - 1]; // usually total is last
    }
  }

  const rawVendor =
    extractEntityText(entities, 'supplier_name') ||
    extractEntityText(entities, 'merchant_name') ||
    extractEntityText(entities, 'vendor_name') ||
    '';

 let cleanedVendor = rawVendor;

if (!cleanedVendor && fullText) {
  const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > 0) {
    cleanedVendor = lines[0]; // first line is often vendor name
  }
}

cleanedVendor = cleanedVendor
  .replace(/\s+/g, ' ')
  .replace(/^[^a-zA-Z0-9]+/, '')
  .trim();

if (cleanedVendor.length > 60) {
  cleanedVendor = cleanedVendor.slice(0, 60).trim();
}
  
  const rawDate =
    extractEntityText(entities, 'invoice_date') ||
    extractEntityText(entities, 'receipt_date') ||
    extractEntityText(entities, 'due_date') ||
    extractEntityText(entities, 'transaction_date') ||
    extractEntityText(entities, 'date') ||
    '';

  const combinedText = [
    doc.file_name || '',
    doc.notes || '',
    rawVendor || '',
    fullText || '',
  ].join(' ');

  const categoryGuess = guessCategoryFromText(combinedText);

  return {
    amount: normalizeAmount(rawAmount) || '0.00',
    vendor_or_payor: cleanedVendor || '',
    entry_date: rawDate || new Date().toISOString().slice(0, 10),
    category: categoryGuess.category,
    confidence: categoryGuess.confidence,
    description: 'Draft created from document analysis',
    raw_text_preview: fullText.slice(0, 1000),
  };
}
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
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      ALTER TABLE contractors
        ADD COLUMN IF NOT EXISTS business_name TEXT,
        ADD COLUMN IF NOT EXISTS email TEXT,
        ADD COLUMN IF NOT EXISTS phone TEXT,
        ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

      CREATE TABLE IF NOT EXISTS financial_entries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        contractor_id UUID REFERENCES contractors(id) ON DELETE CASCADE,

        document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
        
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
  ADD COLUMN IF NOT EXISTS document_id UUID REFERENCES documents(id) ON DELETE SET NULL;

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
        category TEXT,
        file_name TEXT,
        storage_reference TEXT,
        period_month INT,
        period_year INT,
        notes TEXT,
        review_status TEXT NOT NULL DEFAULT 'new',
        reviewed_by TEXT,
        reviewed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );

      ALTER TABLE documents
        ADD COLUMN IF NOT EXISTS category TEXT,
        ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'new',
        ADD COLUMN IF NOT EXISTS reviewed_by TEXT,
        ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP;
        
      CREATE TABLE IF NOT EXISTS contractor_access_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        contractor_id UUID NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
        access_token TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMP NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_by TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS staff_users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        full_name TEXT,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'staff',
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      ALTER TABLE contractors
        ADD COLUMN IF NOT EXISTS staff_user_id UUID REFERENCES staff_users(id) ON DELETE SET NULL;
      
    `);

    res.json({ message: 'Database setup v2 complete (clean)' });
  } catch (error) {
    console.error('Setup v2 error:', error);
    res.status(500).json({ error: error.message });
  }
});

/*
  STAFF AUTH
*/

// Create staff user
app.post('/api/staff/register', requireStaffAuth, requireAdmin, async (req, res) => {
  try {
    const { full_name, email, password, role, is_active } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

const allowedRoles = ['admin', 'manager', 'staff'];
const safeRole = allowedRoles.includes(role) ? role : 'staff';

const result = await pool.query(
  `
  INSERT INTO staff_users (full_name, email, password_hash, role, is_active)
  VALUES ($1, $2, $3, $4, $5)
  RETURNING id, full_name, email, role, is_active, created_at
  `,
  [
    full_name || null,
    email.toLowerCase(),
    hashedPassword,
    safeRole,
    is_active === false ? false : true
  ]
);

    res.status(201).json({
      message: 'Staff user created',
      user: result.rows[0]
    });
   
  } catch (err) {
    console.error('Staff register error:', err);

    if (err.code === '23505') {
      return res.status(400).json({ error: 'Email already exists' });
    }

    res.status(500).json({ error: err.message });
  }
});

app.get('/api/staff', requireStaffAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT id, full_name, email, role, is_active, created_at
      FROM staff_users
      ORDER BY created_at DESC
      `
    );

    res.json(result.rows);
  } catch (err) {
    console.error('List staff users error:', err);
    res.status(500).json({ error: err.message });
  }
});
app.patch('/api/staff/:id/toggle-active', requireStaffAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    if (typeof is_active !== 'boolean') {
      return res.status(400).json({ error: 'is_active must be true or false' });
    }

    const result = await pool.query(
      `
      UPDATE staff_users
      SET is_active = $1,
          updated_at = NOW()
      WHERE id = $2
      RETURNING id, full_name, email, role, is_active
      `,
      [is_active, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Staff user not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Toggle staff active error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/staff/:id', requireStaffAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      full_name,
      email,
      role,
      phone
    } = req.body;

    const allowedRoles = ['admin', 'manager', 'staff'];

    if (role && !allowedRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const result = await pool.query(
      `
      UPDATE staff_users
      SET
        full_name = COALESCE($1, full_name),
        email = COALESCE($2, email),
        role = COALESCE($3, role),
        phone = COALESCE($4, phone),
        updated_at = NOW()
      WHERE id = $5
      RETURNING id, full_name, email, role, phone, is_active, created_at, updated_at
      `,
      [
        full_name ?? null,
        email ? String(email).toLowerCase() : null,
        role ?? null,
        phone ?? null,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Staff user not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update staff user error:', err);

    if (err.code === '23505') {
      return res.status(400).json({ error: 'Email already exists' });
    }

    if (err.code === '42703') {
      return res.status(500).json({ error: 'phone column missing on staff_users table' });
    }

    res.status(500).json({ error: err.message });
  }
});

// Staff login
app.post('/api/staff/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const result = await pool.query(
      `
      SELECT *
      FROM staff_users
      WHERE email = $1
        AND is_active = true
      `,
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Staff login error:', err);
    res.status(500).json({ error: err.message });
  }
});

/*
  CONTRACTORS
*/
app.post('/api/contractors', requireStaffAuth, async (req, res) => {
  const {
  contractor_name,
  business_name,
  email,
  phone,
  status,
  staff_user_id
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
        status,
        staff_user_id
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [
        contractor_name,
        business_name || null,
        email || null,
        phone || null,
        status || 'active',
        staff_user_id || req.staffUser.id
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create contractor error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/contractors', requireStaffAuth, async (req, res) => {
  try {
  let result;

  if (req.staffUser.role === 'admin') {
    result = await pool.query(`
      SELECT *
      FROM contractors
      ORDER BY created_at DESC
    `);
  } else {
    result = await pool.query(
      `
      SELECT *
      FROM contractors
      WHERE staff_user_id = $1
      ORDER BY created_at DESC
      `,
      [req.staffUser.id]
    );
  }

  res.json(result.rows);
} catch (error) {
  console.error('List contractors error:', error);
  res.status(500).json({ error: error.message });
}
});
                      
app.get('/api/contractors/:id', requireStaffAuth, async (req, res) => {
  try {
    let result;

    if (req.staffUser.role === 'admin') {
      result = await pool.query(
        `SELECT * FROM contractors WHERE id = $1`,
        [req.params.id]
      );
    } else {
      result = await pool.query(
        `
        SELECT *
        FROM contractors
        WHERE id = $1
          AND staff_user_id = $2
        `,
        [req.params.id, req.staffUser.id]
      );
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Contractor not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get contractor error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/contractors/:id/access-link', requireStaffAuth, async (req, res) => {
  try {
    const contractorId = req.params.id;
    const { created_by } = req.body || {};

    let contractorResult;

if (req.staffUser.role === 'admin') {
  contractorResult = await pool.query(
    `SELECT * FROM contractors WHERE id = $1`,
    [contractorId]
  );
} else {
  contractorResult = await pool.query(
    `
    SELECT *
    FROM contractors
    WHERE id = $1
      AND staff_user_id = $2
    `,
    [contractorId, req.staffUser.id]
  );
}

if (contractorResult.rows.length === 0) {
  return res.status(404).json({ error: 'Contractor not found' });
}

    const accessToken = generateAccessToken();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7);

    await pool.query(
      `
      INSERT INTO contractor_access_tokens (
        contractor_id,
        access_token,
        expires_at,
        created_by
      )
      VALUES ($1, $2, $3, $4)
      `,
      [
        contractorId,
        accessToken,
        expiresAt,
        created_by || 'Staff'
      ]
    );

    res.json({
      contractor_id: contractorId,
      access_token: accessToken,
      expires_at: expiresAt,
      portal_url: `https://7z4xyn5z2n-art.github.io/1099-document-portal/frontend/contractor.html?token=${accessToken}`
    });
  } catch (error) {
    console.error('Create contractor access link error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/contractors/:id/assign', requireStaffAuth, requireAdmin, async (req, res) => {
  try {
    const { staff_user_id } = req.body;

    if (!staff_user_id) {
      return res.status(400).json({ error: 'staff_user_id is required' });
    }

    const staffResult = await pool.query(
      `
      SELECT id, full_name, email, role, is_active
      FROM staff_users
      WHERE id = $1
        AND is_active = true
      `,
      [staff_user_id]
    );

    if (staffResult.rows.length === 0) {
      return res.status(404).json({ error: 'Assigned staff user not found' });
    }

    const result = await pool.query(
      `
      UPDATE contractors
      SET staff_user_id = $1,
          updated_at = NOW()
      WHERE id = $2
      RETURNING *
      `,
      [staff_user_id, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Contractor not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Assign contractor error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/contractors/:id', requireStaffAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `
      DELETE FROM contractors
      WHERE id = $1
      RETURNING id
      `,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Contractor not found' });
    }

    res.json({ message: 'Contractor deleted' });
  } catch (error) {
    console.error('Delete contractor error:', error);
    res.status(500).json({ error: error.message });
  }
});

 app.get('/api/contractor-portal/session', async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const tokenResult = await pool.query(
      `
      SELECT *
      FROM contractor_access_tokens
      WHERE access_token = $1
        AND is_active = true
        AND expires_at > NOW()
      `,
      [token]
    );

    if (tokenResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const tokenRow = tokenResult.rows[0];

    const contractorResult = await pool.query(
      `SELECT * FROM contractors WHERE id = $1`,
      [tokenRow.contractor_id]
    );

    if (contractorResult.rows.length === 0) {
      return res.status(404).json({ error: 'Contractor not found' });
    }

    const contractor = contractorResult.rows[0];

    res.json({
      contractor_id: contractor.id,
      contractor_name: contractor.contractor_name,
      business_name: contractor.business_name,
      email: contractor.email,
      phone: contractor.phone,
      status: contractor.status
    });

  } catch (error) {
    console.error('Contractor session error:', error);
    res.status(500).json({ error: error.message });
  }
});
/*
  FINANCIAL ENTRIES
*/
app.post('/api/entries', requireStaffAuth, async (req, res) => {
  const {
    contractor_id,
    document_id,
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
        document_id,
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
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
      `,
      [
        contractor_id,
        document_id || null,
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

app.get('/api/entries/:contractorId/:year/:month', requireStaffAuth, async (req, res) => {
  const { contractorId, year, month } = req.params;

  try {
    const result = await pool.query(
  `
  SELECT
    financial_entries.*,
    documents.file_name AS document_file_name,
    documents.document_type AS document_type_from_doc,
    documents.period_month AS document_period_month,
    documents.period_year AS document_period_year
  FROM financial_entries
  LEFT JOIN documents
    ON financial_entries.document_id = documents.id
  WHERE financial_entries.contractor_id = $1
    AND financial_entries.year = $2
    AND financial_entries.month = $3
  ORDER BY financial_entries.entry_date DESC, financial_entries.created_at DESC
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

app.post('/api/documents/:documentId/create-entry', requireStaffAuth, async (req, res) => {
  try {
    const { documentId } = req.params;
    const {
      entry_type,
      entry_date,
      amount,
      category,
      description,
      vendor_or_payor
    } = req.body;

    if (!entry_type || !entry_date || amount == null) {
      return res.status(400).json({
        error: 'entry_type, entry_date, and amount are required'
      });
    }

    let docResult;

if (req.staffUser.role === 'admin') {
  docResult = await pool.query(
    `
    SELECT d.*
    FROM documents d
    WHERE d.id = $1
    `,
    [documentId]
  );
} else {
  docResult = await pool.query(
    `
    SELECT d.*
    FROM documents d
    JOIN contractors c ON c.id = d.contractor_id
    WHERE d.id = $1
      AND c.staff_user_id = $2
    `,
    [documentId, req.staffUser.id]
  );
}

    if (docResult.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const doc = docResult.rows[0];

    const month = doc.period_month || new Date(entry_date).getMonth() + 1;
    const year = doc.period_year || new Date(entry_date).getFullYear();

    const result = await pool.query(
      `
      INSERT INTO financial_entries (
        contractor_id,
        document_id,
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
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
      `,
      [
        doc.contractor_id,
        doc.id,
        entry_type,
        'document',
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
    console.error('Create entry from document error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/documents/:documentId/analyze', requireStaffAuth, async (req, res) => {
  
  const { documentId } = req.params;

  try {
    let docResult;

    if (req.staffUser.role === 'admin') {
      docResult = await pool.query(
        `
        SELECT d.*
        FROM documents d
        WHERE d.id = $1
        `,
        [documentId]
      );
    } else {
      docResult = await pool.query(
        `
        SELECT d.*
        FROM documents d
        JOIN contractors c ON c.id = d.contractor_id
        WHERE d.id = $1
          AND c.staff_user_id = $2
        `,
        [documentId, req.staffUser.id]
      );
    }

    if (docResult.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const doc = docResult.rows[0];

    if (!doc.storage_reference) {
      return res.status(400).json({ error: 'Document has no storage reference' });
    }

    const { data: downloadData, error: downloadError } = await supabase.storage
      .from('contractor-docs')
      .download(doc.storage_reference);

    if (downloadError) {
      console.error('Supabase download error:', downloadError);
      return res.status(500).json({ error: downloadError.message });
    }

    const arrayBuffer = await downloadData.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuffer);

    let mimeType = 'application/pdf';
    const fileName = String(doc.file_name || '').toLowerCase();

    if (fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) {
      mimeType = 'image/jpeg';
    } else if (fileName.endsWith('.png')) {
      mimeType = 'image/png';
    } else if (fileName.endsWith('.webp')) {
      mimeType = 'image/webp';
    } else if (fileName.endsWith('.pdf')) {
      mimeType = 'application/pdf';
    }

    const analysis = await analyzeDocumentWithGoogle(doc, fileBuffer, mimeType);

    await pool.query(
      `
      UPDATE documents
      SET category = COALESCE($1, category)
      WHERE id = $2
      `,
      [
        analysis.category || 'Uncategorized',
        doc.id
      ]
    );

    const refreshedDocResult = await pool.query(
      `
      SELECT *
      FROM documents
      WHERE id = $1
      `,
      [doc.id]
    );

    const refreshedDoc = refreshedDocResult.rows[0] || doc;

    res.json({
      document_id: refreshedDoc.id,
      contractor_id: refreshedDoc.contractor_id,
      file_name: refreshedDoc.file_name,
      document_type: refreshedDoc.document_type || 'other',
      category: refreshedDoc.category || analysis.category || 'Uncategorized',
      suggested: {
        entry_type: doc.document_type === 'invoice' ? 'income' : 'expense',
        amount: analysis.amount || '0.00',
        entry_date: analysis.entry_date || new Date().toISOString().slice(0, 10),
        category: analysis.category || 'Uncategorized',
        description: analysis.description || 'Draft created from document analysis',
        vendor_or_payor: analysis.vendor_or_payor || '',
        confidence: analysis.confidence || 'low'
      }
    });
  } catch (err) {
    console.error('Analyze document error:', err);
    res.status(500).json({ error: err.message || 'Failed to analyze document' });
  }
});

app.post('/api/documents/analyze-batch/:contractorId', requireStaffAuth, async (req, res) => {
  const { contractorId } = req.params;

  try {
    let contractorResult;

    if (req.staffUser.role === 'admin') {
      contractorResult = await pool.query(
        `SELECT id FROM contractors WHERE id = $1`,
        [contractorId]
      );
    } else {
      contractorResult = await pool.query(
        `
        SELECT id
        FROM contractors
        WHERE id = $1
          AND staff_user_id = $2
        `,
        [contractorId, req.staffUser.id]
      );
    }

    if (contractorResult.rows.length === 0) {
      return res.status(404).json({ error: 'Contractor not found' });
    }

    const docsResult = await pool.query(
      `
      SELECT *
      FROM documents
      WHERE contractor_id = $1
      ORDER BY created_at DESC
      `,
      [contractorId]
    );

    const documents = docsResult.rows;

    const results = [];

   for (const doc of documents) {
  try {
    if (!doc.storage_reference) {
      results.push({
        document_id: doc.id,
        file_name: doc.file_name,
        document_type: doc.document_type || 'other',
        status: 'error',
        error: 'Document has no storage reference'
      });
      continue;
    }

    const { data: downloadData, error: downloadError } = await supabase.storage
      .from('contractor-docs')
      .download(doc.storage_reference);

    if (downloadError) {
      console.error('Download error:', downloadError);

      results.push({
        document_id: doc.id,
        file_name: doc.file_name,
        document_type: doc.document_type || 'other',
        status: 'error',
        error: downloadError.message || 'Download failed'
      });
      continue;
    }

    const arrayBuffer = await downloadData.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuffer);

    let mimeType = 'application/pdf';
    const fileName = String(doc.file_name || '').toLowerCase();

    if (fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) {
      mimeType = 'image/jpeg';
    } else if (fileName.endsWith('.png')) {
      mimeType = 'image/png';
    } else if (fileName.endsWith('.webp')) {
      mimeType = 'image/webp';
    }

    const analysis = await analyzeDocumentWithGoogle(doc, fileBuffer, mimeType);

    await pool.query(
      `
      UPDATE documents
      SET
        category = COALESCE($1, category)
      WHERE id = $2
      `,
      [
        analysis.category || 'Uncategorized',
        doc.id
      ]
    );

    const refreshedDocResult = await pool.query(
      `
      SELECT *
      FROM documents
      WHERE id = $1
      `,
      [doc.id]
    );

    const refreshedDoc = refreshedDocResult.rows[0] || doc;

    results.push({
      document_id: refreshedDoc.id,
      file_name: refreshedDoc.file_name,
      document_type: refreshedDoc.document_type || 'other',
      category: refreshedDoc.category || analysis.category || 'Uncategorized',
      status: 'success',
      suggested: {
        entry_type: refreshedDoc.document_type === 'invoice' ? 'income' : 'expense',
        amount: analysis.amount || '0.00',
        entry_date: analysis.entry_date || new Date().toISOString().slice(0, 10),
        category: analysis.category || 'Uncategorized',
        description: analysis.description || 'Draft created from document analysis',
        vendor_or_payor: analysis.vendor_or_payor || '',
        confidence: analysis.confidence || 'low'
      }
    });

  } catch (err) {
    console.error('Batch analyze error:', err);

    results.push({
      document_id: doc.id,
      file_name: doc.file_name,
      document_type: doc.document_type || 'other',
      status: 'error',
      error: err.message || 'Batch analysis failed'
    });
  }
}

const successCount = results.filter(r => r.status === 'success').length;
const errorCount = results.filter(r => r.status === 'error').length;

res.json({
  total: results.length,
  success_count: successCount,
  error_count: errorCount,
  results
});

  } catch (err) {
    console.error('Batch route error:', err);
    res.status(500).json({ error: err.message });
  }
});

/*
  ADMIN REVIEW / CORRECTION
*/
app.patch('/api/entries/:id/review', requireStaffAuth, async (req, res) => {
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

/*
  DOCUMENT UPLOAD (REAL FILE STORAGE)
*/
app.post('/api/documents', requireStaffAuth, upload.single('file'), async (req, res) => {
  try {
    const {
      contractor_id,
      document_type,
      category,
      period_month,
      period_year,
      notes
    } = req.body;

     const file = req.file;
    
    if (!contractor_id || !file) {
      return res.status(400).json({ error: 'contractor_id and file required' });
    }
    
let contractorResult;

if (req.staffUser.role === 'admin') {
  contractorResult = await pool.query(
    `SELECT id FROM contractors WHERE id = $1`,
    [contractor_id]
  );
} else {
  contractorResult = await pool.query(
    `
    SELECT id
    FROM contractors
    WHERE id = $1
      AND staff_user_id = $2
    `,
    [contractor_id, req.staffUser.id]
  );
}

if (contractorResult.rows.length === 0) {
  return res.status(404).json({ error: 'Contractor not found or access denied' });
}

      const now = new Date();
      const effectiveYear = period_year || now.getFullYear();
      const effectiveMonth = period_month || (now.getMonth() + 1);

      const year = String(effectiveYear);
      const month = String(effectiveMonth).padStart(2, '0');
      const safeDocType = (document_type || 'other').toLowerCase().replace(/[^a-z0-9_-]/g, '-');

    const filePath = `${contractor_id}/${year}/${month}/${safeDocType}/${Date.now()}-${file.originalname}`;

    const { error: uploadError } = await supabase.storage
      .from('contractor-docs')
      .upload(filePath, file.buffer, {
        contentType: file.mimetype
      });

    if (uploadError) {
      console.error('Supabase upload error:', uploadError);
      return res.status(500).json({ error: uploadError.message });
    }

    const result = await pool.query(
  `
  INSERT INTO documents (
    contractor_id,
    document_type,
    category,
    file_name,
    storage_reference,
    period_month,
    period_year,
    notes
  )
VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
  RETURNING *
  `,
  [
    contractor_id,
    document_type || 'general',
    category || 'Uncategorized',
    file.originalname,
    filePath,
    effectiveMonth,
    effectiveYear,
    notes || null
  ]
);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

/*
  GET DOCUMENTS FOR CONTRACTOR
*/
app.get('/api/documents/:contractorId', requireStaffAuth, async (req, res) => {
  try {
    let contractorResult;

    if (req.staffUser.role === 'admin') {
      contractorResult = await pool.query(
        `SELECT id FROM contractors WHERE id = $1`,
        [req.params.contractorId]
      );
    } else {
      contractorResult = await pool.query(
        `
        SELECT id
        FROM contractors
        WHERE id = $1
          AND staff_user_id = $2
        `,
        [req.params.contractorId, req.staffUser.id]
      );
    }

    if (contractorResult.rows.length === 0) {
      return res.status(404).json({ error: 'Contractor not found' });
    }

    const result = await pool.query(
      `
      SELECT *
      FROM documents
      WHERE contractor_id = $1
      ORDER BY created_at DESC
      `,
      [req.params.contractorId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Load documents error:', err);
    res.status(500).json({ error: err.message });
  }
});
app.get('/api/contractor-portal/documents', async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({ error: 'token is required' });
    }

    const tokenResult = await pool.query(
      `
      SELECT contractor_id
      FROM contractor_access_tokens
      WHERE access_token = $1
        AND is_active = true
        AND expires_at > NOW()
      `,
      [token]
    );

    if (tokenResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const contractorId = tokenResult.rows[0].contractor_id;

    const result = await pool.query(
      `
      SELECT *
      FROM documents
      WHERE contractor_id = $1
      ORDER BY created_at DESC
      `,
      [contractorId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Contractor portal documents error:', error);
    res.status(500).json({ error: error.message });
  }
});

/*
  UPDATE DOCUMENT REVIEW STATUS
*/
app.patch('/api/documents/:documentId/review-status', requireStaffAuth, async (req, res) => {
  try {
    const { review_status, reviewed_by } = req.body;

    if (!review_status) {
      return res.status(400).json({ error: 'review_status is required' });
    }

    const allowed = ['new', 'in_review', 'reviewed'];
    if (!allowed.includes(review_status)) {
      return res.status(400).json({ error: 'Invalid review_status' });
    }

    let docResult;

    if (req.staffUser.role === 'admin') {
      docResult = await pool.query(
        `
        SELECT d.*
        FROM documents d
        WHERE d.id = $1
        `,
        [req.params.documentId]
      );
    } else {
      docResult = await pool.query(
        `
        SELECT d.*
        FROM documents d
        JOIN contractors c ON c.id = d.contractor_id
        WHERE d.id = $1
          AND c.staff_user_id = $2
        `,
        [req.params.documentId, req.staffUser.id]
      );
    }

    if (docResult.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const result = await pool.query(
      `
      UPDATE documents
      SET
        review_status = $1,
        reviewed_by = $2,
        reviewed_at = CASE
          WHEN $1 = 'reviewed' THEN NOW()
          ELSE reviewed_at
        END
      WHERE id = $3
      RETURNING *
      `,
      [
        review_status,
        reviewed_by || 'Staff',
        req.params.documentId
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update review status error:', err);
    res.status(500).json({ error: err.message });
  }
});
app.patch('/api/documents/:documentId', requireStaffAuth, async (req, res) => {
  try {
    const { document_type, category, period_month, period_year, notes } = req.body;

    let docResult;

    if (req.staffUser.role === 'admin') {
      docResult = await pool.query(
        `
        SELECT d.*
        FROM documents d
        WHERE d.id = $1
        `,
        [req.params.documentId]
      );
    } else {
      docResult = await pool.query(
        `
        SELECT d.*
        FROM documents d
        JOIN contractors c ON c.id = d.contractor_id
        WHERE d.id = $1
          AND c.staff_user_id = $2
        `,
        [req.params.documentId, req.staffUser.id]
      );
    }

    if (docResult.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const result = await pool.query(
      `
      UPDATE documents
      SET
        document_type = COALESCE($1, document_type),
        category = COALESCE($2, category),
        period_month = COALESCE($3, period_month),
        period_year = COALESCE($4, period_year),
        notes = COALESCE($5, notes)
      WHERE id = $6
      RETURNING *
      `,
      [
        document_type ?? null,
        category ?? null,
        period_month ?? null,
        period_year ?? null,
        notes ?? null,
        req.params.documentId
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update document metadata error:', err);
    res.status(500).json({ error: err.message });
  }
});

/*
  GET TEMP VIEW URL FOR DOCUMENT
*/
app.get('/api/documents/file/:documentId', requireStaffAuth, async (req, res) => {
  try {
    let result;

    if (req.staffUser.role === 'admin') {
      result = await pool.query(
        `
        SELECT d.*
        FROM documents d
        WHERE d.id = $1
        `,
        [req.params.documentId]
      );
    } else {
      result = await pool.query(
        `
        SELECT d.*
        FROM documents d
        JOIN contractors c ON c.id = d.contractor_id
        WHERE d.id = $1
          AND c.staff_user_id = $2
        `,
        [req.params.documentId, req.staffUser.id]
      );
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const doc = result.rows[0];

    const { data, error } = await supabase.storage
      .from('contractor-docs')
      .createSignedUrl(doc.storage_reference, 60 * 10);

    if (error) {
      console.error('Signed URL error:', error);
      return res.status(500).json({ error: error.message });
    }

    res.json({
      url: data.signedUrl,
      file_name: doc.file_name,
      document_type: doc.document_type
    });
  } catch (err) {
    console.error('Get file URL error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/documents/:documentId', requireStaffAuth, async (req, res) => {
  try {
    const { documentId } = req.params;

    let docResult;

    if (req.staffUser.role === 'admin') {
      docResult = await pool.query(
        `
        SELECT d.*
        FROM documents d
        WHERE d.id = $1
        `,
        [documentId]
      );
    } else {
      docResult = await pool.query(
        `
        SELECT d.*
        FROM documents d
        JOIN contractors c ON c.id = d.contractor_id
        WHERE d.id = $1
          AND c.staff_user_id = $2
        `,
        [documentId, req.staffUser.id]
      );
    }

    if (docResult.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const doc = docResult.rows[0];

    if (doc.storage_reference) {
      const { error: storageError } = await supabase.storage
        .from('contractor-docs')
        .remove([doc.storage_reference]);

      if (storageError) {
        console.error('Supabase delete error:', storageError);
        return res.status(500).json({ error: storageError.message });
      }
    }

    await pool.query(
      `
      DELETE FROM documents
      WHERE id = $1
      `,
      [documentId]
    );

    res.json({ success: true, deleted_document_id: documentId });
  } catch (err) {
    console.error('Delete document error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/contractor-portal/file/:documentId', async (req, res) => {
  try {
    const { token } = req.query;
    const { documentId } = req.params;

    if (!token) {
      return res.status(400).json({ error: 'token is required' });
    }

    const tokenResult = await pool.query(
      `
      SELECT contractor_id
      FROM contractor_access_tokens
      WHERE access_token = $1
        AND is_active = true
        AND expires_at > NOW()
      `,
      [token]
    );

    if (tokenResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const contractorId = tokenResult.rows[0].contractor_id;

    const docResult = await pool.query(
      `
      SELECT *
      FROM documents
      WHERE id = $1
        AND contractor_id = $2
      `,
      [documentId, contractorId]
    );

    if (docResult.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const doc = docResult.rows[0];

    const { data, error } = await supabase.storage
      .from('contractor-docs')
      .createSignedUrl(doc.storage_reference, 60 * 10);

        if (error) {
          console.error('Contractor signed URL error:', error);
          return res.status(500).json({ error: error.message });
        }

    res.json({
      url: data.signedUrl,
      file_name: doc.file_name,
      document_type: doc.document_type
    });
  } catch (err) {
    console.error('Contractor file access error:', err);
    res.status(500).json({ error: err.message });
  }
});

  app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
