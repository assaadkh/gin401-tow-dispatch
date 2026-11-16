# GIN401 — Advanced Database Systems: Lab Project Proposal

**Project Title:** Roadside Assistance, Insurance Quota & Computer-Aided Towing Dispatch (CAD) System  
**Course:** GIN401 — Lab Project  
**Student / GitHub Account:** Assaad Khalife (`assaadkh`)  
**Repository:** [https://github.com/assaadkh/gin401-tow-dispatch](https://github.com/assaadkh/gin401-tow-dispatch)  
**Technology Stack:** Microsoft SQL Server (`T-SQL`) • Standalone C# (.NET 9 Web API with Pure `ADO.NET` / `Microsoft.Data.SqlClient` + `BCrypt.Net-Next`) • Standalone React.js + Google Maps / OSRM CAD UI  

---

## 1. Executive Summary & Real-World Problem Statement
Roadside assistance and towing dispatch centers in Lebanon manage thousands of emergency breakdown and accident calls on behalf of major insurance providers (*Bankers Assurance*, *LIA Assurex*, *Fidelity*, *AXA Middle East*, *Allianz SNA*, *Medgulf*). Dispatchers must simultaneously:
1. Identify the caller and normalized vehicle (`dbo.Vehicles`) and match their active insurance policy (`dbo.InsurancePolicies`).
2. Evaluate **sequential insurance coverage tiers** (`dbo.PolicyQuotaTiers` for Mechanical vs. Accident/Winch quotas, covered kilometers, and mandatory **cooldown intervals between tows**).
3. Calculate real driving distance via **OSRM road-network routing** (`OSRM_DrivingRoute`) or an explicitly validated road-distance workflow (`DispatcherVerifiedEstimate` / `HeuristicFallbackEstimate`), never presenting straight-line geodesic distance as driving distance.
4. Apply active rate schedules from **`dbo.Tariffs`** onto **`dbo.TowInvoices`** so historical invoice pricing remains immutable when tariffs change, while tracking **Insurer receivables separately from Customer overage/direct obligations** across individual partial or full payment records in **`dbo.InvoicePayments`**.
5. Dispatch internal GPS-tracked tow trucks (`dbo.TowTrucks`) decoupled from normalized **`dbo.Drivers`** via historical **`dbo.DriverTruckAssignments`**, or outsource to external **`dbo.Subcontractors`**, with full **`SESSION_CONTEXT`** dispatcher audit attribution in **`dbo.TowAuditLogs`**.

---

## 2. System Architecture (Pure ADO.NET + `EXECUTE`-Only Stored Procedures)

```text
┌────────────────────────────────────────────────────────────────────────────┐
│                   PRESENTATION TIER (React.js + Google Maps)               │
│  • Live Fleet CAD Map + Multi-Stop Truck Queue Reordering                  │
│  • Normalized Call Desk (Vehicles, Subcontractors, OSRM & Tariff Preview)  │
│  • Drivers & Assignment History, Tariffs Catalog & Split Invoice Payments  │
│  • Concurrency Lab, SESSION_CONTEXT Audit Trail & >120k Archive Search     │
└────────────────────────────────────┬───────────────────────────────────────┘
                                     │ REST JSON over HTTP (Bearer Token)
                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│               APPLICATION TIER (C# .NET 9 Web API + ADO.NET)               │
│  • BCrypt (Cost=12) Authentication (Zero Separate PasswordSalt Column)     │
│  • Sets & Validates SQL SESSION_CONTEXT on Every Pooled Connection         │
│  • 100% Parameterized CommandType.StoredProcedure Calls + OSRM Client      │
└────────────────────────────────────┬───────────────────────────────────────┘
                                     │ TDS Protocol (tow_cad_app_login)
                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│              DATABASE TIER (Microsoft SQL Server: GIN401_TowDispatch)      │
│  • 16 Normalized 3NF Tables (120,000+ TowRequests & TowInvoices)           │
│  • EXECUTE-Only Role (db_tow_dispatcher_role) Across 24 Stored Procedures  │
│  • Pessimistic Locking (UPDLOCK, ROWLOCK) + Optimistic (ROWVERSION)        │
│  • Revised Covering & Filtered Indexes (Final Execution Plans: 0–1 ms)     │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Normalized 3NF Database Schema (16 Tables)

| # | Table Name | Core Role & Normalized Responsibility | Key Enforced Constraints | Seeded Volume |
|---|---|---|---|---|
| 1 | `dbo.SystemUsers` | Dispatch operators, BCrypt hashes & granular RBAC permissions | `UNIQUE (Username)`, `CK_SystemUsers_BcryptFormat`, `CK_SystemUsers_AccessRole` | 4+ operators |
| 2 | `dbo.InsuranceProviders` | Partner insurance companies | `UNIQUE (ProviderName)` | 6 insurers |
| 3 | `dbo.PlateCodes` | Lebanese regional plate prefixes (`B`, `M`, `G`, ...) | `UNIQUE (Code)` | 10 codes |
| 4 | `dbo.Customers` | Policyholders & callers | `UNIQUE (Phone)` | 2,000 rows |
| 5 | `dbo.Vehicles` | Normalized vehicle plate, model & owner | `CK_Vehicles_PlateRule`, filtered `UX_Vehicles_RegisteredPlate` | 4,000 rows |
| 6 | `dbo.InsurancePolicies` | Policy headers & validity dates | `UNIQUE (PolicyNumber)`, `CK_Policies_Dates`, `ROWVERSION` | 1,500 rows |
| 7 | `dbo.PolicyQuotaTiers` | Sequential Mechanical/Accident quota tiers | `CK_QuotaTiers_Bounds` (`UsedTows <= AllowedTows`), `ROWVERSION` | 2,600+ rows |
| 8 | `dbo.Drivers` | Standalone driver HR, phone & overtime rates | `UNIQUE (EmployeeCode)`, `UNIQUE (Phone)` (1-row phone update) | 10 drivers |
| 9 | `dbo.TowTrucks` | Pure tow truck hardware & live GPS telemetry | `UNIQUE (TruckCode)`, `UNIQUE (LicensePlate)`, Lebanon GPS `CHECK`s | 8 trucks |
| 10 | `dbo.DriverTruckAssignments` | Historical & active driver-truck assignments | `StartDate`/`EndDate` + filtered `UX` (`WHERE EndDate IS NULL`) | 12+ rows |
| 11 | `dbo.Subcontractors` | External towing partners | `UNIQUE (CompanyName)`, `DefaultDispatchFee >= 0` | 5 partners |
| 12 | `dbo.Tariffs` | Historical & active service pricing schedules | `UNIQUE (TariffCode)`, `EffectiveFrom <= EffectiveTo` | 4 tariffs |
| 13 | `dbo.TowRequests` | Normalized CAD dispatch & road-distance ledger | FKs to `Vehicles`, `Policies`, `Trucks`, `Drivers`, `Subcontractors`; `DistanceSource` `CHECK`; `ROWVERSION` | **120,007+ rows** |
| 14 | `dbo.TowInvoices` | Snapshot tariff pricing & split insurer/customer balances | `FK -> Tariffs`, separate `Insurer*` & `Customer*` columns, immutability trigger | **120,007+ rows** |
| 15 | `dbo.InvoicePayments` | Individual partial/full payment records per payer | `PayerType IN ('InsuranceProvider','Customer')`, `CK_InvoicePayments_PayerTarget` | **148,173+ rows** |
| 16 | `dbo.TowAuditLogs` | Immutable trigger audit log with `SESSION_CONTEXT` | Records `DispatcherUserId`, `DispatcherUsername`, `DispatcherFullName`, `SqlLoginName` | Dynamic |

---

## 4. Programmability, Concurrency, Security & Performance Summary
1. **T-SQL Programmability ([02_programmability_logic.sql](file:///c:/Users/user/Desktop/Uni/gin401/project/sql/02_programmability_logic.sql)):** 2 schema-bound scalar distance functions, 2 table-valued functions (`tvf_GetActiveTariff`, `tvf_CheckPolicyEligibility`), 2 `AFTER` immutability/audit triggers (`trg_TowRequests_ImmutabilityAndAudit`, `trg_TowInvoices_ProtectHistoricalPricing`), 2 window/aggregation views, and 24 `dbo.usp_*` stored procedures (including Admin user & permission management).
2. **Transactions & Concurrency:** `BEGIN TRANSACTION` + `TRY...CATCH` + `ROLLBACK` with `WITH (UPDLOCK, ROWLOCK)` pessimistic locking on policy quota tiers (`usp_ApproveAndDispatchTow`) and `ROWVERSION` optimistic concurrency on draft edits (`usp_UpdateDraftTowOptimistic`).
3. **Security ([04_security_least_privilege.sql](file:///c:/Users/user/Desktop/Uni/gin401/project/sql/04_security_least_privilege.sql)):** BCrypt (`cost = 12`) password hashing, `db_tow_dispatcher_role` restricted strictly to `EXECUTE` on authorized stored procedures (zero direct table/view access), 100% parameterized `ADO.NET`, and mandatory per-connection `SESSION_CONTEXT` validation.
4. **Performance ([05_performance_and_concurrency_tests.sql](file:///c:/Users/user/Desktop/Uni/gin401/project/sql/05_performance_and_concurrency_tests.sql)):** Revised covering and filtered nonclustered indexes over the 120,000+ normalized rows delivering pure `Index Seek` plans (`0` Key Lookups, `0` Sort operators, `0–1 ms` runtime) documented via final actual execution plans in [REPORT.md](file:///c:/Users/user/Desktop/Uni/gin401/project/REPORT.md).
