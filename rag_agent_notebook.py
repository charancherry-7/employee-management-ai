# Databricks notebook source
# Install all required packages
%pip install \
databricks-vectorsearch \
sentence-transformers \
mlflow \
databricks-sdk \
--quiet

# Restart Python so newly installed packages are available
dbutils.library.restartPython()

# COMMAND ----------

#reconnecting to our exsisting index

from databricks.vector_search.client import VectorSearchClient
from sentence_transformers import SentenceTransformer
import mlflow

CATALOG = "employee_management"
SCHEMA = "fullstack"
ENDPOINT_NAME = "employee_ai_endpoint"

vsc = VectorSearchClient()
general_index = vsc.get_index(ENDPOINT_NAME, f"{CATALOG}.{SCHEMA}.general_docs_index")
restricted_index = vsc.get_index(ENDPOINT_NAME, f"{CATALOG}.{SCHEMA}.restricted_docs_index")

print("Connected to both indexes.")

# COMMAND ----------

# Define the model as a proper MLflow PyFunc class

# This is the real difference from the Flask shortcut:
# This class is packaged so Databricks can serve it standalone,
# with its own auth to Vector Search and the LLM,
# independent of your notebook session.

rag_agent_code = '''
import mlflow.pyfunc
import pandas as pd
from databricks.sdk import WorkspaceClient

WAREHOUSE_ID = "c2ca384fb8b7f62c"
DATABRICKS_HOST = "https://dbc-d936181c-d4dd.cloud.databricks.com"

# Retrieve the Databricks token securely from Databricks Secrets




class EmployeeRAGAgent(mlflow.pyfunc.PythonModel):

    def load_context(self, context):
        import os
        from databricks.vector_search.client import VectorSearchClient
        from sentence_transformers import SentenceTransformer
        from databricks.sdk import WorkspaceClient
        import mlflow.deployments

        self.vsc = VectorSearchClient()
        self.embed_model = SentenceTransformer("all-MiniLM-L6-v2")
        self.llm_client = mlflow.deployments.get_deploy_client("databricks")

        token = os.environ.get("DATABRICKS_TOKEN")

        if token:
            self.ws_client = WorkspaceClient(
                host=DATABRICKS_HOST,
                token=token
            )
        else:
            self.ws_client = WorkspaceClient()

        self.general_index = self.vsc.get_index(
            "employee_ai_endpoint",
            "employee_management.fullstack.general_docs_index"
        )

        self.restricted_index = self.vsc.get_index(
            "employee_ai_endpoint",
            "employee_management.fullstack.restricted_docs_index"
        )

    def _run_sql(self, sql):
        import time

        resp = self.ws_client.statement_execution.execute_statement(
            warehouse_id=WAREHOUSE_ID,
            statement=sql,
            wait_timeout="0s"
        )

        statement_id = resp.statement_id

        for _ in range(30):
            resp = self.ws_client.statement_execution.get_statement(statement_id)

            state = (
                resp.status.state.value
                if resp.status and resp.status.state
                else None
            )

            if state == "SUCCEEDED":
                break

            if state in ("FAILED", "CANCELED", "CLOSED"):
                error_msg = (
                    resp.status.error.message
                    if resp.status and resp.status.error
                    else "Unknown SQL error"
                )
                raise Exception("SQL failed: " + error_msg)

            time.sleep(1)

        columns = (
            [c.name for c in resp.manifest.schema.columns]
            if resp.manifest and resp.manifest.schema
            else []
        )

        rows = (
            resp.result.data_array
            if resp.result and resp.result.data_array
            else []
        )

        return columns, rows

    def _detect_sql_intent(self, question):
        q = question.lower()

        tokens = (
            q.replace(",", " ")
             .replace("?", " ")
             .replace(":", " ")
             .split()
        )

        digit_tokens = []

        for t in tokens:
            cleaned = t.strip(".#")

            if cleaned.isdigit():
                digit_tokens.append(cleaned)

        if "employee" in q or "id" in q or "salary" in q:
            for t in digit_tokens:
                if len(t) <= 6:
                    return "by_id", int(t)

        if "join" in q or "hire" in q or "onboard" in q:
            for t in digit_tokens:
                if len(t) == 4 and t.startswith("20"):
                    return "by_year", int(t)

        return None, None

    def _sql_answer(self, question):
        intent, value = self._detect_sql_intent(question)

        if intent == "by_id":
            columns, rows = self._run_sql(
                "SELECT first_name, last_name, department, designation, salary, "
                "date_of_joining, status "
                "FROM employee_management.fullstack.employees "
                "WHERE employee_id = " + str(value)
            )

            if not rows:
                return (
                    "I could not find an employee with ID "
                    + str(value)
                    + "."
                )

            r = dict(zip(columns, rows[0]))

            return (
                "Employee " + str(value)
                + " is " + r["first_name"] + " " + r["last_name"]
                + ", " + r["designation"]
                + " in " + r["department"]
                + ". Salary: Rs " + str(r["salary"])
                + ". Joined on " + str(r["date_of_joining"])
                + ". Status: " + r["status"] + "."
            )

        if intent == "by_year":
            columns, rows = self._run_sql(
                "SELECT first_name, last_name, department "
                "FROM employee_management.fullstack.employees "
                "WHERE year(date_of_joining) = "
                + str(value)
                + " LIMIT 15"
            )

            if not rows:
                return (
                    "No employees joined in "
                    + str(value)
                    + "."
                )

            names = "; ".join(
                [
                    r[0] + " " + r[1] + " (" + r[2] + ")"
                    for r in rows
                ]
            )

            return (
                str(len(rows))
                + " employee(s) joined in "
                + str(value)
                + ": "
                + names
                + "."
            )

        return None

    def _rag_answer(self, question, mode):
        index = (
            self.restricted_index
            if mode == "restricted"
            else self.general_index
        )

        query_vector = self.embed_model.encode(
            [question]
        ).tolist()[0]

        results = index.similarity_search(
            query_vector=query_vector,
            columns=["source_file", "content"],
            num_results=4
        )

        chunks = results["result"]["data_array"]

        context_text = "\\n\\n".join(
            [c[1] for c in chunks]
        )

        prompt = (
            "You are an HR assistant for TechNova Solutions. "
            "Answer the question in a natural, direct, conversational "
            "sentence using ONLY the context below. "
            "Do NOT mention document names, file names, sources, "
            "or use brackets. Just answer as if you already knew "
            "the policy. If the answer is not in the context, say "
            "exactly: I do not have that information yet, please "
            "check with HR directly.\\n\\nContext:\\n"
            + context_text
            + "\\n\\nQuestion: "
            + question
            + "\\n\\nAnswer:"
        )

        response = self.llm_client.predict(
            endpoint="databricks-meta-llama-3-1-8b-instruct",
            inputs={
                "messages": [
                    {
                        "role": "user",
                        "content": prompt
                    }
                ],
                "max_tokens": 300
            }
        )

        return response["choices"][0]["message"]["content"]

    def _answer(self, question, mode):
        if mode == "restricted":
            sql_result = self._sql_answer(question)

            if sql_result:
                return sql_result

        return self._rag_answer(question, mode)

    def predict(self, context, model_input):
        results = []

        for _, row in model_input.iterrows():
            results.append(
                self._answer(
                    row["question"],
                    row.get("mode", "general")
                )
            )

        return pd.Series(results)


mlflow.models.set_model(EmployeeRAGAgent())
'''

with open("rag_agent.py", "w") as f:
    f.write(rag_agent_code)

print("rag_agent.py written successfully.")

# COMMAND ----------

with open("rag_agent.py", "r") as f:
    code = f.read()

print(code)

# COMMAND ----------

import importlib.util
spec = importlib.util.spec_from_file_location("rag_agent", "rag_agent.py")
rag_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rag_module)

agent = rag_module.EmployeeRAGAgent()
agent.load_context(None)
print(agent._sql_answer("Salary details for employee ID 12"))

# COMMAND ----------

import importlib.util
spec = importlib.util.spec_from_file_location("rag_agent", "rag_agent.py")
rag_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rag_module)

agent = rag_module.EmployeeRAGAgent()
agent.load_context(None)
print(agent._sql_answer("Salary details for employee ID 12"))

# COMMAND ----------

#Log and register the model to Unity Catalog 
# The resources list is the key part — it tells Databricks which Vector Search index and LLM endpoint this model needs, so Model Serving can auto-provision the right permissions when it runs.

import mlflow
import pandas as pd
from mlflow.models import infer_signature
from mlflow.models.resources import (
    DatabricksVectorSearchIndex,
    DatabricksServingEndpoint,
    DatabricksSQLWarehouse,
)

mlflow.set_registry_uri("databricks-uc")

input_example = pd.DataFrame({
    "question": ["Salary details for employee ID 12"],
    "mode": ["restricted"]
})
output_example = pd.DataFrame({
    "answer": ["Employee 12 is Rahul Kumar, HR Executive in Sales. Salary: Rs 62000."]
})
signature = infer_signature(input_example, output_example)

with mlflow.start_run(run_name="employee_rag_agent_v5_final") as run:
    model_info = mlflow.pyfunc.log_model(
        artifact_path="rag_agent",
        python_model="rag_agent.py",
        pip_requirements=["databricks-vectorsearch", "sentence-transformers", "mlflow", "databricks-sdk"],
        input_example=input_example,
        signature=signature,
        resources=[
            DatabricksVectorSearchIndex(index_name="employee_management.fullstack.general_docs_index"),
            DatabricksVectorSearchIndex(index_name="employee_management.fullstack.restricted_docs_index"),
            DatabricksServingEndpoint(endpoint_name="databricks-meta-llama-3-1-8b-instruct"),
            DatabricksSQLWarehouse(warehouse_id="c2ca384fb8b7f62c"),
        ]
    )
    run_id = run.info.run_id

MODEL_NAME = "employee_management.fullstack.employee_rag_agent"
registered = mlflow.register_model(model_uri=f"runs:/{run_id}/rag_agent", name=MODEL_NAME)
print(f"Registered as {MODEL_NAME}, version {registered.version}")

# COMMAND ----------

#Update the live endpoint to this new version (note the version number — use whatever registered.version printed, likely 6)

from databricks.sdk import WorkspaceClient
from databricks.sdk.service.serving import ServedEntityInput

w = WorkspaceClient()
SERVING_ENDPOINT_NAME = "employee-rag-agent-endpoint"

w.serving_endpoints.update_config(
    name=SERVING_ENDPOINT_NAME,
    served_entities=[
        ServedEntityInput(
            entity_name=MODEL_NAME,
            entity_version=str(registered.version),
            workload_size="Small",
            scale_to_zero_enabled=True,
            environment_vars={"DATABRICKS_TOKEN": "{{secrets/employee_mgmt_secrets/databricks_token}}"}
        )
    ]
)
print("Endpoint update triggered. Go check Compute > Serving — wait for Ready, 3-5 min.")

# COMMAND ----------

import requests

token = dbutils.notebook.entry_point.getDbutils().notebook().getContext().apiToken().get()
host = spark.conf.get("spark.databricks.workspaceUrl")
url = f"https://{host}/serving-endpoints/employee-rag-agent-endpoint/invocations"
headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

payload = {"dataframe_split": {"columns": ["question", "mode"], "data": [["Salary details for employee ID 12", "restricted"]]}}
print(requests.post(url, headers=headers, json=payload).json())