"""
Ask Genie AI == the Databricks AI/BI Genie Conversation API, scoped to a
Genie Space that's attached to gold_document_comparisons /
gold_document_extractions (see sql/04_genie_setup.md for the one-time
Space setup). Genie writes and runs its own SQL against those Gold
tables -- this file just starts/continues the conversation.
"""
from databricks.sdk import WorkspaceClient

import config

w = WorkspaceClient(host=config.DATABRICKS_HOST, token=config.DATABRICKS_TOKEN)

# in-memory map of comparison_id -> genie conversation_id, so follow-up
# questions in the same chat panel stay in one Genie conversation.
# swap for a real table/cache in production.
_conversations: dict[str, str] = {}


def ask(comparison_id: str, question: str) -> dict:
    scoped_question = f"For comparison_id = '{comparison_id}' in gold_document_comparisons: {question}"

    conversation_id = _conversations.get(comparison_id)
    if conversation_id is None:
        message = w.genie.start_conversation_and_wait(
            space_id=config.GENIE_SPACE_ID,
            content=scoped_question,
        )
        _conversations[comparison_id] = message.conversation_id
    else:
        message = w.genie.create_message_and_wait(
            space_id=config.GENIE_SPACE_ID,
            conversation_id=conversation_id,
            content=scoped_question,
        )

    answer_text = ""
    generated_sql = None
    for attachment in message.attachments or []:
        if getattr(attachment, "text", None):
            answer_text += attachment.text.content
        if getattr(attachment, "query", None):
            generated_sql = attachment.query.query

    return {
        "answer": answer_text or "Genie didn't return a text answer for this question.",
        "generated_sql": generated_sql,
        "conversation_id": message.conversation_id,
    }
