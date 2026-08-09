import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

const NODE_BACKEND = "http://localhost:5000";
const DOC_BACKEND = "http://127.0.0.1:8000";

const STAGES = [
  { key: "bronze", label: "BRONZE", sub: "Volumes", desc: "Original files stored in Unity Catalog Volumes" },
  { key: "silver", label: "SILVER", sub: "AI_PARSE_DOCUMENT · AI_CLASSIFY", desc: "Parsed & classified into structured Delta tables" },
  { key: "gold", label: "GOLD", sub: "AI_EXTRACT", desc: "Attributes extracted, comparison stored for Genie AI" },
];

const SUGGESTIONS = [
  "Summarize the differences", "Has salary changed?", "Which clauses were modified?",
  "Show all benefit changes", "Which paragraphs were added?", "Which document is newer?",
];

function answerFromComparison(question, result) {
  const q = question.toLowerCase();
  const diffs = result.diffs || [];
  const list = (arr, formatter) => arr.map(formatter).join("\n");
  if (!diffs.length) return "This comparison couldn't run because the two documents are different types.";
  if (q.includes("summar")) return result.summary || `Between the two versions: ${diffs.length} difference(s) found.`;
  if (q.includes("salary") || q.includes("pay") || q.includes("compensation")) {
    const s = diffs.find((d) => /salary|ctc/i.test(d.field));
    return s ? `Yes — ${s.field} changed from ${s.before} to ${s.after}.` : "No compensation-related fields changed in this comparison.";
  }
  if (q.includes("clause") && q.includes("modif")) {
    const c = diffs.filter((d) => d.kind === "modified");
    return c.length ? "Changes found:\n" + list(c, (d) => `• ${d.field}`) : "No clauses were modified.";
  }
  if (q.includes("benefit")) {
    const b = diffs.filter((d) => /leave|insurance|benefit/i.test(d.field));
    return b.length ? list(b, (d) => `• ${d.field}: ${d.before} → ${d.after}`) : "No benefit-related changes were found in this comparison.";
  }
  if (q.includes("added") || q.includes("paragraph")) {
    const a = diffs.filter((d) => d.kind === "added");
    return a.length ? list(a, (d) => `• ${d.field} — "${d.after}"`) : "No new paragraphs or clauses were added.";
  }
  if (q.includes("newer") || q.includes("latest") || q.includes("recent")) {
    const [m1, m2] = result.meta;
    return `${m2.name} (${m2.version}) is the more recently uploaded document, uploaded ${m2.time}.`;
  }
  const words = q.split(/\s+/).filter((w) => w.length > 3);
  const matched = diffs.find((d) => words.some((w) => d.field.toLowerCase().includes(w)));
  if (matched) {
    if (matched.kind === "modified") return `${matched.field} changed from ${matched.before} to ${matched.after}.`;
    if (matched.kind === "added") return `${matched.field} was added: "${matched.after}"`;
    if (matched.kind === "removed") return `${matched.field} was removed. It previously said: "${matched.before}"`;
  }
  return "I can answer questions grounded in this comparison's structured data — try asking about salary, clauses, benefits, added paragraphs, or which document is newer.";
}

function App() {
  const [employees, setEmployees] = useState([]);

  const [employee, setEmployee] = useState({
    first_name: "",
    last_name: "",
    email: "",
    phone: "",
    department: "",
    designation: "",
    salary: "",
    date_of_joining: "",
    status: "Active"
  });

  const [editId, setEditId] = useState(null);
  const [searchId, setSearchId] = useState("");
  const [activeTab, setActiveTab] = useState("overview"); // overview | employees | ask-ai | doc-compare

  // ---- Ask AI -- now wired to the real backend ----
  const [aiMode, setAiMode] = useState("general"); // general | restricted
  const [aiQuestion, setAiQuestion] = useState("");
  const [aiAnswer, setAiAnswer] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiHistory, setAiHistory] = useState([]);

  // ---- Doc Compare state ----
  const [fileA, setFileA] = useState(null);
  const [fileB, setFileB] = useState(null);
  const [dcStatus, setDcStatus] = useState("idle"); // idle | processing | mismatch | results | error
  const [dcStageIdx, setDcStageIdx] = useState(-1);
  const [dcResult, setDcResult] = useState(null);
  const [showArch, setShowArch] = useState(false);
  const [genieOpen, setGenieOpen] = useState(false);
  const [dcError, setDcError] = useState("");
  const inputA = useRef(null);
  const inputB = useRef(null);

  const loadEmployees = () => {
    fetch(`${NODE_BACKEND}/employees`)
      .then((res) => res.json())
      .then((data) => {
        setEmployees(data);
      });
  };

  useEffect(() => {
    loadEmployees();
  }, []);

  const addEmployee = () => {
    fetch(`${NODE_BACKEND}/employees`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(employee)
    })
      .then(() => {
        return fetch(`${NODE_BACKEND}/employees`);
      })
      .then((res) => res.json())
      .then((data) => {
        setEmployees(data);

        setEmployee({
          first_name: "",
          last_name: "",
          email: "",
          phone: "",
          department: "",
          designation: "",
          salary: "",
          date_of_joining: "",
          status: "Active"
        });
      });
  };

  const searchEmployee = () => {
    if (searchId === "") {
      loadEmployees();
      return;
    }

    fetch(`${NODE_BACKEND}/employees/${searchId}`)
      .then((res) => {
        if (!res.ok) {
          throw new Error();
        }
        return res.json();
      })
      .then((data) => {
        setEmployees([data]);
      })
      .catch(() => {
        alert("Employee Not Found");
      });
  };

  const deleteEmployee = (id) => {
    fetch(`${NODE_BACKEND}/employees/${id}`, {
      method: "DELETE"
    })
      .then((res) => res.json())
      .then((result) => {
        console.log(result);
        return fetch(`${NODE_BACKEND}/employees`);
      })
      .then((res) => res.json())
      .then((data) => {
        setEmployees(data);
      })
      .catch((err) => console.log(err));
  };

  const editEmployee = (emp) => {
    setEmployee(emp);
    setEditId(emp.employee_id);
    setActiveTab("employees");
  };

  const updateEmployee = () => {
    fetch(`${NODE_BACKEND}/employees/${editId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(employee)
    })
      .then((res) => res.json())
      .then(() => {
        return fetch(`${NODE_BACKEND}/employees`);
      })
      .then((res) => res.json())
      .then((data) => {
        setEmployees(data);

        setEmployee({
          first_name: "",
          last_name: "",
          email: "",
          phone: "",
          department: "",
          designation: "",
          salary: "",
          date_of_joining: "",
          status: "Active"
        });

        setEditId(null);
      });
  };

  const cancelEdit = () => {
    setEditId(null);
    setEmployee({
      first_name: "",
      last_name: "",
      email: "",
      phone: "",
      department: "",
      designation: "",
      salary: "",
      date_of_joining: "",
      status: "Active"
    });
  };

  // ---- Dashboard stats derived from existing employees data ----
  const stats = useMemo(() => {
    const total = employees.length;
    const active = employees.filter((e) => e.status === "Active").length;
    const departments = new Set(employees.map((e) => e.department).filter(Boolean)).size;
    const avgSalary =
      total > 0
        ? Math.round(
            employees.reduce((sum, e) => sum + (Number(e.salary) || 0), 0) / total
          )
        : 0;
    return { total, active, departments, avgSalary };
  }, [employees]);

  // ---- Ask AI submit -- now calls the real Node -> Databricks agent endpoints ----
  const askAI = async () => {
    if (!aiQuestion.trim() || aiLoading) return;
    setAiLoading(true);
    setAiAnswer(null);
    const question = aiQuestion;

    const endpoint = aiMode === "restricted" ? "/api/ai/ask-hr" : "/api/ai/ask-general";
    try {
      const res = await fetch(`${NODE_BACKEND}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      setAiHistory((h) => [{ question, answer: data.answer, mode: aiMode }, ...h]);
      setAiAnswer(data.answer);
    } catch {
      const errText = "Could not reach the AI service. Check that node server.js is running on port 5000.";
      setAiHistory((h) => [{ question, answer: errText, mode: aiMode }, ...h]);
      setAiAnswer(errText);
    }
    setAiQuestion("");
    setAiLoading(false);
  };

  const sampleQuestions =
    aiMode === "general"
      ? ["How many casual leaves do I get?", "Can I work from home?", "What's the holiday calendar?"]
      : ["Show employees who joined in 2024", "Salary details for employee ID 12", "What are the promotion rules?"];

  // ---- Doc Compare handlers ----
  const dcUpload = async () => { //<-This is the function that starts the document-comparison process.
    if (!fileA || !fileB) return;
    setDcStatus("processing");
    setDcStageIdx(1);
    setGenieOpen(false);
    setDcError("");

    const form = new FormData(); // formdata() packages those files for an HTTP request.
    form.append("doc_a", fileA);
    form.append("doc_b", fileB);
    form.append("uploaded_by", "HR");

    try {
      const res = await fetch(`${DOC_BACKEND}/api/documents/compare`, { method: "POST", body: form });
      if (!res.ok) throw new Error(`Backend returned ${res.status}`);
      const data = await res.json();
      setDcStageIdx(3);

      if (data.status === "mismatch") {
        setDcResult({ meta: data.meta, typeA: data.type_a, typeB: data.type_b, diffs: null });
        setDcStatus("mismatch");
      } else {
        setDcResult({
          meta: data.meta, typeA: data.doc_type, diffs: data.diffs,
          comparisonId: data.comparison_id, summary: data.summary,
        });
        setDcStatus("results");
      }
    } catch {
      setDcError("Could not reach the backend. Make sure uvicorn is running (uvicorn main:app --reload) and try again.");
      setDcStatus("error");
    }
  };

  const onPickDoc = (which) => (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (which === "a") setFileA(f); else setFileB(f);
    setDcStatus("idle");
    setDcResult(null);
  };

  const dcReset = () => {
    setFileA(null); setFileB(null); setDcStatus("idle"); setDcResult(null);
    setDcStageIdx(-1); setGenieOpen(false); setDcError("");
  };

  return (
    <div className="app">
      {/* Top Bar */}
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">EM</span>
          <div className="brand-text">
            <span className="brand-name">Employee Management</span>
            <span className="brand-sub">Intelligence Console</span>
          </div>
        </div>

        <nav className="tabs">
          <button
            className={`tab ${activeTab === "overview" ? "active" : ""}`}
            onClick={() => setActiveTab("overview")}
          >
            Overview
          </button>
          <button
            className={`tab ${activeTab === "employees" ? "active" : ""}`}
            onClick={() => setActiveTab("employees")}
          >
            Employees
          </button>
          <button
            className={`tab ${activeTab === "ask-ai" ? "active" : ""}`}
            onClick={() => setActiveTab("ask-ai")}
          >
            Ask AI
            <span className="tab-pulse" />
          </button>
          <button
            className={`tab ${activeTab === "doc-compare" ? "active" : ""}`}
            onClick={() => setActiveTab("doc-compare")}
          >
            Doc Compare
            <span className="tab-pulse" />
          </button>
        </nav>
      </header>

      <main className="main">
        {/* ---------------- OVERVIEW TAB ---------------- */}
        {activeTab === "overview" && (
          <section className="view">
            <div className="view-head">
              <h1>Overview</h1>
              <p>A quick read on your workforce, right now.</p>
            </div>

            <div className="stat-grid">
              <div className="stat-card">
                <span className="stat-label">Total Employees</span>
                <span className="stat-value mono">{stats.total}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Active</span>
                <span className="stat-value mono accent-teal">{stats.active}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Departments</span>
                <span className="stat-value mono">{stats.departments}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Avg. Salary</span>
                <span className="stat-value mono accent-amber">
                  {stats.avgSalary ? `₹${stats.avgSalary.toLocaleString()}` : "—"}
                </span>
              </div>
            </div>

            <div className="promo-card">
              <div className="promo-copy">
                <span className="eyebrow">New</span>
                <h2>Ask AI is live</h2>
                <p>
                  Employees can ask plain-language questions about policy documents. HR and
                  admins get a second, higher-clearance AI that can also query live employee
                  records.
                </p>
              </div>
              <button className="primary-btn" onClick={() => setActiveTab("ask-ai")}>
                Open Ask AI →
              </button>
            </div>

            <div className="promo-card" style={{ marginTop: 20 }}>
              <div className="promo-copy">
                <span className="eyebrow">New</span>
                <h2>Employee Document Comparison + Genie AI</h2>
                <p>
                  Upload any two documents — contracts, policies, offer letters. AI detects what
                  they are, compares them automatically, and every result is queryable afterwards
                  through Ask Genie AI.
                </p>
              </div>
              <button className="primary-btn" onClick={() => setActiveTab("doc-compare")}>
                Open Document Comparison →
              </button>
            </div>
          </section>
        )}

        {/* ---------------- EMPLOYEES TAB ---------------- */}
        {activeTab === "employees" && (
          <section className="view">
            <div className="view-head">
              <h1>Employees</h1>
              <p>Search, add, update, and manage employee records.</p>
            </div>

            <div className="card search-card">
              <h2>Search</h2>
              <div className="search-box">
                <input
                  type="number"
                  placeholder="Enter Employee ID…"
                  value={searchId}
                  onChange={(e) => setSearchId(e.target.value)}
                />
                <button className="ghost-btn" onClick={searchEmployee}>
                  Search
                </button>
                <button className="ghost-btn" onClick={loadEmployees}>
                  Show All
                </button>
              </div>
            </div>

            <div className="card form-card">
              <h2>{editId ? "Update Employee" : "Add Employee"}</h2>

              <div className="form-grid">
                <input
                  type="text"
                  placeholder="First Name"
                  value={employee.first_name}
                  onChange={(e) => setEmployee({ ...employee, first_name: e.target.value })}
                />
                <input
                  type="text"
                  placeholder="Last Name"
                  value={employee.last_name}
                  onChange={(e) => setEmployee({ ...employee, last_name: e.target.value })}
                />
                <input
                  type="email"
                  placeholder="Email"
                  value={employee.email}
                  onChange={(e) => setEmployee({ ...employee, email: e.target.value })}
                />
                <input
                  type="text"
                  placeholder="Phone"
                  value={employee.phone}
                  onChange={(e) => setEmployee({ ...employee, phone: e.target.value })}
                />
                <input
                  type="text"
                  placeholder="Department"
                  value={employee.department}
                  onChange={(e) => setEmployee({ ...employee, department: e.target.value })}
                />
                <input
                  type="text"
                  placeholder="Designation"
                  value={employee.designation}
                  onChange={(e) => setEmployee({ ...employee, designation: e.target.value })}
                />
                <input
                  type="number"
                  placeholder="Salary"
                  value={employee.salary}
                  onChange={(e) => setEmployee({ ...employee, salary: e.target.value })}
                />
                <input
                  type="date"
                  value={employee.date_of_joining}
                  onChange={(e) => setEmployee({ ...employee, date_of_joining: e.target.value })}
                />
                <select
                  value={employee.status}
                  onChange={(e) => setEmployee({ ...employee, status: e.target.value })}
                >
                  <option>Active</option>
                  <option>Inactive</option>
                </select>
              </div>

              <div className="form-actions">
                <button className="primary-btn" onClick={editId ? updateEmployee : addEmployee}>
                  {editId ? "Update Employee" : "Add Employee"}
                </button>
                {editId && (
                  <button className="ghost-btn" onClick={cancelEdit}>
                    Cancel
                  </button>
                )}
              </div>
            </div>

            <div className="card table-card">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>First Name</th>
                      <th>Last Name</th>
                      <th>Email</th>
                      <th>Phone</th>
                      <th>Department</th>
                      <th>Designation</th>
                      <th>Salary</th>
                      <th>Joined</th>
                      <th>Status</th>
                      <th></th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {employees.map((emp) => (
                      <tr key={emp.employee_id}>
                        <td className="mono">{emp.employee_id}</td>
                        <td>{emp.first_name}</td>
                        <td>{emp.last_name}</td>
                        <td>{emp.email}</td>
                        <td className="mono">{emp.phone}</td>
                        <td>{emp.department}</td>
                        <td>{emp.designation}</td>
                        <td className="mono">{emp.salary}</td>
                        <td className="mono">{emp.date_of_joining}</td>
                        <td>
                          <span
                            className={`badge ${
                              emp.status === "Active" ? "badge-success" : "badge-muted"
                            }`}
                          >
                            <span className="badge-dot" />
                            {emp.status}
                          </span>
                        </td>
                        <td>
                          <button className="icon-btn" onClick={() => editEmployee(emp)}>
                            Edit
                          </button>
                        </td>
                        <td>
                          <button
                            className="icon-btn danger"
                            onClick={() => deleteEmployee(emp.employee_id)}
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                    {employees.length === 0 && (
                      <tr>
                        <td colSpan="12" className="empty-row">
                          No employees to show.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}

        {/* ---------------- ASK AI TAB ---------------- */}
        {activeTab === "ask-ai" && (
          <section className="view">
            <div className="view-head">
              <h1>Ask AI</h1>
              <p>Ask a question in plain language. Clearance determines what it can see.</p>
            </div>

            <div className="clearance-toggle">
              <button
                className={`clearance-btn teal ${aiMode === "general" ? "active" : ""}`}
                onClick={() => setAiMode("general")}
              >
                <span className="badge-dot" />
                <div>
                  <span className="clearance-title">Employee AI</span>
                  <span className="clearance-sub">All-access · policy documents</span>
                </div>
              </button>

              <button
                className={`clearance-btn amber ${aiMode === "restricted" ? "active" : ""}`}
                onClick={() => setAiMode("restricted")}
              >
                <span className="badge-dot" />
                <div>
                  <span className="clearance-title">HR &amp; Admin AI</span>
                  <span className="clearance-sub">Restricted · employee records + sensitive docs</span>
                </div>
              </button>
            </div>

            <div className={`card ai-card ${aiMode}`}>
              <div className="ai-samples">
                {sampleQuestions.map((q) => (
                  <button key={q} className="chip" onClick={() => setAiQuestion(q)}>
                    {q}
                  </button>
                ))}
              </div>

              <div className="ai-input-row">
                <input
                  type="text"
                  placeholder={
                    aiMode === "general"
                      ? "Ask anything about company policy…"
                      : "Ask anything about employee records or sensitive docs…"
                  }
                  value={aiQuestion}
                  onChange={(e) => setAiQuestion(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && askAI()}
                />
                <button className="primary-btn" onClick={askAI} disabled={aiLoading}>
                  {aiLoading ? "Thinking…" : "Ask"}
                </button>
              </div>

              {aiAnswer && (
                <div className="ai-answer">
                  <span className="ai-answer-label">Answer</span>
                  <p>{aiAnswer}</p>
                </div>
              )}

              {aiHistory.length > 0 && (
                <div className="ai-history">
                  <span className="ai-history-label">Recent</span>
                  {aiHistory.map((h, i) => (
                    <div key={i} className="ai-history-item">
                      <span className={`badge ${h.mode === "general" ? "badge-teal" : "badge-amber"}`}>
                        <span className="badge-dot" />
                        {h.mode === "general" ? "Employee AI" : "HR & Admin AI"}
                      </span>
                      <p className="ai-history-q">{h.question}</p>
                      <p className="ai-history-a">{h.answer}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}

        {/* ---------------- DOC COMPARE TAB ---------------- */}
        {activeTab === "doc-compare" && (
          <section className="view">
            <div className="view-head" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20 }}>
              <div>
                <h1>Document Comparison</h1>
                <p>Upload two documents of any kind. AI detects what each one is and compares them — no document type to select.</p>
              </div>
              <button className="ghost-btn" onClick={() => setShowArch((s) => !s)}>
                {showArch ? "Hide" : "How this works"}
              </button>
            </div>

            {showArch && (
              <div className="card" style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.7 }}>
                <div style={{ color: "var(--text)", fontWeight: 600, marginBottom: 6 }}>Behind the scenes, on Databricks</div>
                <div><b style={{ color: "#e08a4b" }}>Bronze</b> — original PDFs/Word files land untouched in Unity Catalog local filess.</div>
                <div><b style={{ color: "#9aa4b2" }}>Silver</b> — <code>AI_PARSE_DOCUMENT()</code> extracts text, <code>AI_CLASSIFY()</code> detects the document type.</div>
                <div><b style={{ color: "var(--amber)" }}>Gold</b> — <code>AI_EXTRACT()</code> pulls structured fields and the comparison result, for Genie AI to query.</div>
              </div>
            )}

            <div className="card">
              <div className="dc-dropzone-grid">
                <div className={`dc-dropzone ${fileA ? "filled" : ""}`} onClick={() => inputA.current?.click()}>
                  <div className="dc-dropzone-label">Document A</div>
                  <div className="dc-dropzone-filename">{fileA ? fileA.name : "Click to choose a PDF or Word file"}</div>
                </div>
                <div className={`dc-dropzone ${fileB ? "filled" : ""}`} onClick={() => inputB.current?.click()}>
                  <div className="dc-dropzone-label">Document B</div>
                  <div className="dc-dropzone-filename">{fileB ? fileB.name : "Click to choose a PDF or Word file"}</div>
                </div>
                <input ref={inputA} type="file" accept=".pdf,.doc,.docx" style={{ display: "none" }} onChange={onPickDoc("a")} />
                <input ref={inputB} type="file" accept=".pdf,.doc,.docx" style={{ display: "none" }} onChange={onPickDoc("b")} />
              </div>

              <div className="form-actions" style={{ marginTop: 16 }}>
                <button className="primary-btn" disabled={!fileA || !fileB || dcStatus === "processing"} onClick={dcUpload}>
                  Upload &amp; Compare
                </button>
                {dcStatus !== "idle" && (
                  <button className="ghost-btn" onClick={dcReset}>Start over</button>
                )}
              </div>
            </div>

            {dcStatus === "error" && (
              <div className="card" style={{ borderLeft: "3px solid var(--danger)" }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Something went wrong</div>
                <div style={{ color: "var(--muted)", fontSize: 13.5 }}>{dcError}</div>
              </div>
            )}

            {dcStatus === "processing" && (
              <div className="card">
                <div className="dc-pipeline-grid">
                  {STAGES.map((s, i) => {
                    const active = i === dcStageIdx;
                    const done = i < dcStageIdx;
                    return (
                      <div key={s.key} className={`dc-pipeline-stage ${s.key} ${active ? "active" : ""}`} style={{ opacity: done || active ? 1 : 0.35 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1 }}>{s.label}</div>
                        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>{s.sub}</div>
                        <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 6 }}>{s.desc}</div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ textAlign: "center", marginTop: 14, fontSize: 12.5, color: "var(--muted)" }}>Talking to Databricks…</div>
              </div>
            )}

            {dcStatus === "mismatch" && dcResult && (
              <div className="card" style={{ borderLeft: "3px solid var(--amber)" }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>These documents belong to two different types</div>
                <div style={{ color: "var(--muted)", fontSize: 13.5, marginBottom: 14 }}>
                  Document A was detected as <b style={{ color: "var(--text)" }}>{dcResult.typeA}</b>, and Document B was detected as{" "}
                  <b style={{ color: "var(--text)" }}>{dcResult.typeB}</b>. Upload two documents of the same kind to see a comparison.
                </div>
                <DcMetaTable meta={dcResult.meta} />
              </div>
            )}

            {dcStatus === "results" && dcResult && (
              <>
                <div className="card">
                  <DcMetaTable meta={dcResult.meta} />
                </div>
                <div className="card">
                  <div style={{ fontWeight: 600, marginBottom: 10 }}>
                    {dcResult.diffs.length} difference{dcResult.diffs.length !== 1 ? "s" : ""} found between {dcResult.typeA} versions
                  </div>
                  {dcResult.summary && <p style={{ color: "var(--muted)", fontSize: 13.5, marginBottom: 14 }}>{dcResult.summary}</p>}
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {dcResult.diffs.map((d, i) => (
                      <div key={i} className="dc-diff-row">
                        <span className={`badge ${d.kind === "modified" ? "badge-amber" : d.kind === "added" ? "badge-teal" : "badge-muted"}`}>
                          <span className="badge-dot" />{d.kind}
                        </span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 4 }}>{d.field}</div>
                          {d.kind === "modified" && <div style={{ fontSize: 12.5, color: "var(--muted)" }}>{d.before} → {d.after}</div>}
                          {d.kind === "added" && <div style={{ fontSize: 12.5, color: "var(--muted)" }}>{d.after}</div>}
                          {d.kind === "removed" && <div style={{ fontSize: 12.5, color: "var(--muted)", textDecoration: "line-through" }}>{d.before}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div style={{ display: "flex", justifyContent: "center", marginTop: 6 }}>
                  <button className="primary-btn" onClick={() => setGenieOpen(true)}>Ask Genie AI about this comparison</button>
                </div>
              </>
            )}

            {genieOpen && dcResult && <GenieDrawer result={dcResult} onClose={() => setGenieOpen(false)} />}
          </section>
        )}
      </main>
    </div>
  );
}

function DcMetaTable({ meta }) {
  return (
    <table>
      <thead>
        <tr>{["Document ID", "Detected Type", "Version", "Uploaded By", "Upload Time"].map((h) => <th key={h}>{h}</th>)}</tr>
      </thead>
      <tbody>
        {meta.map((m) => (
          <tr key={m.id}>
            <td className="mono">{m.id}</td>
            <td><span className="badge badge-teal"><span className="badge-dot" />{m.type}</span></td>
            <td>{m.version}</td>
            <td>{m.by}</td>
            <td className="mono">{m.time}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function GenieDrawer({ result, onClose }) {
  const [messages, setMessages] = useState([
    { role: "genie", text: `I've read the comparison between ${result.meta[0].name} and ${result.meta[1].name}. Ask me anything about what changed.` },
  ]);
  const [input, setInput] = useState("");
  const send = (text) => {
    const q = (text ?? input).trim();
    if (!q) return;
    setMessages((m) => [...m, { role: "user", text: q }, { role: "genie", text: answerFromComparison(q, result) }]);
    setInput("");
  };
  return (
    <div className="dc-genie-drawer">
      <div className="dc-genie-header">
        <span>Ask Genie AI</span>
        <button className="icon-btn" onClick={onClose}>Close</button>
      </div>
      <div className="dc-genie-messages">
        {messages.map((m, i) => (
          <div key={i} className={`dc-genie-msg ${m.role}`}>{m.text}</div>
        ))}
      </div>
      <div className="ai-samples" style={{ padding: "0 16px" }}>
        {SUGGESTIONS.map((s) => <button key={s} className="chip" onClick={() => send(s)}>{s}</button>)}
      </div>
      <div className="ai-input-row" style={{ padding: 16 }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder="Ask anything…" />
        <button className="primary-btn" onClick={() => send()}>Send</button>
      </div>
    </div>
  );
}

export default App;
