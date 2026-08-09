"""
Thin wrapper around the Databricks SDK. Everything the pipeline needs --
uploading a file into the Bronze Volume and running the Bronze/Silver/Gold
SQL -- goes through here. No Claude/OpenAI call anywhere in this file;
document understanding happens entirely inside Databricks via ai_parse_document,
ai_classify, ai_extract, and ai_query.
"""
import json
import time
import uuid

from databricks.sdk import WorkspaceClient
from databricks.sdk.service.sql import StatementParameterListItem, StatementState

import config

w = WorkspaceClient(host=config.DATABRICKS_HOST, token=config.DATABRICKS_TOKEN)


def upload_document(local_path: str, file_name: str, uploaded_by: str, batch_id: str) -> dict:
    """Bronze: put the raw file into the UC Volume and log it."""
    document_id = str(uuid.uuid4())
    volume_path = f"{config.VOLUME_PATH}/{batch_id}/{file_name}"

    with open(local_path, "rb") as f:
        w.files.upload(volume_path, f, overwrite=True)

    run_sql(
        """
        INSERT INTO bronze_document_log
          (document_id, file_path, file_name, uploaded_by, upload_ts, batch_id)
        VALUES (:document_id, :file_path, :file_name, :uploaded_by, current_timestamp(), :batch_id)
        """,
        {
            "document_id": document_id,
            "file_path": volume_path,
            "file_name": file_name,
            "uploaded_by": uploaded_by,
            "batch_id": batch_id,
        },
    )
    return {"document_id": document_id, "file_path": volume_path, "file_name": file_name}


def parse_and_classify(document_id: str, file_path: str, uploaded_by: str) -> str:
    """Silver: ai_parse_document() then ai_classify(). Returns detected_type."""
    run_sql(
        """
        WITH parsed AS (
          SELECT ai_parse_document(content, MAP('version', '2.0')) AS parsed_content
          FROM READ_FILES(:file_path, format => 'binaryFile')
        )
        INSERT INTO silver_parsed_documents
        SELECT :document_id, :file_path,
               regexp_extract(:file_path, '([^/]+)$', 1),
               parsed_content,
               NULL,
               :uploaded_by,
               current_timestamp()
        FROM parsed
        """,
        {"document_id": document_id, "file_path": file_path, "uploaded_by": uploaded_by},
    )

    classify_result = run_sql(
        """
        SELECT CAST(
          ai_classify(
            parsed_content,
            '{"Employee Contract": "A signed employment agreement", "HR Policy": "A company-wide HR policy document", "Offer Letter": "A pre-employment offer", "NDA": "A confidentiality agreement", "Other": "Anything else"}',
            MAP('version', '2.0')
          ):response[0] AS STRING
        ) AS detected_type
        FROM silver_parsed_documents
        WHERE document_id = :document_id
        """,
        {"document_id": document_id},
    )
    detected_type = classify_result[0]["detected_type"] if classify_result else None

    run_sql(
        "UPDATE silver_parsed_documents SET detected_type = :detected_type WHERE document_id = :document_id",
        {"document_id": document_id, "detected_type": detected_type},
    )

    return detected_type

 
def extract_fields(document_id: str, file_name: str, detected_type: str) -> dict:
    """Gold step 1: ai_extract() using the schema for detected_type."""
    schema = config.EXTRACTION_SCHEMAS.get(detected_type)
    if schema is None:
        return {}
    run_sql(
        """
        INSERT INTO gold_document_extractions
        SELECT :document_id, :file_name, :detected_type,
               ai_extract(parsed_content, :extraction_schema,
                          MAP('version','2.1','instructions','This is an HR/employment document.')),
               current_timestamp()
        FROM silver_parsed_documents WHERE document_id = :document_id
        """,
        {
            "document_id": document_id,
            "file_name": file_name,
            "detected_type": detected_type,
            "extraction_schema": json.dumps(schema),
        },
    )
    row = run_sql(
        "SELECT extracted_fields FROM gold_document_extractions WHERE document_id = :document_id",
        {"document_id": document_id},
    )
    return json.loads(row[0]["extracted_fields"]) if row else {}


def save_comparison(comparison_id, doc_a, doc_b, doc_type, diff, created_by) -> str:
    """Gold step 2: persist the diff + an ai_query()-generated summary."""
    diff_json = json.dumps(diff)
    run_sql(
        """
        INSERT INTO gold_document_comparisons
        SELECT :comparison_id, :document_id_a, :document_id_b, :doc_type,
               :file_name_a, :file_name_b, parse_json(:diff_json),
               ai_query(:model_endpoint,
                 concat('You are summarizing a comparison between two ', :doc_type,
                        ' documents for an HR user. Field-level diff (JSON): ', :diff_json,
                        ' Write 2-3 plain-English sentences summarizing what changed and why it matters.')),
               current_timestamp(), :created_by
        """,
        {
            "comparison_id": comparison_id,
            "document_id_a": doc_a["document_id"],
            "document_id_b": doc_b["document_id"],
            "doc_type": doc_type,
            "file_name_a": doc_a["file_name"],
            "file_name_b": doc_b["file_name"],
            "diff_json": diff_json,
            "model_endpoint": config.FOUNDATION_MODEL_ENDPOINT,
            "created_by": created_by,
        },
    )
    row = run_sql(
        "SELECT summary FROM gold_document_comparisons WHERE comparison_id = :comparison_id",
        {"comparison_id": comparison_id},
    )
    return row[0]["summary"] if row else None


# ----------------------------------------------------------------------
# Low-level SQL execution via the Statement Execution API
# ----------------------------------------------------------------------
def run_sql(statement: str, params: dict | None = None, poll_seconds: float = 1.0) -> list[dict]:
    named_params = [
        StatementParameterListItem(name=k, value=None if v is None else str(v))
        for k, v in (params or {}).items()
    ]
    resp = w.statement_execution.execute_statement(
        warehouse_id=config.WAREHOUSE_ID,
        catalog=config.CATALOG,
        schema=config.SCHEMA,
        statement=statement,
        parameters=named_params,
        wait_timeout="0s",  # return immediately, we poll below
    )
    statement_id = resp.statement_id
    while resp.status.state in (StatementState.PENDING, StatementState.RUNNING):
        time.sleep(poll_seconds)
        resp = w.statement_execution.get_statement(statement_id)

    if resp.status.state != StatementState.SUCCEEDED:
        raise RuntimeError(f"SQL failed: {resp.status.error}")

    if not resp.result or not resp.manifest or not resp.manifest.schema:
        return []
    columns = [c.name for c in resp.manifest.schema.columns]
    return [dict(zip(columns, row)) for row in (resp.result.data_array or [])]


def run_sql_file(path: str, statement_index: int, params: dict) -> list[dict]:
    """Runs the Nth semicolon-separated statement in a .sql file (skips comments/blank blocks)."""
    with open(path) as f:
        raw = f.read()
    statements = [s.strip() for s in raw.split(";") if s.strip() and not s.strip().startswith("--")]
    return run_sql(statements[statement_index], params)
