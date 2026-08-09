"""
ai_extract() gives us two clean, typed JSON objects -- one per document.
Diffing two known, matching schemas is a plain dict comparison; there's
no need to spend an LLM call on it. The LLM's job (via ai_query, in
databricks_client.save_comparison) is turning that diff into a sentence,
not producing it.
"""

FIELD_LABELS = {
    "base_salary": "Base Salary",
    "notice_period": "Notice Period",
    "reporting_manager": "Reporting Manager",
    "effective_date": "Effective Date",
    "remote_work_clause": "Remote Work Clause",
    "non_compete_clause": "Non-Compete Clause",
    "paid_leave_days": "Paid Leave",
    "health_insurance_cover": "Health Insurance Cover",
    "probation_period": "Probation Period",
    "work_from_home_clause": "Work From Home Clause",
    "dress_code_clause": "Dress Code Clause",
    "annual_ctc": "Annual CTC",
    "joining_date": "Joining Date",
    "designation": "Designation",
    "sign_on_bonus_clause": "Sign-on Bonus Clause",
    "confidentiality_term": "Confidentiality Term",
    "governing_law": "Governing Law",
    "return_of_materials_clause": "Return of Materials Clause",
}


def _value(field_obj):
    # ai_extract v2.1 wraps each leaf as {"value": ..., "citation_ids": [...]}
    if isinstance(field_obj, dict) and "value" in field_obj:
        return field_obj["value"]
    return field_obj


def diff_extractions(extracted_a: dict, extracted_b: dict) -> list[dict]:
    fields_a = (extracted_a or {}).get("response", extracted_a or {})
    fields_b = (extracted_b or {}).get("response", extracted_b or {})

    diffs = []
    for key in sorted(set(fields_a) | set(fields_b)):
        before = _value(fields_a.get(key))
        after = _value(fields_b.get(key))
        label = FIELD_LABELS.get(key, key.replace("_", " ").title())

        if before == after:
            continue
        elif before in (None, "", "null") and after not in (None, "", "null"):
            diffs.append({"field": label, "before": None, "after": after, "kind": "added"})
        elif after in (None, "", "null") and before not in (None, "", "null"):
            diffs.append({"field": label, "before": before, "after": None, "kind": "removed"})
        else:
            diffs.append({"field": label, "before": before, "after": after, "kind": "modified"})

    return diffs
