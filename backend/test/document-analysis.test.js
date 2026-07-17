const assert = require('node:assert/strict');
const test = require('node:test');

const migration = require('../migrations/003-create-document-analysis');
const { createDocumentAnalysis, updateDocumentAnalysis } = require('../document-analysis');

function fakeDatabase(attempts = []) {
  const queries = [];
  return {
    queries,
    async query(text, parameters = []) {
      queries.push({ text, parameters });
      if (text.includes('INSERT INTO document_analysis')) {
        const row = { id: `analysis-${attempts.length + 1}`, document_id: parameters[0], attempt_number: attempts.length + 1 };
        attempts.push(row);
        return { rows: [row] };
      }
      if (text.includes('UPDATE document_analysis')) return { rows: [{ id: parameters[0] }] };
      return { rows: [] };
    },
  };
}

test('creates an analysis record without creating a financial entry', async () => {
  const db = fakeDatabase();
  const analysis = await createDocumentAnalysis(db, {
    documentId: 'document-1',
    parseStatus: 'not_parsed',
    extractedStructuredJson: { source: 'test fixture' },
  });

  assert.equal(analysis.document_id, 'document-1');
  assert.equal(analysis.attempt_number, 1);
  assert.ok(db.queries.some(({ text }) => text.includes('INSERT INTO document_analysis')));
  assert.ok(db.queries.every(({ text }) => !text.includes('financial_entries')));
});

test('preserves multiple attempts for one document', async () => {
  const attempts = [];
  const db = fakeDatabase(attempts);
  const first = await createDocumentAnalysis(db, { documentId: 'document-1' });
  const second = await createDocumentAnalysis(db, { documentId: 'document-1' });

  assert.deepEqual(attempts.map(({ attempt_number }) => attempt_number), [1, 2]);
  assert.notEqual(first.id, second.id);
});

test('rejects invalid statuses before querying the database', async () => {
  const db = fakeDatabase();
  await assert.rejects(
    createDocumentAnalysis(db, { documentId: 'document-1', parseStatus: 'complete' }),
    /Invalid parse status/
  );
  await assert.rejects(updateDocumentAnalysis(db, 'analysis-1', { parseStatus: 'queued' }), /Invalid parse status/);
  assert.equal(db.queries.length, 0);
});

test('migration cascades analysis deletion with its document', () => {
  assert.match(migration.UP_SQL, /document_id UUID NOT NULL REFERENCES documents\(id\) ON DELETE CASCADE/);
  assert.match(migration.UP_SQL, /UNIQUE \(document_id, attempt_number\)/);
});

test('database status constraint contains exactly the supported statuses', () => {
  for (const status of ['not_parsed', 'processing', 'processed', 'needs_review', 'could_not_parse', 'failed']) {
    assert.match(migration.UP_SQL, new RegExp(`'${status}'`));
  }
});
