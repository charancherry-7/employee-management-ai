# Wiring "Ask Genie AI" to a real Databricks Genie Space

Genie Spaces are the actual Databricks product behind "Ask Genie AI" — it's
AI/BI Genie, not a custom chatbot. Your backend calls the **Genie
Conversation API**, Genie writes and runs its own SQL against the Gold
tables, and returns a natural-language answer plus (optionally) the query
result. This is one-time setup in the workspace, then a few API calls from
the backend per question.

## 1. Create the Space (Databricks UI, one time)

1. In the workspace sidebar: **New → Genie space**.
2. Name it `Employee Document Comparison`.
3. Under **Data**, add these Unity Catalog tables from
   `employee_mgmt.doc_intelligence`:
   - `gold_document_comparisons` (primary — this is what most questions hit)
   - `gold_document_extractions`
   - `silver_parsed_documents` (optional, for "what does the original text say")
4. Under **Instructions**, add grounding text so Genie doesn't have to guess
   at your schema, e.g.:

   > `gold_document_comparisons.diff` is a JSON array of objects with keys
   > `field`, `before`, `after`, `kind` (`modified` / `added` / `removed`).
   > `doc_type` tells you which kind of document was compared (Employee
   > Contract, HR Policy, Offer Letter, NDA). To answer "has salary
   > changed", look for `field` values containing "Salary" or "CTC" in the
   > diff. `summary` already contains a plain-English recap — prefer it for
   > open-ended questions like "summarize the differences".

5. Add a few sample questions in the Space (this is what makes Genie
   reliable, not just the schema): *"Has salary changed in the latest
   comparison?"*, *"Which clauses were added?"*, *"Which document is
   newer?"*
6. Grant your **service principal** (the one the backend authenticates as)
   `CAN VIEW` on the Space and `CAN USE` on the SQL warehouse it runs
   against.
7. Copy the `space_id` out of the Space URL:
   `https://<workspace>/genie/rooms/<space_id>`

## 2. Call it from the backend

Two REST calls per question — start a conversation, then poll until the
message is `COMPLETED`. The Databricks SDK wraps both into one blocking
call (`start_conversation_and_wait` / `create_message_and_wait`), which is
what `backend/genie_client.py` uses.

```python
from databricks.sdk import WorkspaceClient

w = WorkspaceClient()  # picks up DATABRICKS_HOST / DATABRICKS_TOKEN

message = w.genie.start_conversation_and_wait(
    space_id=GENIE_SPACE_ID,
    content="For comparison abc-123, has the salary changed?",
)

print(message.attachments)  # text answer + generated SQL + query result
```

For **follow-up** questions in the same chat panel, reuse the
`conversation_id` from the first response and call
`create_message_and_wait` instead of starting a new conversation — this
lets Genie use prior turns as context, same as the chat UI does.

## 3. Keep the comparison scoped

Since the Gold table holds *every* comparison ever run, each question from
the frontend should mention the `comparison_id` (the backend injects it
into the prompt, e.g. `"For comparison {comparison_id}, ..."`) so Genie's
generated SQL filters to the right row instead of answering across all
historical comparisons.
