-- ============================================================
-- SILVER LAYER
-- ai_parse_document() turns the raw PDF/DOCX bytes into structured
-- text + layout. ai_classify() then decides what kind of document
-- it is -- the user never picks a document type, this is that step.
-- ============================================================

USE CATALOG employee_mgmt;
USE SCHEMA doc_intelligence;

CREATE TABLE IF NOT EXISTS silver_parsed_documents (
  document_id     STRING      NOT NULL,
  file_path       STRING      NOT NULL,
  file_name       STRING      NOT NULL,
  parsed_content  VARIANT,               -- output of ai_parse_document
  detected_type   STRING,                -- output of ai_classify
  uploaded_by     STRING,
  upload_ts       TIMESTAMP
)
USING DELTA
COMMENT 'Silver: parsed + classified documents';

-- ------------------------------------------------------------
-- Runs once per newly-landed file. The backend calls this via the
-- SQL Statement Execution API, binding :document_id / :file_path /
-- :uploaded_by from the row it just wrote to bronze_document_log.
-- ------------------------------------------------------------
MERGE INTO silver_parsed_documents AS target
USING (
  WITH parsed AS (
    SELECT
      content,
      regexp_extract(:file_path, '([^/]+)$', 1) AS file_name
    FROM READ_FILES(:file_path, format => 'binaryFile')
  )
  SELECT
    :document_id                                              AS document_id,
    :file_path                                                AS file_path,
    file_name,
    ai_parse_document(content, MAP('version', '2.0'))         AS parsed_content_raw,
    :uploaded_by                                               AS uploaded_by,
    current_timestamp()                                        AS upload_ts
  FROM parsed
) AS source
ON target.document_id = source.document_id
WHEN NOT MATCHED THEN INSERT (
  document_id, file_path, file_name, parsed_content, uploaded_by, upload_ts
) VALUES (
  source.document_id, source.file_path, source.file_name,
  source.parsed_content_raw, source.uploaded_by, source.upload_ts
);

-- ------------------------------------------------------------
-- Classification runs as a second pass on the freshly parsed row
-- (kept separate so re-classification never re-runs the more
-- expensive parse step). Backend binds :document_id again.
-- ------------------------------------------------------------
UPDATE silver_parsed_documents
SET detected_type = ai_classify(
  parsed_content,
  ARRAY('Employee Contract', 'HR Policy', 'Offer Letter', 'NDA', 'Other'),
  MAP('instructions',
      'Classify this HR/employment document by its primary purpose. ' ||
      'Employee Contract = signed employment agreement between the company and one employee. ' ||
      'HR Policy = a company-wide policy document (leave, WFH, conduct, benefits policy, etc). ' ||
      'Offer Letter = a pre-employment offer, not yet a signed contract. ' ||
      'NDA = confidentiality / non-disclosure agreement.')
)
WHERE document_id = :document_id;
