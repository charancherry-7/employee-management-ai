import os
from dotenv import load_dotenv

load_dotenv()

DATABRICKS_HOST = os.environ["DATABRICKS_HOST"]
DATABRICKS_TOKEN = os.environ["DATABRICKS_TOKEN"]
WAREHOUSE_ID = os.environ.get("WAREHOUSE_ID", "c2ca384fb8b7f62c")

CATALOG = "employee_mgmt"
SCHEMA = "doc_intelligence"
VOLUME_PATH = f"/Volumes/{CATALOG}/{SCHEMA}/raw_documents"

GENIE_SPACE_ID = ""
FOUNDATION_MODEL_ENDPOINT = "databricks-meta-llama-3-3-70b-instruct"

EXTRACTION_SCHEMAS = {
    "Employee Contract": {
        "base_salary": {"type": "string"},
        "notice_period": {"type": "string"},
        "reporting_manager": {"type": "string"},
        "effective_date": {"type": "string"},
        "remote_work_clause": {"type": "string"},
        "non_compete_clause": {"type": "string"},
    },
    "HR Policy": {
        "paid_leave_days": {"type": "string"},
        "health_insurance_cover": {"type": "string"},
        "probation_period": {"type": "string"},
        "work_from_home_clause": {"type": "string"},
        "dress_code_clause": {"type": "string"},
    },
}