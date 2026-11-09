# GIN401 — Advanced Database Systems: Lab Project Proposal

**Project Title:** Roadside Assistance, Insurance Quota & Computer-Aided Towing Dispatch (CAD) System  
**Course:** GIN401 — Lab Project  
**Student / GitHub Account:** Assaad Khalife (`assaadkh`)  
**Repository:** [https://github.com/assaadkh/gin401-tow-dispatch](https://github.com/assaadkh/gin401-tow-dispatch)  
**Technology Stack:** Microsoft SQL Server (`T-SQL`) • Standalone C# (.NET 9 Web API with Pure `ADO.NET` / `Microsoft.Data.SqlClient`) • Standalone React.js + Google Maps / OSRM CAD UI  

---

## 1. Executive Summary & Real-World Problem Statement
Roadside assistance and towing dispatch centers in Lebanon manage thousands of emergency breakdown and accident calls on behalf of major insurance providers (e.g., *Bankers Assurance*, *LIA Assurex*, *Fidelity*, *Allianz SNA*). Dispatchers must simultaneously:
1. Identify the caller (via Telephony Caller-ID) and match their active insurance policy.
2. Evaluate complex **sequential insurance coverage tiers** (Mechanical vs. Accident vs. Winch quotas, maximum covered kilometers, overage billing per kilometer, and mandatory **cooldown days between tows**).
3. Enforce strict **Lebanese vehicle license plate rules** (mandatory plate code letter such as `G`, `B`, `M`, `Z` plus digits, or explicit `NO-PLATE` unregistered showroom handling).
4. Dispatch the optimal tow truck on a **Live Google Maps CAD interface** with real-time traffic, OSRM road-network polylines, and multi-stop truck priority queues (`1P → 1D → 2P → 2D`) without allowing two concurrent dispatchers to double-assign the same job or exceed a customer's remaining policy quota.
5. Enforce **financial and audit immutability** once a tow reaches a finalized state (`Done`, `UnableToLoad`, or `Rejected`), and accurately compute **driver payroll, night-shift overtime (19:00–07:00), off-day bonuses, and on-scene cash deductions**.

This project proposes and implements a **standalone, high-concurrency, 3-tier enterprise application** backed by **Microsoft SQL Server (`GIN401_TowDispatch`)** where all core domain invariants, concurrency locks, and high-volume analytics (>120,000 rows) are enforced directly inside the database engine.

---

## 2. Proposed System Architecture
The system is designed as a standalone 3-tier architecture without any external ORM (no Entity Framework) to demonstrate mastery of native T-SQL and `ADO.NET`:

```
┌────────────────────────────────────────────────────────────────────────────┐
│                   PRESENTATION TIER (React.js + Google Maps)               │
│  • Google Maps Road/Traffic/Hybrid CAD Map + OSRM Real Road Polylines      │
│  • Slide-Over Fleet & Ongoing Jobs Drawer with Stop Priority Reordering    │
│  • Built-In Lebanon Location Picker Modal (Photon/Nominatim + Reverse Geo) │
│  • Telephony Call Pop-Up, Logical Kanban Board & Concurrency/Perf Labs   │
└────────────────────────────────────┬───────────────────────────────────────┘
                                     │ REST JSON over HTTP
                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│               APPLICATION TIER (C# .NET 9 Web API + ADO.NET)               │
│  • 100% Parameterized SqlCommand & SqlParameter (Zero String Concat)       │
│  • Multi-Threaded Concurrency Race Simulator (Task.WhenAll)                │
│  • Least-Privilege Connection Factory (Reads Credentials from .env)        │
└────────────────────────────────────┬───────────────────────────────────────┘
                                     │ TDS Protocol (Microsoft.Data.SqlClient)
                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│              DATABASE TIER (Microsoft SQL Server: GIN401_TowDispatch)      │
│  • 8 Relational Tables (120,007 Rows in dbo.TowRequests)                   │
│  • 5 Stored Procedures, 2 Functions (Scalar + TVF), 1 AFTER Trigger,       │
│    2 Analytical Views (Window Functions & Payroll Aggregation)             │
│  • Pessimistic Locking (UPDLOCK, ROWLOCK) + Optimistic (ROWVERSION)        │
│  • 4 Covering Nonclustered Indexes (Index Seek, 0 Key Lookups, 0 Sort)     │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Database Schema & Integrity Constraints Plan (10 Points)
The database `GIN401_TowDispatch` consists of **8 normalized tables** in Third Normal Form (3NF) enforcing real business rules via `PRIMARY KEY`, `FOREIGN KEY`, `UNIQUE`, `NOT NULL`, and `CHECK` constraints:

| # | Table Name | Core Role | Enforced Constraints & Business Rules |Target Row Volume |
|---|---|---|---|---|
| 1 | `dbo.InsuranceProviders` | Insurance companies | `UNIQUE (ProviderCode)`, `CHECK (DefaultExtraKmRate >= 0)` | 4 rows |
| 2 | `dbo.PlateCodes` | Lebanese plate prefixes (`G`, `B`, `M`, `O`, etc.) | `UNIQUE (CodeLetter)`, `CHECK (LEN(TRIM(CodeLetter)) >= 1)` | 8+ rows (extensible) |
| 3 | `dbo.Customers` | Vehicle owners & Caller-ID lookup | `FK -> PlateCodes`, `CK_Customers_PlateRule` (requires `PlateCodeID` unless `NoPlate = 1`) | 2,005 rows |
| 4 | `dbo.InsurancePolicies` | Annual policies & quota counters | `UNIQUE (PolicyNumber)`, `CK_Policies_DateOrder`, `CK_Policies_QuotaBounds` (`Used <= Max`) | 2,005 rows |
| 5 | `dbo.PolicyQuotaTiers` | Sequential coverage tiers & cooldown rules | `UNIQUE (PolicyID, SequenceOrder)`, `CHECK (MinIntervalDays >= 0)` | 10+ rows |
| 6 | `dbo.TowTrucks` | Fleet GPS, driver payroll & off-day status | `CK_TowTrucks_Status`, `CK_TowTrucks_LebanonLat/Lng`, `BaseMonthlySalary`, `OvertimeRatePerTow` | 8 rows |
| 7 | **`dbo.TowRequests`** | **Core CAD dispatch & financial ledger** | **7 `CHECK` constraints** (`Status`, `IncidentType`, `PlateRule`, `NonNegDistance`, `NonNegMoney`, `SubcontractorRule`), **`RowVersionToken ROWVERSION`** | **120,007 rows (>100k requirement)** |
| 8 | `dbo.TowAuditLogs` | Immutable audit trail | Populated automatically by `dbo.trg_TowRequests_ImmutabilityAndAudit` | Dynamic |

---

## 4. T-SQL Programmability Plan (10 Points)
All core business logic is implemented inside SQL Server rather than in application memory:
1. **Scalar Function (`dbo.fn_CalculateRoadDistanceKm`):** Computes geodesic Haversine distance multiplied by a `1.28` Lebanese mountain/coastal road winding factor.
2. **Inline Table-Valued Function (`dbo.tvf_CheckPolicyEligibility`):** Evaluates policy expiration, sequential tier matching (`dbo.PolicyQuotaTiers`), remaining Mechanical vs. Accident tow quotas, covered distance, extra kilometer charges, and **cooldown days passed (`DATEDIFF(DAY, LastTowDate, SYSDATETIME()) < MinIntervalDays`)**.
3. **Database Trigger (`dbo.trg_TowRequests_ImmutabilityAndAudit`):**
   - Blocks any `DELETE` on `dbo.TowRequests` (`RAISERROR 50001`).
   - Blocks any status reversal or financial edit once a tow reaches a finalized state (`Done`, `UnableToLoad`, `Rejected`) (`RAISERROR 50002`).
   - Automatically records every state change into `dbo.TowAuditLogs`.
4. **Window Functions Views:**
   - `dbo.vw_FleetPriorityQueueAndRankings`: Uses `ROW_NUMBER() OVER (PARTITION BY AssignedTruckID ORDER BY QueuePosition)`, `SUM(DistanceKm) OVER (PARTITION BY AssignedTruckID)`, and `COUNT(*) OVER (...)`.
   - `dbo.vw_DriverPayrollAndCashReport`: Computes driver base salary, night-shift (`19:00–07:00`) and off-day overtime tow counts, earned overtime bonuses, on-scene cash deductions, and net payout.
5. **Stored Procedures:**
   - `dbo.usp_CreateTowRequest`
   - `dbo.usp_ApproveAndDispatchTow`
   - `dbo.usp_UpdateTowLifecycleStatus`
   - `dbo.usp_UpdateDraftTowOptimistic`
   - `dbo.usp_ReorderTruckJobQueue`

---

## 5. Transactions & Concurrency Control Plan (10 Points)
To prevent race conditions when multiple dispatchers operate simultaneously:
1. **Explicit ACID Transactions:** Every multi-table operation uses `SET XACT_ABORT ON`, `BEGIN TRANSACTION`, `TRY...CATCH`, and safe `IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION`.
2. **Pessimistic Locking (`WITH (UPDLOCK, ROWLOCK)`):** Inside `dbo.usp_ApproveAndDispatchTow`, the target `TowRequests` row and `InsurancePolicies` row are locked with `UPDLOCK, ROWLOCK` before checking status and remaining quota. If Dispatcher A and Dispatcher B click "Approve & Dispatch" at the exact same millisecond, Thread B waits on the row lock and cleanly aborts with Error `50004` once Thread A commits.
3. **Optimistic Concurrency (`ROWVERSION`):** `dbo.TowRequests` includes `RowVersionToken ROWVERSION`. `dbo.usp_UpdateDraftTowOptimistic` verifies `WHERE RequestID = @RequestID AND RowVersionToken = @ExpectedRowVersion`, raising Error `50008` (HTTP `409 Conflict`) if another user modified the row.

---

## 6. High-Volume Performance & Indexing Plan (10 Points)
With **120,007 rows** in `dbo.TowRequests`, we design **4 covering nonclustered indexes** so our key operational and analytical queries execute with **Index Seek, 0 Key Lookups, and 0 Sort**:
1. `IX_TowRequests_Status_CreatedAt_Covering` on `(Status ASC, CreatedAt DESC) INCLUDE (RequestNumber, PolicyID, CustomerID, AssignedTruckID, IncidentType, DistanceKm, ExtraChargeAmount, CashCollectedByDriver, IsNightShiftOvertime, PlateNumber)`.
2. `IX_TowRequests_ActiveTruckQueue` filtered on `(AssignedTruckID ASC, QueuePosition ASC) WHERE Status IN ('Approved', 'InProgress')`.
3. `IX_TowRequests_PolicyID_Status_CreatedAt` on `(PolicyID ASC, Status ASC, CreatedAt DESC) INCLUDE (IncidentType, DistanceKm, ExtraChargeAmount)`.
4. `IX_TowRequests_PlateNumber_CreatedAt` on `(PlateNumber ASC, CreatedAt DESC) INCLUDE (Status, PolicyID, IncidentType, PickupAddress)`.

All queries use **SARGable predicates** (`CreatedAt >= @Start AND CreatedAt < @End` rather than `YEAR(CreatedAt) = 2026`).

---

## 7. Security & Least-Privilege Architecture Plan (10 Points)
1. **100% Parameterized Queries:** Every SQL call in [`backend/Program.cs`](file:///c:/Users/user/Desktop/Uni/gin401/project/backend/Program.cs) uses `SqlCommand` with explicit `SqlParameter` types (`SqlDbType.NVarChar`, `SqlDbType.DateTime2`, `SqlDbType.Int`, `SqlDbType.Binary`). Classic payloads such as `' OR 1=1 --` are treated strictly as literal text.
2. **Dedicated Least-Privilege SQL Server Login & Role:**
   - Login: `tow_cad_app_login` → Database User: `tow_cad_app_user` → Role: `db_tow_dispatcher_role`.
   - Granted `SELECT` and `EXECUTE` only on required tables, views, functions, and stored procedures.
   - Explicitly restricted with `DENY DELETE ON SCHEMA::dbo` and zero DDL (`ALTER`/`DROP`) or `sysadmin` privileges.
3. **Zero Hardcoded Passwords in Source Code:** Database credentials are loaded from gitignored `backend/.env` (with `backend/.env.example` committed as a template).

---

## 8. Project Milestones & Deliverables
1. **Milestone 1 — Schema, Constraints & >120k Data Seeding:** `sql/01_create_schema_and_indexes.sql` & `sql/03_seed_120k_data.sql` *(Completed)*
2. **Milestone 2 — T-SQL Programmability, Triggers & Views:** `sql/02_programmability_logic.sql` *(Completed)*
3. **Milestone 3 — Security & Performance Verification Scripts:** `sql/04_security_least_privilege.sql` & `sql/05_performance_and_concurrency_tests.sql` *(Completed)*
4. **Milestone 4 — Standalone C# ADO.NET Web API & React CAD UI:** `backend/Program.cs` & `frontend/src/App.jsx` *(Completed)*
5. **Milestone 5 — Technical Report & Defense Demo:** `REPORT.md`, `PROJECT_PROPOSAL.md`, and live interactive lab tabs *(Completed)*
