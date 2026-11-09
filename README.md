# GIN401 Lab Project — Roadside Assistance, Insurance Quota & Towing CAD System

An end-to-end database application built for **GIN401** using **Microsoft SQL Server**, **C# (.NET 9 / ADO.NET)**, and **React.js**.

---

## 1. Architecture & Grading Criteria Coverage

| GIN401 Criterion | Implementation in This Project |
| :--- | :--- |
| **1. Database Design (10 pts)** | **8 normalized tables** (`InsuranceProviders`, `PlateCodes`, `Customers`, `InsurancePolicies`, `PolicyQuotaTiers`, `TowTrucks`, `TowRequests`, `TowAuditLogs`) with `PRIMARY KEY`, `FOREIGN KEY`, `UNIQUE`, `NOT NULL`, `CHECK` constraints, `ROWVERSION`, and **120,007 rows** in `dbo.TowRequests`. |
| **2. T-SQL Logic (10 pts)** | Scalar function (`dbo.fn_CalculateRoadDistanceKm`), Table-Valued function (`dbo.tvf_CheckPolicyEligibility`), Trigger (`dbo.trg_TowRequests_ImmutabilityAndAudit`), Window Function View (`dbo.vw_FleetPriorityQueueAndRankings` using `ROW_NUMBER()`, `SUM() OVER()`, `COUNT() OVER()`), and 4 Stored Procedures (`usp_CreateTowRequest`, `usp_ApproveAndDispatchTow`, `usp_UpdateTowLifecycleStatus`, `usp_UpdateDraftTowOptimistic`). |
| **3. Transactions & Concurrency (10 pts)** | Multi-step changes wrapped in `BEGIN TRAN` + `TRY…CATCH` + `ROLLBACK`. Handles two simultaneous dispatchers using **Pessimistic Locking** (`WITH (UPDLOCK, ROWLOCK)` on policy quota tiers) and **Optimistic Concurrency** (`ROWVERSION` binary token comparison). |
| **4. Performance (10 pts)** | 4 nonclustered covering indexes (`INCLUDE` columns + matching `ORDER BY` key order) on the 120,007-row `dbo.TowRequests` table achieving **Index Seek, 0 Key Lookups, 0 Sort operators, and only 3 logical page reads (< 5 ms)**. |
| **5. Security (10 pts)** | 100% parameterized queries (`SqlCommand.Parameters`), dedicated least-privilege login (`tow_cad_app_login` / `db_tow_dispatcher_role` with `DENY DELETE` and `IsSysAdmin = 0`), and connection string loaded from `.env` (gitignored, zero passwords in source code). |
| **6. Application (20 pts)** | Standalone C# ADO.NET Web API + React.js CAD interface with interactive Lebanon Leaflet map, live policy quota/cooldown validator, dispatch board, 2-user race condition simulator, and >120k-row performance & SQL injection lab. |

---

## 2. How to Run the Project

### Step 1: Initialize the SQL Server Database (Create Schema + Seed >120,000 Rows)
Run the 5 SQL scripts in order against your local SQL Server (`localhost`) using `sqlcmd` or SSMS:

```powershell
sqlcmd -S localhost -E -I -b -i "sql\01_create_schema_and_indexes.sql"
sqlcmd -S localhost -E -I -b -i "sql\02_programmability_logic.sql"
sqlcmd -S localhost -E -I -b -i "sql\03_seed_120k_data.sql"
sqlcmd -S localhost -E -I -b -v APP_DB_PASSWORD="TowApp_2026!Secure#Login" -i "sql\04_security_least_privilege.sql"
sqlcmd -S localhost -E -I -b -i "sql\05_performance_and_concurrency_tests.sql"
```

### Step 2: Configure Environment Variable (`.env`)
Copy [`backend/.env.example`](backend/.env.example) to `backend/.env` and set your connection string (already configured locally):
```ini
TOW_DB_CONNECTION_STRING=Server=localhost;Database=GIN401_TowDispatch;User Id=tow_cad_app_login;Password=YourPasswordHere;TrustServerCertificate=True;
```

### Step 3: Start the Application
**Option A — 1-Click Start (Serves both API and built React Frontend on `http://localhost:5050`):**
Double-click [`start_app.bat`](start_app.bat) or run:
```powershell
cd backend
dotnet run --urls "http://localhost:5050"
```
Then open **[http://localhost:5050](http://localhost:5050)** in your browser.

**Option B — Run React Vite Dev Server Separately (Port `5173`):**
```powershell
cd frontend
npm install
npm run dev
```

---

## 3. Repository Structure
* [`sql/01_create_schema_and_indexes.sql`](sql/01_create_schema_and_indexes.sql) — Database, 8 tables, constraints, and covering indexes
* [`sql/02_programmability_logic.sql`](sql/02_programmability_logic.sql) — Functions, triggers, window views, and transactional stored procedures
* [`sql/03_seed_120k_data.sql`](sql/03_seed_120k_data.sql) — Reference data + 120,007 rows in `dbo.TowRequests`
* [`sql/04_security_least_privilege.sql`](sql/04_security_least_privilege.sql) — Least-privilege login (`tow_cad_app_login`) and role (`db_tow_dispatcher_role`)
* [`sql/05_performance_and_concurrency_tests.sql`](sql/05_performance_and_concurrency_tests.sql) — Execution plan and business rule verification queries
* [`backend/Program.cs`](backend/Program.cs) — Standalone C# 9 ADO.NET backend (`Microsoft.Data.SqlClient`)
* [`frontend/src/App.jsx`](frontend/src/App.jsx) — Standalone React.js CAD Dispatch frontend
* [`REPORT.md`](REPORT.md) — Full project report, ERD, execution plans, test results, and AI usage disclaimer
