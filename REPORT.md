# GIN401 Lab Project Report
## Roadside Assistance, Insurance Quota & Towing CAD Dispatch System

**Course:** GIN401 — Database Systems (School of Engineering)  
**Instructor:** Dr. Bruno S. Farjallah  
**Submitted by:** Assaad Khalife  

---

## Executive Summary of Completed Revisions & Enhancements

All **8 required instructor adjustments** plus **Administrator User & Granular RBAC Permission Management** have been implemented end-to-end across SQL Server (`GIN401_TowDispatch`), the parameterized C# .NET 9 ADO.NET backend, and the React CAD interface:

| # | Requirement | Concrete Implementation & Verification |
| :-: | :--- | :--- |
| **1** | **Normalize `TowRequests` into 3NF entities** | Decomposed into **19 normalized 3NF tables** (`UserGroups`, `SystemUsers`, `Customers`, `Vehicles`, `PlateCodes`, `InsuranceProviders`, `InsurancePolicies`, `PolicyQuotaTiers`, `Drivers`, `TowTrucks`, `DriverTruckAssignments`, `Subcontractors`, `Tariffs`, `TowRequests`, `TowInvoices`, `InvoicePayments`, `TowAuditLogs`, `AuditChangeEvents`, `AuditChangeDetails`). Updating a driver's phone modifies **only 1 row** in `dbo.Drivers`. |
| **2** | **Separate `Drivers` from `TowTrucks` & track assignments** | Added `dbo.Drivers` and `dbo.DriverTruckAssignments (DriverId, TruckId, StartDate, EndDate)` with two filtered unique indexes (`WHERE EndDate IS NULL`) enforcing at most one active driver per truck and preserving full shift history upon rotation (`usp_AssignDriverToTruck`, `usp_EndDriverTruckAssignment`). |
| **3** | **Add `Tariffs` for historical pricing** | Added `dbo.Tariffs (BaseFee, PricePerKm, NightSurcharge, EffectiveFrom, EffectiveTo)`. `dbo.TowInvoices` references `TariffId` **and** snapshots `AppliedBaseFee`, `AppliedPricePerKm`, and `AppliedNightSurcharge`. Trigger `trg_TowInvoices_ProtectHistoricalPricing` blocks invoice deletion (`50012`) and retroactive rate changes (`50013`). |
| **4** | **Track insurance company payments separately** | `dbo.TowInvoices` tracks `InsurerBilledAmount` / `InsurerPaidAmount` / `InsurerBalanceDue` separately from `CustomerBilledAmount` / `CustomerPaidAmount` / `CustomerBalanceDue`. Each partial or full settlement inserts its own row in `dbo.InvoicePayments` (`PayerType IN ('InsuranceProvider','Customer')`, `usp_RecordInvoicePayment`). |
| **5** | **BCrypt, 3NF `UserGroups` RBAC & `EXECUTE`-only SQL role** | Removed `PasswordSalt`; `dbo.SystemUsers.PasswordHash` enforces self-contained **BCrypt** (`cost = 12`, 60-char `$2%`). Permissions live exclusively on `dbo.UserGroups` (`SystemUsers.GroupId` FK — zero transitive duplication). SQL role `db_tow_dispatcher_role` (`tow_cad_app_login`) has **`EXECUTE` ONLY** on the **35 authorized `dbo.usp_*` stored procedures** with zero direct table/view access. |
| **6** | **Identify actual dispatcher in audit & 3NF change logs** | Every authenticated backend connection executes `dbo.usp_SetDispatcherSessionContext` to set and validate `SESSION_CONTEXT(N'AppUserId')`, `AppUsername`, and `AppFullName`. Triggers record the exact dispatcher in `dbo.TowAuditLogs` AND normalized field-level diffs (`FieldName`, `OldValue`, `NewValue`, `ChangedAt`) in `dbo.AuditChangeEvents` + `dbo.AuditChangeDetails`. |
| **7** | **Improve road-distance calculation** | Integrated real road-network routing via **OSRM** (`OSRM_DrivingRoute`) alongside validated dispatcher/fallback road estimates (`DispatcherVerifiedEstimate`, `HeuristicFallbackEstimate`), stored separately from geodesic `StraightLineDistanceKm` so straight-line distance is never presented or billed as driving distance. |
| **8** | **Show only final actual execution plans** | Retained **120,000+ rows** in `dbo.TowRequests` and `dbo.TowInvoices` (**148,000+ rows** in `dbo.InvoicePayments`), tuned normalized covering/filtered indexes, and captured **strictly final actual execution plans** (`0–1 ms` CPU/elapsed, `0` Key Lookups, `0` Sort). |
| **+** | **Configuration Hub (`Users`, `User Groups`, `Tow Trucks`, `Drivers`) & Odoo-Style Change Logs** | Unified **Configuration** console (`Users`, `User Groups & Permissions`, `Tow Trucks`, `Drivers`) separated from operational shift rotation (`Dispatch Board -> Fleet Shifts`), with system-wide Master-Detail sheets (`List -> Click Row -> Related 3NF Info` including clickable 120k+ Archive rows via `usp_GetTowRequestDetailById`) and plain Odoo-style **Change Logs** inside every Info view and per section. |

---

## 1. The Idea and Its Business Rules

### 1.1 Overview
Roadside assistance and towing dispatch centers in Lebanon manage 24/7 emergency breakdown and accident calls on behalf of major insurance companies (*Bankers Assurance, Fidelity, AXA Middle East, LIA Assurex, Allianz SNA, Medgulf*). When a stranded motorist calls the command desk, the dispatcher must:
1. Identify the caller and vehicle in a normalized **3NF relational schema**,
2. Verify the caller's insurance policy, sequential coverage quota tiers (*Mechanical* vs. *Accident/Winch*), and mandatory cooldown intervals between claims,
3. Compute real road-network driving distance via **OSRM** (or an explicitly labeled validated estimate) without ever presenting straight-line geodesic distance as driving distance,
4. Snapshot historical tariff rates onto a split-obligation invoice separating **Insurance Provider receivables** from **Customer overage/direct obligations** with individual partial/full payment rows, and
5. Dispatch an internal GPS-tracked tow truck (whose active driver is tracked via historical `DriverTruckAssignments`) or a normalized external `Subcontractor`, while recording the exact authenticated dispatcher in `dbo.TowAuditLogs` via SQL Server `SESSION_CONTEXT`.

### 1.2 Core Business Rules Enforced by the Database
1. **3NF Entity Separation (`dbo.TowRequests` & System-Wide Normalization):** Permission groups (`dbo.UserGroups`), operator accounts (`dbo.SystemUsers`), vehicle identity (`dbo.Vehicles`), customer contact (`dbo.Customers`), insurer & policy coverage (`dbo.InsuranceProviders`, `dbo.InsurancePolicies`, `dbo.PolicyQuotaTiers`), external towing partners (`dbo.Subcontractors`), pure truck hardware/telemetry (`dbo.TowTrucks`), driver HR/contact records (`dbo.Drivers`), driver-truck assignment history (`dbo.DriverTruckAssignments`), historical rate schedules (`dbo.Tariffs`), billed invoice snapshots (`dbo.TowInvoices`), individual partial/full payment remittances (`dbo.InvoicePayments`), and field-level audit change logs (`dbo.AuditChangeEvents`, `dbo.AuditChangeDetails`) are separated into **19 normalized 3NF tables**. Updating a driver's phone number modifies **only 1 row** in `dbo.Drivers`.
2. **Lebanese License Plate & Unregistered Showroom Rule (`CK_Vehicles_PlateRule` + `UX_Vehicles_RegisteredPlate`):** Every vehicle in `dbo.Vehicles` either specifies a valid regional Lebanese plate letter (`B`, `M`, `G`, `J`, `N`, `S`, `Z`, `O`, `D`, `C`) plus numeric digits (enforced unique via filtered index `WHERE NoPlate = 0`), OR sets `NoPlate = 1` with `VehiclePlate = 'NO-PLATE'`.
3. **Historical Driver-to-Truck Assignment Lineage (`dbo.DriverTruckAssignments`):** Drivers are decoupled from trucks. Each shift assignment records `(DriverId, TruckId, StartDate, EndDate)`. Two filtered unique indexes (`WHERE EndDate IS NULL`) guarantee at most one active driver per truck and one active truck per driver while preserving complete historical assignment records when drivers rotate trucks on the operational Dispatch Board (`Fleet Shifts`).
4. **Sequential Tiered Coverage Quotas & Cooldown Intervals (`dbo.PolicyQuotaTiers`):** Policies define ordered tiers (`TierSequence = 10, 20, ...`) for `'Mechanical'`, `'Accident'`, or `'All'` breakdowns with `AllowedTows`, `UsedTows` (`UsedTows <= AllowedTows`), `MaxDistanceKm`, and `MinIntervalDays`. Lower-sequence tiers are consumed first, and insurance dispatch is blocked if `RemainingCategoryTows = 0` or if fewer than `MinIntervalDays` have elapsed since the policy's last tow in that category.
5. **Historical Tariff Snapshot Pricing (`dbo.Tariffs` -> `dbo.TowInvoices`):** `dbo.Tariffs` defines `BaseFee`, `PricePerKm`, `NightSurcharge`, and effective date windows (`EffectiveFrom`, `EffectiveTo`). When a tow is created or dispatched, `dbo.TowInvoices` references `TariffId` **and** snapshots `AppliedBaseFee`, `AppliedPricePerKm`, and `AppliedNightSurcharge`. Trigger `dbo.trg_TowInvoices_ProtectHistoricalPricing` blocks both invoice deletion (`50012`) and retroactive rate tampering on issued invoices (`50013`), ensuring future tariff changes never alter historical invoices.
6. **Separate Insurer vs. Customer Obligations & Partial Payment Ledger (`dbo.TowInvoices` + `dbo.InvoicePayments`):** `dbo.TowInvoices` tracks `InsurerBilledAmount` / `InsurerPaidAmount` / `InsurerBalanceDue` independently from `CustomerBilledAmount` / `CustomerPaidAmount` / `CustomerBalanceDue`. Every partial or full settlement inserts its own row in `dbo.InvoicePayments` linked to the invoice and payer (`PayerType IN ('InsuranceProvider', 'Customer')` with `CK_InvoicePayments_PayerTarget`), automatically transitioning `InvoiceStatus` (`Draft` -> `Issued` -> `PartiallyPaid` -> `Paid`) while preventing overpayment (`50040`, `50041`).
7. **Validated Road-Distance Provenance (`CK_TowRequests_DistSource`):** `dbo.TowRequests` stores `StraightLineDistanceKm` (geodesic reference only) separately from `RouteDistanceKm` and `DistanceSource IN ('OSRM_DrivingRoute', 'DispatcherVerifiedEstimate', 'HeuristicFallbackEstimate')`, ensuring straight-line Haversine distance is never presented or billed as actual driving distance.
8. **Least-Privilege `EXECUTE`-Only Security, BCrypt Hashing, 3NF `UserGroups` RBAC & `SESSION_CONTEXT` Audit / Change Logs:**
   * `dbo.SystemUsers` stores self-contained **BCrypt** (`cost = 12`) hashes (`CK_SystemUsers_BcryptFormat: PasswordHash LIKE '$2%' AND LEN(PasswordHash) = 60`) with no separate salt column, and references `dbo.UserGroups (GroupId)` where the 5 granular module permission flags (`CanDispatch`, `CanManageFleet`, `CanManagePolicies`, `CanManageBilling`, `CanManageUsers`) reside without transitive redundancy.
   * Administrators (`CanManageUsers = 1`) manage both `dbo.UserGroups` (`usp_GetUserGroups`, `usp_CreateUserGroup`, `usp_UpdateUserGroup`, `usp_DeleteUserGroup`) and `dbo.SystemUsers` (`usp_GetAdminSystemUsers`, `usp_AdminCreateSystemUser`, `usp_AdminUpdateSystemUser`, `usp_AdminDeleteSystemUser`), protected by self-lockout guards (`50033`, `50034`, `50038`) and automatic audit-preserving deactivation (`DeactivatedForAuditIntegrity`) when an operator owns historical `TowRequests`.
   * The application connects as `tow_cad_app_login` (`db_tow_dispatcher_role`), which holds **`EXECUTE` permissions ONLY on the 34 authorized `dbo.usp_*` stored procedures** and zero direct permissions on tables or views.
   * Every authenticated connection calls `dbo.usp_SetDispatcherSessionContext` to set and validate `SESSION_CONTEXT(N'AppUserId')`, `SESSION_CONTEXT(N'AppUsername')`, `SESSION_CONTEXT(N'AppFullName')`, `SESSION_CONTEXT(N'AppGroupCode')`, and `SESSION_CONTEXT(N'CanManageUsers')`. Trigger `dbo.trg_TowRequests_ImmutabilityAndAudit` permanently seals finalized tickets (`Done`, `UnableToLoad`, `Rejected`) against `UPDATE`/`DELETE` (`50010`, `50011`) and logs status transitions in `dbo.TowAuditLogs`, while 11 set-based `trg_Audit_*` triggers record normalized field-level diffs (`OldValue` -> `NewValue`) in `dbo.AuditChangeEvents` + `dbo.AuditChangeDetails`, exposed per section via `dbo.usp_GetEntityChangeLogs`.

---

## 2. Normalized Database Diagram (3NF ERD — 19 Tables)

```mermaid
erDiagram
    UserGroups ||--o{ SystemUsers : "grants RBAC permissions"
    Customers ||--o{ Vehicles : "owns"
    PlateCodes ||--o{ Vehicles : "classifies plate"
    InsuranceProviders ||--o{ InsurancePolicies : "underwrites"
    Customers ||--o{ InsurancePolicies : "holds"
    InsurancePolicies ||--|{ PolicyQuotaTiers : "defines sequential tiers"
    Drivers ||--o{ DriverTruckAssignments : "assigned via"
    TowTrucks ||--o{ DriverTruckAssignments : "operated via"
    Customers ||--o{ TowRequests : "requests"
    Vehicles ||--o{ TowRequests : "serviced in"
    InsurancePolicies ||--o{ TowRequests : "covers"
    PolicyQuotaTiers ||--o{ TowRequests : "consumes 1 tow"
    TowTrucks ||--o{ TowRequests : "dispatched truck"
    Drivers ||--o{ TowRequests : "dispatched driver"
    Subcontractors ||--o{ TowRequests : "outsourced to"
    TowRequests ||--|| TowInvoices : "billed on"
    Tariffs ||--o{ TowInvoices : "snapshots rate from"
    InsuranceProviders ||--o{ TowInvoices : "insurer debtor"
    Customers ||--o{ TowInvoices : "customer debtor"
    TowInvoices ||--o{ InvoicePayments : "settled by rows"
    SystemUsers ||--o{ InvoicePayments : "recorded by"
    Drivers ||--o{ InvoicePayments : "cash collected by"
    TowRequests ||--o{ TowAuditLogs : "audited by trigger"
    SystemUsers ||--o{ TowAuditLogs : "SESSION_CONTEXT dispatcher"
    SystemUsers ||--o{ AuditChangeEvents : "SESSION_CONTEXT actor"
    AuditChangeEvents ||--|{ AuditChangeDetails : "atomic field diffs"

    UserGroups {
        int GroupId PK
        varchar GroupCode UK
        nvarchar GroupName UK
        bit CanDispatch
        bit CanManageFleet
        bit CanManagePolicies
        bit CanManageBilling
        bit CanManageUsers
        bit IsSystemGroup
    }
    SystemUsers {
        int UserId PK
        varchar Username UK
        varchar PasswordHash "BCrypt cost=12 (60 chars)"
        nvarchar FullName
        nvarchar RoleTitle
        int GroupId FK
        varchar StationCode
        bit IsActive
    }
    Customers {
        int CustomerId PK
        nvarchar FullName
        varchar Phone UK
        varchar Email
    }
    PlateCodes {
        int PlateCodeId PK
        varchar Code UK
        nvarchar RegionDescription
    }
    Vehicles {
        int VehicleId PK
        int CustomerId FK
        int PlateCodeId FK
        varchar PlateDigits
        bit NoPlate
        varchar VehiclePlate
        nvarchar VehicleModel
    }
    InsuranceProviders {
        int ProviderId PK
        nvarchar ProviderName UK
        varchar SupportPhone
        varchar ContractEmail
    }
    InsurancePolicies {
        int PolicyId PK
        varchar PolicyNumber UK
        int CustomerId FK
        int ProviderId FK
        date StartDate
        date ExpirationDate
        decimal DefaultAllowedKm
        int DefaultMinIntervalDays
        varchar PolicyStatus
        rowversion RowVer
    }
    PolicyQuotaTiers {
        int QuotaTierId PK
        int PolicyId FK
        int TierSequence
        varchar CoverageType
        int AllowedTows
        int UsedTows
        decimal MaxDistanceKm
        int MinIntervalDays
        rowversion RowVer
    }
    Drivers {
        int DriverId PK
        varchar EmployeeCode UK
        nvarchar FullName
        varchar Phone UK
        varchar LicenseNumber UK
        decimal BaseMonthlySalary
        decimal OvertimeRatePerTow
        bit IsWorkingOffDay
        varchar DriverStatus
    }
    TowTrucks {
        int TruckId PK
        varchar TruckCode UK
        varchar LicensePlate UK
        nvarchar TruckModel
        int MaxPayloadKg
        decimal CurrentLat
        decimal CurrentLng
        varchar FleetStatus
        rowversion RowVer
    }
    DriverTruckAssignments {
        int AssignmentId PK
        int DriverId FK
        int TruckId FK
        datetime2 StartDate
        datetime2 EndDate "NULL = Active"
        nvarchar AssignmentNotes
    }
    Subcontractors {
        int SubcontractorId PK
        nvarchar CompanyName UK
        varchar Phone
        nvarchar CoverageRegion
        decimal DefaultDispatchFee
    }
    Tariffs {
        int TariffId PK
        varchar TariffCode UK
        varchar ServiceCategory
        decimal BaseFee
        decimal PricePerKm
        decimal NightSurcharge
        date EffectiveFrom
        date EffectiveTo
        bit IsActive
    }
    TowRequests {
        int TowRequestId PK
        varchar RequestNumber UK
        int CustomerId FK
        int VehicleId FK
        int PolicyId FK
        int QuotaTierId FK
        int AssignedTruckId FK
        int AssignedDriverId FK
        int SubcontractorId FK
        varchar IssueType
        decimal StraightLineDistanceKm
        decimal RouteDistanceKm
        varchar DistanceSource
        int TruckPrioritySequence
        varchar Status
        datetime2 CreatedAt
        rowversion RowVer
    }
    TowInvoices {
        int InvoiceId PK
        varchar InvoiceNumber UK
        int TowRequestId FK_UK
        int TariffId FK
        int InsuranceProviderId FK
        int CustomerId FK
        decimal AppliedBaseFee
        decimal AppliedPricePerKm
        decimal AppliedNightSurcharge
        decimal InsurerBilledAmount
        decimal InsurerPaidAmount
        decimal CustomerBilledAmount
        decimal CustomerPaidAmount
        decimal TotalAmount
        varchar InvoiceStatus
    }
    InvoicePayments {
        bigint PaymentId PK
        int InvoiceId FK
        varchar PayerType
        int InsuranceProviderId FK
        int CustomerId FK
        decimal AmountPaid
        varchar PaymentMethod
        varchar ReferenceNumber
        int CollectedByDriverId FK
        int RecordedByUserId FK
        datetime2 PaidAt
    }
    TowAuditLogs {
        bigint AuditId PK
        int TowRequestId FK
        varchar RequestNumber
        varchar OldStatus
        varchar NewStatus
        int DispatcherUserId FK
        varchar DispatcherUsername
        nvarchar DispatcherFullName
        nvarchar SqlLoginName
        datetime2 ChangedAt
    }
    AuditChangeEvents {
        bigint ChangeEventId PK
        varchar EntityType
        int EntityId
        varchar EntityCode
        varchar OperationType "INSERT|UPDATE|DELETE"
        int ChangedByUserId FK
        nvarchar SqlLoginName
        datetime2 ChangedAt
    }
    AuditChangeDetails {
        bigint ChangeDetailId PK
        bigint ChangeEventId FK
        varchar FieldName
        nvarchar OldValue
        nvarchar NewValue
    }
```

---

## 3. Key T-SQL Objects Explained

1. **`dbo.fn_CalculateStraightLineDistanceKm` & `dbo.fn_EstimateRoadHeuristicKm` (Scalar Functions `WITH SCHEMABINDING`):**
   * `fn_CalculateStraightLineDistanceKm` computes pure geodesic Haversine distance (`StraightLineDistanceKm`) strictly as a geographic reference.
   * When real-time OSRM road routing (`OSRM_DrivingRoute`) or a dispatcher-verified road override (`DispatcherVerifiedEstimate`) is unavailable, `fn_EstimateRoadHeuristicKm` computes a fallback estimate explicitly tagged in `DistanceSource` as `'HeuristicFallbackEstimate'`, ensuring straight-line distance is never misrepresented as driving distance.
2. **`dbo.tvf_GetActiveTariff(@IssueType, @AsOfDate)` & `dbo.tvf_CheckPolicyEligibility(@PolicyId, @IssueType)` (Table-Valued Functions):**
   * `tvf_GetActiveTariff` resolves the active `dbo.Tariffs` row matching the breakdown category (`Mechanical` vs. `Accident` or `All`) as of the dispatch date.
   * `tvf_CheckPolicyEligibility` validates policy status/expiration, finds the first sequential `PolicyQuotaTiers` row with `UsedTows < AllowedTows`, and checks `IX_TowRequests_Policy_Issue_CreatedAt` to enforce `MinIntervalDays` cooldown rules.
3. **`dbo.trg_TowRequests_ImmutabilityAndAudit`, `dbo.trg_TowInvoices_ProtectHistoricalPricing` & 11 Set-Based `dbo.trg_Audit_*` Change Log Triggers (`AFTER` Triggers):**
   * `trg_TowRequests_ImmutabilityAndAudit` blocks physical `DELETE` (`THROW 50011`), blocks any `UPDATE` to closed tickets in `('Done', 'UnableToLoad', 'Rejected')` (`THROW 50010`), and writes status audit rows into `dbo.TowAuditLogs` reading `SESSION_CONTEXT(N'AppUserId')`, `SESSION_CONTEXT(N'AppUsername')`, and `SESSION_CONTEXT(N'AppFullName')` alongside `SUSER_SNAME()`.
   * `trg_TowInvoices_ProtectHistoricalPricing` blocks `DELETE` on `dbo.TowInvoices` (`THROW 50012`) and prevents modifying snapshot pricing columns (`TariffId`, `AppliedBaseFee`, `AppliedPricePerKm`, `InsurerBilledAmount`, `CustomerBilledAmount`) once an invoice is issued (`THROW 50013`).
   * Eleven set-based `trg_Audit_*` triggers (`UserGroups`, `SystemUsers`, `Customers`, `InsurancePolicies`, `PolicyQuotaTiers`, `Drivers`, `TowTrucks`, `DriverTruckAssignments`, `Tariffs`, `InvoicePayments`, `TowRequests`) capture field-by-field diffs (`FieldName`, `OldValue`, `NewValue`) in `dbo.AuditChangeEvents` + `dbo.AuditChangeDetails` attributed to `SESSION_CONTEXT(N'AppUserId')`.
4. **`dbo.vw_FleetPriorityQueueAndRankings` & `dbo.vw_DriverPayrollAndCashReport` (Analytical Views):**
   * `vw_FleetPriorityQueueAndRankings` uses window functions `ROW_NUMBER() OVER (PARTITION BY AssignedTruckId ORDER BY TruckPrioritySequence ASC)`, `SUM(RouteDistanceKm) OVER (... ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`, and `COUNT(*) OVER (PARTITION BY AssignedTruckId)` across normalized `TowRequests`, `TowTrucks`, `DriverTruckAssignments`, `Drivers`, `Vehicles`, and `TowInvoices`.
   * `vw_DriverPayrollAndCashReport` aggregates monthly completed tows, night-shift (`19:00–07:00`) / off-day overtime pay, and on-scene customer cash deductions from `dbo.InvoicePayments` per driver.
5. **34 Authorized Stored Procedures (`dbo.usp_*`) — `EXECUTE`-Only Interface:**
   * Includes `usp_SetDispatcherSessionContext` (validates active operator and binds `SESSION_CONTEXT` user & `UserGroups` RBAC keys), `usp_ApproveAndDispatchTow` (`BEGIN TRAN` + `WITH (UPDLOCK, ROWLOCK)` pessimistic quota locking + `TRY...CATCH` + `ROLLBACK`), `usp_UpdateDraftTowOptimistic` (`ROWVERSION` optimistic concurrency), `usp_RecordInvoicePayment` (atomic partial/full payment insertion and balance reconciliation), `usp_AssignDriverToTruck`, `usp_EndDriverTruckAssignment`, `usp_CreateDriver`, `usp_UpdateDriverContact`, `usp_CreateTowTruck`, `usp_UpdateTowTruck`, `usp_CreateCustomer`, `usp_UpdateCustomer`, `usp_CreateTariff`, `usp_SearchTowRequestsArchive`, `usp_GetEntityChangeLogs` (strictly section-scoped 3NF change log retrieval), 4 `UserGroups` procedures (`usp_GetUserGroups`, `usp_CreateUserGroup`, `usp_UpdateUserGroup`, `usp_DeleteUserGroup`), and 4 Admin operator procedures (`usp_GetAdminSystemUsers`, `usp_AdminCreateSystemUser`, `usp_AdminUpdateSystemUser`, `usp_AdminDeleteSystemUser`).

---

## 4. Final Actual Execution Plans on >120,000 Normalized Rows

The normalized database contains **120,000+ rows** in `dbo.TowRequests`, **120,000+ rows** in `dbo.TowInvoices`, **148,000+ rows** in `dbo.InvoicePayments`, and **4,000 rows** in `dbo.Vehicles` (generated in [03_seed_120k_data.sql](file:///c:/Users/user/Desktop/Uni/gin401/project/sql/03_seed_120k_data.sql)). All three key multi-table archive queries in [05_performance_and_concurrency_tests.sql](file:///c:/Users/user/Desktop/Uni/gin401/project/sql/05_performance_and_concurrency_tests.sql) are 100% **SARGable** and use covering/filtered nonclustered indexes across `dbo.TowRequests`, `dbo.Vehicles`, and `dbo.TowInvoices`. Below are the **final actual execution plans** (`SET STATISTICS PROFILE ON; SET STATISTICS IO, TIME ON;`).

### Key Query 1: Policy Cooldown & Claim History Lookup (`PolicyId = 42`, `IssueType = 'Mechanical'`, `TOP 15`)
* **Revised Normalized Indexes Used:**
  * `dbo.TowRequests.IX_TowRequests_Policy_Issue_CreatedAt (PolicyId ASC, IssueType ASC, CreatedAt DESC) INCLUDE (RequestNumber, VehicleId, Status, RouteDistanceKm, DistanceSource, QuotaTierId)`
  * `dbo.TowInvoices.UX_TowInvoices_TowRequestId_Covering (TowRequestId ASC) INCLUDE (TariffId, CoveredDistanceKm, OverageDistanceKm, InsurerBilledAmount, InsurerPaidAmount, CustomerBilledAmount, CustomerPaidAmount, TotalAmount, InvoiceStatus)`
  * `dbo.Vehicles.PK_Vehicles (VehicleId ASC)`
* **Final Actual Execution Plan:**
  ```text
  |--Top(TOP EXPRESSION:((15)))
       |--Nested Loops(Inner Join, OUTER REFERENCES:([tr].[VehicleId]))
            |--Nested Loops(Inner Join, OUTER REFERENCES:([tr].[TowRequestId]))
            |    |--Index Seek(OBJECT:([GIN401_TowDispatch].[dbo].[TowRequests].[IX_TowRequests_Policy_Issue_CreatedAt] AS [tr]),
            |    |             SEEK:([tr].[PolicyId]=(42) AND [tr].[IssueType]='Mechanical'),
            |    |             WHERE:([tr].[Status]='Approved' OR [tr].[Status]='Done' OR [tr].[Status]='InProgress') ORDERED FORWARD)
            |    |--Index Seek(OBJECT:([GIN401_TowDispatch].[dbo].[TowInvoices].[UX_TowInvoices_TowRequestId_Covering] AS [inv]),
            |                  SEEK:([inv].[TowRequestId]=[tr].[TowRequestId]) ORDERED FORWARD)
            |--Clustered Index Seek(OBJECT:([GIN401_TowDispatch].[dbo].[Vehicles].[PK_Vehicles] AS [v]),
                                    SEEK:([v].[VehicleId]=[tr].[VehicleId]) ORDERED FORWARD)
  ```
* **Actual Runtime Metrics:** `Rows = 15`, `TowRequests logical reads = 3`, `TowInvoices logical reads = 51`, `Vehicles logical reads = 36`, `Subtree Cost = 0.0917`, `CPU time = 0 ms`, `Elapsed time = 0–1 ms` (**0 Key Lookups, 0 Sort**).

### Key Query 2: Status & SARGable Date-Range Financial Report (`Status = 'Done'`, `CreatedAt >= '2026-10-01' AND CreatedAt < '2026-11-01'`, `TOP 50`)
* **Revised Normalized Indexes Used:**
  * `dbo.TowRequests.IX_TowRequests_Status_CreatedAt_Covering (Status ASC, CreatedAt DESC) INCLUDE (RequestNumber, CustomerId, VehicleId, PolicyId, AssignedTruckId, AssignedDriverId, IssueType, StraightLineDistanceKm, RouteDistanceKm, DistanceSource, IsNightShift)`
  * `dbo.TowInvoices.UX_TowInvoices_TowRequestId_Covering`
  * `dbo.Vehicles.PK_Vehicles`
* **Final Actual Execution Plan:**
  ```text
  |--Top(TOP EXPRESSION:((50)))
       |--Nested Loops(Inner Join, OUTER REFERENCES:([tr].[VehicleId]))
            |--Nested Loops(Inner Join, OUTER REFERENCES:([tr].[TowRequestId]))
            |    |--Index Seek(OBJECT:([GIN401_TowDispatch].[dbo].[TowRequests].[IX_TowRequests_Status_CreatedAt_Covering] AS [tr]),
            |    |             SEEK:([tr].[Status]=[@Status] AND [tr].[CreatedAt] < [@EndDate] AND [tr].[CreatedAt] >= [@StartDate]) ORDERED FORWARD)
            |    |--Index Seek(OBJECT:([GIN401_TowDispatch].[dbo].[TowInvoices].[UX_TowInvoices_TowRequestId_Covering] AS [inv]),
            |                  SEEK:([inv].[TowRequestId]=[tr].[TowRequestId]) ORDERED FORWARD)
            |--Clustered Index Seek(OBJECT:([GIN401_TowDispatch].[dbo].[Vehicles].[PK_Vehicles] AS [v]),
                                    SEEK:([v].[VehicleId]=[tr].[VehicleId]) ORDERED FORWARD)
  ```
* **Actual Runtime Metrics:** `Rows = 50`, `TowRequests logical reads = 4`, `TowInvoices logical reads = 162`, `Vehicles logical reads = 112`, `Subtree Cost = 0.2640`, `CPU time = 0 ms`, `Elapsed time = 0–1 ms` (**0 Key Lookups, 0 Sort**).

### Key Query 3: Normalized Registered License Plate History Lookup (`VehiclePlate = 'M 100001'`, `TOP 50`)
* **Revised Normalized Indexes Used:**
  * Step 1 (`@TargetVehicleId` resolution): Filtered unique index `dbo.Vehicles.UX_Vehicles_RegisteredPlate (VehiclePlate ASC) INCLUDE (CustomerId, VehicleModel, PlateCodeId, PlateDigits) WHERE (NoPlate = 0)`
  * Step 2 (History retrieval): `dbo.TowRequests.IX_TowRequests_VehicleId_CreatedAt (VehicleId ASC, CreatedAt DESC) INCLUDE (RequestNumber, CustomerId, PolicyId, IssueType, Status, RouteDistanceKm, DistanceSource)` + `dbo.TowInvoices.UX_TowInvoices_TowRequestId_Covering` + `dbo.Vehicles.PK_Vehicles`
* **Final Actual Execution Plan:**
  ```text
  -- Step 1: Resolve @TargetVehicleId via Filtered Unique Index
  |--Index Seek(OBJECT:([GIN401_TowDispatch].[dbo].[Vehicles].[UX_Vehicles_RegisteredPlate] AS [v]),
                SEEK:([v].[VehiclePlate]=[@SearchPlate]), WHERE:([v].[NoPlate]=(0)) ORDERED FORWARD)

  -- Step 2: Ordered History Seek on Normalized VehicleId
  |--Top(TOP EXPRESSION:((50)))
       |--Nested Loops(Inner Join, OUTER REFERENCES:([tr].[TowRequestId]))
            |--Nested Loops(Inner Join)
            |    |--Clustered Index Seek(OBJECT:([GIN401_TowDispatch].[dbo].[Vehicles].[PK_Vehicles] AS [v]),
            |    |                       SEEK:([v].[VehicleId]=[@TargetVehicleId]) ORDERED FORWARD)
            |    |--Index Seek(OBJECT:([GIN401_TowDispatch].[dbo].[TowRequests].[IX_TowRequests_VehicleId_CreatedAt] AS [tr]),
            |                  SEEK:([tr].[VehicleId]=[@TargetVehicleId]) ORDERED FORWARD)
            |--Index Seek(OBJECT:([GIN401_TowDispatch].[dbo].[TowInvoices].[UX_TowInvoices_TowRequestId_Covering] AS [inv]),
                          SEEK:([inv].[TowRequestId]=[tr].[TowRequestId]) ORDERED FORWARD)
  ```
* **Actual Runtime Metrics:** `Rows = 31`, `Step 1 Vehicles logical reads = 2 (Subtree Cost = 0.0033)`, `Step 2 Vehicles logical reads = 2`, `TowRequests logical reads = 5`, `TowInvoices logical reads = 103`, `Subtree Cost = 0.1017`, `CPU time = 0 ms`, `Elapsed time = 0–1 ms` (**0 Key Lookups, 0 Sort, 0 Worktable**).

---

## 5. Verification Tests and Live Results

| Test Case | Action Performed | Result |
| :--- | :--- | :--- |
| **1. 2-Dispatcher Pessimistic Concurrency + `SESSION_CONTEXT`** | Policy `POL-2026-ACC-LAST1` has `1` Accident tow remaining (`Allowed=2, Used=1`). Two parallel connections (`dispatch.beirut` vs. `fleet.manager`) call `usp_ApproveAndDispatchTow` simultaneously. | **PASS:** `dispatch.beirut` acquires `UPDLOCK, ROWLOCK`, increments `UsedTows` (`1 -> 2`), logs `dispatch.beirut` in `TowAuditLogs`, and `COMMITS`. `fleet.manager` waits on the lock, sees `0` remaining, catches Error `50005`, and executes `ROLLBACK TRANSACTION`. |
| **2. Optimistic Concurrency (`ROWVERSION`)** | Two dispatchers open the same Draft ticket; Dispatcher #2 submits an outdated `RowVer` binary token. | **PASS:** `usp_UpdateDraftTowOptimistic` rejects the stale write with Error `50020` (*Optimistic Concurrency Conflict*). |
| **3. Closed Ticket & Historical Invoice Immutability** | Attempt to modify a `'Done'` request (`TOW/2026/900001`), delete an invoice, or alter `AppliedPricePerKm` on an issued invoice; publish a new tariff. | **PASS:** Blocked with Errors `50010`, `50012`, and `50013`. Publishing a new tariff leaves all 120,000+ historical `TowInvoices` unchanged (`0` mismatched invoices). |
| **4. 3NF Driver Update & Truck Assignment Rotation** | Update Driver #1's phone via `PUT /api/drivers/1`; rotate Driver #9 onto Truck #8 via `POST /api/driver-assignments`. | **PASS:** Phone update modifies **only 1 row** in `dbo.Drivers`. Truck rotation closes the previous open row (`EndDate = SYSDATETIME()`) and inserts a new active row (`EndDate IS NULL`) in `dbo.DriverTruckAssignments`. |
| **5. Separate Insurer vs. Customer Partial Payments** | Record a partial `\$10.00` `InsuranceProvider` bank transfer via `POST /api/invoices/{id}/payments`. | **PASS:** Inserts a dedicated row in `dbo.InvoicePayments`, increments `InsurerPaidAmount`, reduces `InsurerBalanceDue`, keeps `CustomerBalanceDue` separate, and transitions `InvoiceStatus` to `'PartiallyPaid'`. |
| **6. BCrypt Auth + `EXECUTE`-Only SQL Role + SQLi Check** | Connect as `tow_cad_app_login` (`db_tow_dispatcher_role`); test `SELECT TOP 1 * FROM dbo.SystemUsers`; test wrong BCrypt password; pass `' OR 1=1 --` to `@VehiclePlate`. | **PASS:** Direct table `SELECT` is blocked (`Msg 229: SELECT permission was denied`); wrong password returns `HTTP 401`; parameterized `usp_SearchTowRequestsArchive` treats `' OR 1=1 --` as literal text and returns `0` rows in `< 2 ms`. |
| **7. 3NF `UserGroups` RBAC & Admin Safeguards** | Non-admin (`dispatch.beirut`) calls `GET /api/admin/users`; Admin (`assaad.khalife`, assigned to `GroupId=1` `ADMIN`) creates a custom `UserGroups` row, assigns a BCrypt operator, attempts self-lockout on `ADMIN` group and self-delete, then cleans up. | **PASS:** Non-admin is blocked by T-SQL Error `50032` (`HTTP 403`); stripping `CanManageUsers` from the caller's own group is blocked by Error `50038`; self-delete is blocked by Error `50034`; unused test operator/group is `HardDeleted` (operators with historical `TowRequests` are `DeactivatedForAuditIntegrity`). |
| **8. Section-Scoped 3NF Change Logs (`AuditChangeEvents` + `AuditChangeDetails`)** | Update `CanManageBilling` on a `UserGroups` row and query `GET /api/changelogs?section=groups` vs. `GET /api/changelogs?section=users`. | **PASS:** `trg_Audit_UserGroups` records `CanManageBilling: false -> true` attributed to `assaad.khalife` (`SESSION_CONTEXT`), and `usp_GetEntityChangeLogs` strictly isolates logs to the requested section (`groups` returns only `UserGroups`; `users` returns only `SystemUsers`). |

---

## 6. AI Usage Disclaimer

* **Tools Used:** Google Antigravity (Gemini) coding assistant.
* **What AI Was Used For:**
  * Refactoring the React.js CAD views ([frontend/src/App.jsx](file:///c:/Users/user/Desktop/Uni/gin401/project/frontend/src/App.jsx)) and parameterized ADO.NET endpoints ([backend/Program.cs](file:///c:/Users/user/Desktop/Uni/gin401/project/backend/Program.cs)) to expose the normalized 19-table schema, Configuration Hub (`Users`, `User Groups`, `Tow Trucks`, `Drivers`), operational driver-truck shift assignments, historical tariffs, split insurer/customer partial payment workflows, and the section-scoped Change Log table.
  * Generating the set-based cross-join CTE (`L0..L3`) in [03_seed_120k_data.sql](file:///c:/Users/user/Desktop/Uni/gin401/project/sql/03_seed_120k_data.sql) to populate 120,000+ normalized `TowRequests`, `TowInvoices`, and `InvoicePayments` rows rapidly.
* **What Was Verified, Debugged, and Tuned Directly Against Live SQL Server:**
  1. **Eliminating Cardinality-Induced `Sort` on Filtered Unique Plate Index (Key Query 3):** Joining `dbo.Vehicles` directly on `WHERE v.NoPlate = 0 AND v.VehiclePlate = @VehiclePlate` caused SQL Server's Cardinality Estimator to estimate `1.0005` rows on `UX_Vehicles_RegisteredPlate` and inject an explicit `Sort(ORDER BY tr.CreatedAt DESC)` operator. Resolving `@TargetVehicleId` first via `UX_Vehicles_RegisteredPlate` (`2` logical reads) and then seeking `IX_TowRequests_VehicleId_CreatedAt` on `WHERE tr.VehicleId = @TargetVehicleId` eliminated both the `Sort` and `Worktable` completely (`0 ms` CPU).
  2. **Preserving `@@ROWCOUNT` Before `SET NOCOUNT ON` in Set-Based Audit Triggers:** Placing `SET NOCOUNT ON;` before `IF @@ROWCOUNT = 0 RETURN;` inside `AFTER` triggers resets `@@ROWCOUNT` to `0` and causes silent early exit. Moving `IF @@ROWCOUNT = 0 RETURN;` to the very first statement of all 11 `trg_Audit_*` triggers ensured 100% reliable field-diff capture across single-row and multi-row DML statements.
  3. **`WITH SCHEMABINDING` Dependency Ordering & `EXECUTE`-Only Ownership Chaining:** Resolved `Msg 3729` on idempotent re-runs of [02_programmability_logic.sql](file:///c:/Users/user/Desktop/Uni/gin401/project/sql/02_programmability_logic.sql) by dropping `fn_EstimateRoadHeuristicKm` prior to altering `fn_CalculateStraightLineDistanceKm`, and verified under `tow_cad_app_login` that `HAS_PERMS_BY_NAME('dbo.TowRequests', 'OBJECT', 'SELECT') = 0` while all 34 `dbo.usp_*` procedures execute cleanly via `dbo` ownership chaining.
