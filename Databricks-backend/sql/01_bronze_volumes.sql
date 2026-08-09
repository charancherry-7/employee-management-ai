-- ============================================================
-- BRONZE LAYER
-- Raw files land untouched in a Unity Catalog Volume.
-- Run once per environment to set up the catalog/schema/volume.
-- ============================================================

CREATE CATALOG IF NOT EXISTS employee_mgmt;

CREATE SCHEMA IF NOT EXISTS employee_mgmt.doc_intelligence;

USE CATALOG employee_mgmt;
USE SCHEMA doc_intelligence;

-- Managed Volume that holds the original PDFs / Word files exactly as
-- uploaded from the frontend. Nothing here is parsed or classified yet.
CREATE VOLUME IF NOT EXISTS raw_documents
COMMENT 'Bronze: original uploaded documents (PDF/DOCX), untouched';

-- A thin log table so every landed file has a row before Silver picks
-- it up. The backend writes here right after the file lands in the
-- volume (see backend/databricks_client.py: upload_document()).
CREATE TABLE IF NOT EXISTS bronze_document_log (
  document_id   STRING      NOT NULL,
  file_path     STRING      NOT NULL,   -- /Volumes/employee_mgmt/doc_intelligence/raw_documents/...
  file_name     STRING      NOT NULL,
  uploaded_by   STRING      NOT NULL,
  upload_ts     TIMESTAMP   NOT NULL,
  batch_id      STRING                  -- ties two docs together as one comparison request
)
USING DELTA
COMMENT 'Bronze: log of every file landed in raw_documents, before AI parsing';
