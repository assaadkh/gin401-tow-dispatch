# GIN401 Lab Project — Roadside Assistance, Insurance Quota & Towing CAD System

An end-to-end 3-tier relational database application built for **GIN401** using **Microsoft SQL Server**, **C# (.NET 9 / Pure ADO.NET)**, and **React.js + Google Maps / OSRM**.

---

## 1. Architecture & Requirements Coverage

| Requirement Area | Implementation in This Project |
| :--- | :--- |
| **1. 3NF Normalization (19 Tables)** | Decomposes roadside operations into 19 normalized tables (`UserGroups`, `SystemUsers`, `InsuranceProviders`, `PlateCodes`, `Customers`, `Vehicles`, `InsurancePolicies`, `PolicyQuotaTiers`, `Drivers`, `TowTrucks`, `DriverTruckAssignments`, `Subcontractors`, `Tariffs`, `TowRequests`, `TowInvoices`, `InvoicePayments`, `TowAuditLogs`, `AuditChangeEvents`, `AuditChangeDetails`) seeded with **120,000+ `TowRequests`**, **120,000+ `TowInvoices`**, and **148,000+ `InvoicePayments`**. |
| **2. Configuration Hub (`Users`, `User Groups`, `Tow Trucks`, `Drivers`)** | Unified **Configuration** module with master-detail sheets (`List -> Click Row -> Related 3NF Info`), separating `dbo.UserGroups` (permissions) from `dbo.SystemUsers` (`GroupId` FK) and separating `dbo.Drivers` from `dbo.TowTrucks` (operational shifts managed on the Dispatch Board via `dbo.DriverTruckAssignments`). |
| **3. Historical Tariffs & Invoice Snapshots** | `dbo.Tariffs` stores effective date windows, base fees, per-KM rates, and night surcharges. `dbo.TowInvoices` references `TariffId` and snapshots charged amounts (`AppliedBaseFee`, `AppliedPricePerKm`, `AppliedNightSurcharge`), protected by `dbo.trg_TowInvoices_ProtectHistoricalPricing` so tariff updates never alter historical invoices. |
| **4. Separate Insurer vs. Customer Payments** | `dbo.TowInvoices` tracks `InsurerBilledAmount` / `InsurerPaidAmount` / `InsurerBalanceDue` separately from `CustomerBilledAmount` / `CustomerPaidAmount` / `CustomerBalanceDue`. Each partial or full payment is stored as its own row in `dbo.InvoicePayments`. |
| **5. BCrypt + 3NF `UserGroups` RBAC + `EXECUTE`-Only SQL Security** | `dbo.SystemUsers` uses **BCrypt (`cost = 12`)** (`BCrypt.Net-Next`) with no separate `PasswordSalt` column and inherits permissions from `dbo.UserGroups (GroupId)` (`CanDispatch`, `CanManageFleet`, `CanManagePolicies`, `CanManageBilling`, `CanManageUsers`). `db_tow_dispatcher_role` (`tow_cad_app_login`) has **zero direct table/view permissions** and **`EXECUTE` permissions ONLY on 35 authorized `dbo.usp_*` stored procedures**, called via 100% parameterized `ADO.NET`. |
| **6. `SESSION_CONTEXT` Auditing & Odoo-Style Change Logs** | Every authenticated database connection calls `dbo.usp_SetDispatcherSessionContext` to set and validate `SESSION_CONTEXT` (`AppUserId`, `AppUsername`, `AppFullName`). Set-based triggers populate `dbo.TowAuditLogs` AND normalized `dbo.AuditChangeEvents` + `dbo.AuditChangeDetails` (`FieldName`, `OldValue`, `NewValue`, `ChangedAt`), surfaced as plain Odoo-style Change Logs inside every record Info view and per section. |
| **7. Validated Road-Distance Routing** | Integrates live **OSRM** road-network routing (`OSRM_DrivingRoute`) plus a validated dispatcher road-distance override (`DispatcherVerifiedEstimate`) and explicit fallback (`HeuristicFallbackEstimate`) alongside `StraightLineDistanceKm`—never presenting straight-line Haversine distance as driving distance. |
| **8. High-Volume Indexing (>120k Rows)** | Revised covering and filtered nonclustered indexes across `TowRequests`, `Vehicles`, and `TowInvoices` achieving **Index Seeks, 0 Key Lookups, and 0 Sort operators (`0–1 ms` SQL CPU/elapsed)** on the final actual execution plans. |

---

## 2. How to Run the Project

### Step 1: Initialize the SQL Server Database (19 Normalized 3NF Tables + >120,000 Rows)
Run the 5 SQL scripts in order against your local SQL Server (`localhost`) using `sqlcmd` or SSMS:

```powershell
sqlcmd -S localhost -E -I -b -i "sql\01_create_schema_and_indexes.sql"
sqlcmd -S localhost -E -I -b -i "sql\02_programmability_logic.sql"
sqlcmd -S localhost -E -I -b -i "sql\03_seed_120k_data.sql"
sqlcmd -S localhost -E -I -b -v APP_DB_PASSWORD="YourPasswordHere" -i "sql\04_security_least_privilege.sql"
sqlcmd -S localhost -E -I -b -i "sql\05_performance_and_concurrency_tests.sql"
```

### Step 2: Configure Environment Variable (`.env`)
Copy [`backend/.env.example`](backend/.env.example) to `backend/.env` and set your least-privilege connection string:
```ini
TOW_DB_CONNECTION_STRING=Server=localhost;Database=GIN401_TowDispatch;User Id=tow_cad_app_login;Password=YourPasswordHere;TrustServerCertificate=True;
TRACKER_TOKEN_SECRET=Your64HexCharacterSessionSecretHere
```

### Step 3: Build & Start the Application

**Sequential Production Build Order** (always build `frontend` before `backend` because Vite outputs into `backend/wwwroot`):
```powershell
cd frontend
npm run build
cd ..\backend
dotnet build -c Release
```

**Start the Unified Web API + CAD Portal (`http://localhost:5050`):**
Double-click [`start_app.bat`](start_app.bat) or run:
```powershell
cd backend
dotnet run --urls "http://localhost:5050"
```
Then open **[http://localhost:5050](http://localhost:5050)** in your browser.

### Seeded Command Desk Operator Credentials (BCrypt Cost=12)

| Operator Username | Password | Role & Group | Station |
| :--- | :--- | :--- | :--- |
| `assaad.khalife` | `Tracker@2026` | System Administrators (`ADMIN`) | `BEY-CMD-01` |
| `dispatch.beirut` | `Dispatch@2026` | Emergency Roadside Dispatchers (`DISPATCHER`) | `BEY-DSK-04` |
| `fleet.manager` | `Fleet@2026` | Fleet & Recovery Supervisors (`FLEET_MANAGER`) | `BEY-FLT-02` |
| `claims.underwriter` | `Claims@2026` | Insurance Policy & Claims Underwriters (`UNDERWRITER`) | `BEY-INS-01` |

---

## 3. Repository Structure
* [`sql/01_create_schema_and_indexes.sql`](sql/01_create_schema_and_indexes.sql) — Database, 19 normalized 3NF tables (`UserGroups`, `SystemUsers`, `AuditChangeEvents`, `AuditChangeDetails`, etc.), sequences, constraints, and revised covering/filtered indexes
* [`sql/02_programmability_logic.sql`](sql/02_programmability_logic.sql) — Scalar/TVF functions, 13 set-based `SESSION_CONTEXT` audit & historical pricing triggers, analytical views, and 35 `dbo.usp_*` stored procedures
* [`sql/03_seed_120k_data.sql`](sql/03_seed_120k_data.sql) — Normalized `UserGroups`, BCrypt operator accounts, vehicles, drivers, assignments, tariffs, 120,000+ `TowRequests`, 120,000+ `TowInvoices`, and 148,000+ `InvoicePayments`
* [`sql/04_security_least_privilege.sql`](sql/04_security_least_privilege.sql) — Least-privilege login (`tow_cad_app_login`) and `EXECUTE`-only role (`db_tow_dispatcher_role`) across all 35 authorized procedures
* [`sql/05_performance_and_concurrency_tests.sql`](sql/05_performance_and_concurrency_tests.sql) — Final actual execution plans on >120k rows and automated business-rule/security verification suite
* [`backend/Program.cs`](backend/Program.cs) — Standalone C# .NET 9 ADO.NET backend (`CommandType.StoredProcedure` + BCrypt + `SESSION_CONTEXT` + OSRM routing)
* [`frontend/src/App.jsx`](frontend/src/App.jsx) — Standalone React.js CAD Dispatch, Configuration Hub (`Users`, `User Groups`, `Tow Trucks`, `Drivers`), Tariffs, Split Billing, Concurrency, Domain Archive Search, and Odoo-Style Change Logs
* [`REPORT.md`](REPORT.md) & [`GIN401_Lab_Project_Report.docx`](GIN401_Lab_Project_Report.docx) — Complete technical report, 19-table 3NF ERD, final actual execution plans, test results, and AI usage disclaimer
