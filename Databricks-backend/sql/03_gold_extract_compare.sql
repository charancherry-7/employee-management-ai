-- ============================================================
-- GOLD LAYER
-- ai_extract() pulls structured fields per document (schema chosen
-- by detected_type). The backend then computes a deterministic
-- field-level diff between two same-typed documents, and asks
-- ai_query() for a plain-English narrative. Both are stored here --
-- this table is what the Genie Space and the frontend read from.
-- ============================================================

USE CATALOG employee_mgmt;
USE SCHEMA doc_intelligence;

CREATE TABLE IF NOT EXISTS gold_document_extractions (
  document_id       STRING      NOT NULL,
  file_name         STRING      NOT NULL,
  detected_type     STRING      NOT NULL,
  extracted_fields  VARIANT,             -- output of ai_extract
  upload_ts         TIMESTAMP
)
USING DELTA
COMMENT 'Gold: structured fields extracted per document';

CREATE TABLE IF NOT EXISTS gold_document_comparisons (
  comparison_id   STRING      NOT NULL,
  document_id_a   STRING      NOT NULL,
  document_id_b   STRING      NOT NULL,
  doc_type        STRING      NOT NULL,
  file_name_a     STRING,
  file_name_b     STRING,
  diff            VARIANT,              -- structured field-by-field diff (from backend)
  summary         STRING,               -- ai_query() narrative, in plain English
  created_ts      TIMESTAMP,
  created_by      STRING
)
USING DELTA
COMMENT 'Gold: comparison results. Genie Space and Ask Genie AI query this table.';

-- ------------------------------------------------------------
-- Step 1 -- extract structured fields for ONE document.
-- Called once per document, right after Silver classification.
-- :extraction_schema is the JSON schema string chosen in the
-- backend based on detected_type (see backend/schemas.py).
-- ------------------------------------------------------------
INSERT INTO gold_document_extractions
SELECT
  document_id,
  file_name,
  detected_type,
  ai_extract(
    parsed_content,
    :extraction_schema,
    MAP('version', '2.1', 'instructions', 'This is an HR/employment document.')
  ) AS extracted_fields,
  current_timestamp() AS upload_ts
FROM silver_parsed_documents
WHERE document_id = :document_id;

-- ------------------------------------------------------------
-- Step 2 -- persist the comparison. The field-level diff (:diff_json)
-- is computed in Python from the two VARIANT extractions above --
-- that part is deterministic and doesn't need an LLM. ai_query()
-- is used for the one part that benefits from generation: turning
-- the diff into a short natural-language summary for Genie AI and
-- for the frontend's "Summarize the differences" answer.
-- ------------------------------------------------------------
INSERT INTO gold_document_comparisons
SELECT
  :comparison_id,
  :document_id_a,
  :document_id_b,
  :doc_type,
  :file_name_a,
  :file_name_b,
  parse_json(:diff_json) AS diff,
  ai_query(
    'databricks-meta-llama-3-3-70b-instruct',
    concat(
      'You are summarizing a comparison between two ', :doc_type, ' documents for an HR user. ',
      'Here is the field-level diff as JSON (kind is modified/added/removed): ', :diff_json,
      ' Write 2-3 plain-English sentences summarizing what changed and why it matters.'
    )
  ) AS summary,
  current_timestamp(),
  :created_by;
