const PARSE_STATUSES = new Set([
  'not_parsed',
  'processing',
  'processed',
  'needs_review',
  'could_not_parse',
  'failed',
]);

const CLASSIFICATIONS = new Set(['revenue', 'expense', 'miscellaneous', 'unknown']);

const WRITABLE_COLUMNS = new Map([
  ['parseStatus', 'parse_status'],
  ['parseError', 'parse_error'],
  ['extractedAmount', 'extracted_amount'],
  ['extractedVendorOrPayor', 'extracted_vendor_or_payor'],
  ['extractedTransactionDate', 'extracted_transaction_date'],
  ['extractedDescription', 'extracted_description'],
  ['userSelectedDocumentType', 'user_selected_document_type'],
  ['detectedDocumentType', 'detected_document_type'],
  ['documentTypeConfidence', 'document_type_confidence'],
  ['documentTypeMismatch', 'document_type_mismatch'],
  ['suggestedEntryType', 'suggested_entry_type'],
  ['broadClassification', 'broad_classification'],
  ['suggestedDetailedCategory', 'suggested_detailed_category'],
  ['classificationConfidence', 'classification_confidence'],
  ['reviewReasons', 'review_reasons'],
  ['extractedStructuredJson', 'extracted_structured_json'],
  ['processorName', 'processor_name'],
  ['lastParsedAt', 'last_parsed_at'],
]);

function validate(values) {
  if (values.parseStatus !== undefined && !PARSE_STATUSES.has(values.parseStatus)) {
    throw new TypeError(`Invalid parse status: ${values.parseStatus}`);
  }
  if (values.broadClassification !== undefined && !CLASSIFICATIONS.has(values.broadClassification)) {
    throw new TypeError(`Invalid broad classification: ${values.broadClassification}`);
  }
  for (const key of ['documentTypeConfidence', 'classificationConfidence']) {
    if (values[key] !== undefined && values[key] !== null &&
        (typeof values[key] !== 'number' || values[key] < 0 || values[key] > 1)) {
      throw new TypeError(`${key} must be between 0 and 1`);
    }
  }
  if (values.reviewReasons !== undefined && !Array.isArray(values.reviewReasons)) {
    throw new TypeError('reviewReasons must be an array');
  }
  if (values.extractedStructuredJson !== undefined &&
      (values.extractedStructuredJson === null || Array.isArray(values.extractedStructuredJson) ||
       typeof values.extractedStructuredJson !== 'object')) {
    throw new TypeError('extractedStructuredJson must be an object');
  }
}

function fieldsFor(values) {
  return [...WRITABLE_COLUMNS]
    .filter(([key]) => values[key] !== undefined)
    .map(([key, column]) => ({ column, value: values[key] }));
}

async function createDocumentAnalysis(db, { documentId, ...values }) {
  if (!documentId) throw new TypeError('documentId is required');
  validate(values);
  const client = typeof db.connect === 'function' ? await db.connect() : db;

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [documentId]);
    const fields = fieldsFor(values);
    const columns = ['document_id', ...fields.map(({ column }) => column)];
    const parameters = [documentId, ...fields.map(({ value }) => value)];
    const placeholders = parameters.map((_, index) => `$${index + 1}`);
    const result = await client.query(
      `INSERT INTO document_analysis (${columns.join(', ')}, attempt_number)
       SELECT ${placeholders.join(', ')}, COALESCE(MAX(attempt_number), 0) + 1
       FROM document_analysis WHERE document_id = $1
       RETURNING *`,
      parameters
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    if (typeof client.release === 'function') client.release();
  }
}

async function updateDocumentAnalysis(db, analysisId, values) {
  if (!analysisId) throw new TypeError('analysisId is required');
  validate(values);
  const fields = fieldsFor(values);
  if (fields.length === 0) throw new TypeError('At least one analysis field is required');
  const assignments = fields.map(({ column }, index) => `${column} = $${index + 2}`);
  const result = await db.query(
    `UPDATE document_analysis SET ${assignments.join(', ')} WHERE id = $1 RETURNING *`,
    [analysisId, ...fields.map(({ value }) => value)]
  );
  return result.rows[0] || null;
}

module.exports = { createDocumentAnalysis, updateDocumentAnalysis, PARSE_STATUSES };
