"""
Backend for the "Employee Document Comparison + Genie AI" feature.

Every document-understanding step (parse, classify, extract, summarize)
happens inside Databricks via Mosaic AI SQL functions -- this service
only orchestrates: land the file, run the pipeline, shape the response
for the frontend, and proxy chat questions to the Genie Space.

    POST /api/documents/compare   -- upload two files, run full pipeline
    POST /api/genie/ask           -- ask a question about a comparison
"""
import shutil
import tempfile
import uuid

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import databricks_client as db
import diffing

app = FastAPI(title="Document Comparison + Genie AI backend")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.post("/api/documents/compare") 
async def compare_documents(
    doc_a: UploadFile = File(...),
    doc_b: UploadFile = File(...),
    uploaded_by: str = Form("HR"),
):
    batch_id = str(uuid.uuid4())[:8]

    doc_a_meta = _land_and_pipeline(doc_a, uploaded_by, batch_id)
    doc_b_meta = _land_and_pipeline(doc_b, uploaded_by, batch_id)

    meta_rows = [
        {
            "id": "DOC001", "name": doc_a_meta["file_name"], "type": doc_a_meta["detected_type"],
            "version": "v1", "by": uploaded_by, "time": doc_a_meta["upload_ts"],
        },
        {
            "id": "DOC002", "name": doc_b_meta["file_name"], "type": doc_b_meta["detected_type"],
            "version": "v2", "by": uploaded_by, "time": doc_b_meta["upload_ts"],
        },
    ]

    if doc_a_meta["detected_type"] != doc_b_meta["detected_type"]:
        return {
            "status": "mismatch",
            "type_a": doc_a_meta["detected_type"],
            "type_b": doc_b_meta["detected_type"],
            "meta": meta_rows,
        }

    doc_type = doc_a_meta["detected_type"]
    extracted_a = db.extract_fields(doc_a_meta["document_id"], doc_a_meta["file_name"], doc_type)
    extracted_b = db.extract_fields(doc_b_meta["document_id"], doc_b_meta["file_name"], doc_type)

    diffs = diffing.diff_extractions(extracted_a, extracted_b)

    comparison_id = str(uuid.uuid4())
    summary = db.save_comparison(
        comparison_id,
        {"document_id": doc_a_meta["document_id"], "file_name": doc_a_meta["file_name"]},
        {"document_id": doc_b_meta["document_id"], "file_name": doc_b_meta["file_name"]},
        doc_type,
        diffs,
        uploaded_by,
    )

    return {
        "status": "results",
        "comparison_id": comparison_id,
        "doc_type": doc_type,
        "meta": meta_rows,
        "diffs": diffs,
        "summary": summary,
    }


class GenieQuestion(BaseModel):
    comparison_id: str
    question: str


@app.post("/api/genie/ask")
async def genie_ask(body: GenieQuestion):
    import genie_client
    return genie_client.ask(body.comparison_id, body.question)


def _land_and_pipeline(upload: UploadFile, uploaded_by: str, batch_id: str) -> dict:
    with tempfile.NamedTemporaryFile(delete=False) as tmp:
        shutil.copyfileobj(upload.file, tmp)
        tmp_path = tmp.name

    landed = db.upload_document(tmp_path, upload.filename, uploaded_by, batch_id)
    detected_type = db.parse_and_classify(landed["document_id"], landed["file_path"], uploaded_by)

    return {
        **landed,
        "detected_type": detected_type,
        "upload_ts": db.run_sql(
            "SELECT upload_ts FROM bronze_document_log WHERE document_id = :document_id",
            {"document_id": landed["document_id"]},
        )[0]["upload_ts"],
    }
