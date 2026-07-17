const UP_SQL = `
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE document_analysis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  parse_status TEXT NOT NULL DEFAULT 'not_parsed',
  parse_error TEXT,
  extracted_amount NUMERIC(14, 2),
  extracted_vendor_or_payor TEXT,
  extracted_transaction_date DATE,
  extracted_description TEXT,
  user_selected_document_type TEXT,
  detected_document_type TEXT,
  document_type_confidence NUMERIC(5, 4),
  document_type_mismatch BOOLEAN NOT NULL DEFAULT FALSE,
  suggested_entry_type TEXT,
  broad_classification TEXT NOT NULL DEFAULT 'unknown',
  suggested_detailed_category TEXT,
  classification_confidence NUMERIC(5, 4),
  review_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  extracted_structured_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  processor_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_parsed_at TIMESTAMPTZ,
  CONSTRAINT document_analysis_attempt_positive CHECK (attempt_number > 0),
  CONSTRAINT document_analysis_status_valid CHECK (
    parse_status IN ('not_parsed', 'processing', 'processed', 'needs_review', 'could_not_parse', 'failed')
  ),
  CONSTRAINT document_analysis_classification_valid CHECK (
    broad_classification IN ('revenue', 'expense', 'miscellaneous', 'unknown')
  ),
  CONSTRAINT document_analysis_document_confidence_valid CHECK (
    document_type_confidence IS NULL OR document_type_confidence BETWEEN 0 AND 1
  ),
  CONSTRAINT document_analysis_classification_confidence_valid CHECK (
    classification_confidence IS NULL OR classification_confidence BETWEEN 0 AND 1
  ),
  CONSTRAINT document_analysis_review_reasons_array CHECK (jsonb_typeof(review_reasons) = 'array'),
  CONSTRAINT document_analysis_structured_json_object CHECK (jsonb_typeof(extracted_structured_json) = 'object'),
  CONSTRAINT document_analysis_document_attempt_unique UNIQUE (document_id, attempt_number)
);

CREATE INDEX document_analysis_document_created_idx
  ON document_analysis (document_id, created_at DESC);
CREATE INDEX document_analysis_status_idx
  ON document_analysis (parse_status);
`;

exports.up = (pgm) => pgm.sql(UP_SQL);

exports.down = (pgm) => {
  pgm.sql('DROP TABLE document_analysis;');
};

exports.UP_SQL = UP_SQL;
