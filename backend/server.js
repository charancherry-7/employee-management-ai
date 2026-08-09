const express = require("express");
const cors = require("cors");
const connectDB = require("./db");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 5000;

// ---- AI / Databricks Model Serving config ----
const DATABRICKS_HOST = "https://dbc-d936181c-d4dd.cloud.databricks.com";
const DATABRICKS_TOKEN = process.env.DATABRICKS_TOKEN;
const RAG_ENDPOINT = "/serving-endpoints/employee-rag-agent-endpoint/invocations";

async function callRagAgent(question, mode) {
  const response = await fetch(`${DATABRICKS_HOST}${RAG_ENDPOINT}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${DATABRICKS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      dataframe_split: {
        columns: ["question", "mode"],
        data: [[question, mode]]
      }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text);
  }

  const data = await response.json();
  return data.predictions[0]["0"] || data.predictions[0];
}

console.log("Server starting...");

// GET all employees
app.get("/employees", async (req, res) => {
  try {
    const session = await connectDB();

    const operation = await session.executeStatement(`
      SELECT *
      FROM employee_management.fullstack.employees
      ORDER BY employee_id
    `);

    const rows = await operation.fetchAll();

    await operation.close();
    await session.close();

    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Database Error" });
  }
});

// GET single employee by ID
app.get("/employees/:id", async (req, res) => {
  try {
    const session = await connectDB();
    const id = req.params.id;

    const operation = await session.executeStatement(`
      SELECT *
      FROM employee_management.fullstack.employees
      WHERE employee_id = ${id}
    `);

    const rows = await operation.fetchAll();

    await operation.close();
    await session.close();

    if (rows.length === 0) {
      return res.status(404).json({ message: "Employee Not Found" });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Database Error" });
  }
});

// ADD employee
app.post("/employees", async (req, res) => {
  try {
    const session = await connectDB();
    const emp = req.body;

    const idOperation = await session.executeStatement(`
      SELECT COALESCE(MAX(employee_id), 0) + 1 AS new_id
      FROM employee_management.fullstack.employees
    `);
    const idResult = await idOperation.fetchAll();
    const newId = idResult[0].new_id;
    await idOperation.close();

    const insertOperation = await session.executeStatement(`
      INSERT INTO employee_management.fullstack.employees
      (
        employee_id, first_name, last_name, email, phone,
        department, designation, salary, date_of_joining, status,
        created_at, updated_at
      )
      VALUES
      (
        ${newId},
        '${emp.first_name}',
        '${emp.last_name}',
        '${emp.email}',
        '${emp.phone}',
        '${emp.department}',
        '${emp.designation}',
        ${emp.salary},
        '${emp.date_of_joining}',
        '${emp.status}',
        current_timestamp(),
        current_timestamp()
      )
    `);

    await insertOperation.close();
    await session.close();

    res.json({ message: "Employee Added Successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Database Error" });
  }
});

// UPDATE employee
app.put("/employees/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const emp = req.body;
    const session = await connectDB();

    const operation = await session.executeStatement(`
      UPDATE employee_management.fullstack.employees
      SET
        first_name = '${emp.first_name}',
        last_name = '${emp.last_name}',
        email = '${emp.email}',
        phone = '${emp.phone}',
        department = '${emp.department}',
        designation = '${emp.designation}',
        salary = ${emp.salary},
        date_of_joining = '${emp.date_of_joining}',
        status = '${emp.status}',
        updated_at = current_timestamp()
      WHERE employee_id = ${id}
    `);

    await operation.close();
    await session.close();

    res.json({ success: true, message: "Employee Updated Successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database Error" });
  }
});

// DELETE employee
app.delete("/employees/:id", async (req, res) => {
  try {
    const id = req.params.id;
    console.log("Deleting Employee:", id);
    const session = await connectDB();

    const operation = await session.executeStatement(`
      DELETE FROM employee_management.fullstack.employees
      WHERE employee_id = ${id}
    `);

    await operation.close();
    await session.close();

    console.log("Delete Success");
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json(err);
  }
});

// ---- AI routes ----
app.post("/api/ai/ask-general", async (req, res) => {
  try {
    const answer = await callRagAgent(req.body.question, "general");
    res.json({ answer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "AI service error" });
  }
});

app.post("/api/ai/ask-hr", async (req, res) => {
  try {
    const answer = await callRagAgent(req.body.question, "restricted");
    res.json({ answer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "AI service error" });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});