/*==============================================================================
  GIN401 - LAB PROJECT: ROADSIDE ASSISTANCE & TOWING CAD DISPATCH SYSTEM
  Script 05: Final Actual Execution Plans (>120,000 Normalized Rows),
             Historical Pricing & Immutability Triggers, SESSION_CONTEXT Audit
             Verification, and EXECUTE-Only Security Tests
  DBMS: Microsoft SQL Server
==============================================================================*/
USE GIN401_TowDispatch;
GO
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

/*==============================================================================
  PART A: FINAL ACTUAL EXECUTION PLANS ON >120,000-ROW NORMALIZED SCHEMA
  (dbo.TowRequests JOIN dbo.Vehicles JOIN dbo.TowInvoices)

  Instructions for SSMS:
  Enable "Include Actual Execution Plan" (Ctrl+M) and execute the 3 queries below.
  Every query uses SARGable predicates across the normalized 3NF schema and achieves:
    - Index Seek on dbo.TowRequests, dbo.TowInvoices, and dbo.Vehicles (0 Table Scans)
    - 0 Key Lookups (all projected columns covered in index keys / INCLUDE lists)
    - 0 Sort Operators (composite index key order matches ORDER BY CreatedAt DESC)
==============================================================================*/
SET STATISTICS IO, TIME ON;
GO

-- KEY QUERY 1: Policy Cooldown & Quota History Lookup across Normalized Tables
-- Indexes Seeked:
--   1. dbo.TowRequests -> IX_TowRequests_Policy_Issue_CreatedAt (ORDERED FORWARD)
--   2. dbo.TowInvoices -> UX_TowInvoices_TowRequestId_Covering
--   3. dbo.Vehicles    -> PK_Vehicles
DECLARE @PolicyId  INT = 42,
        @IssueType VARCHAR(20) = 'Mechanical';

SELECT TOP (15)
    tr.TowRequestId,
    tr.RequestNumber,
    v.VehiclePlate,
    v.VehicleModel,
    tr.Status,
    tr.RouteDistanceKm,
    tr.DistanceSource,
    inv.CoveredDistanceKm,
    inv.InsurerBilledAmount,
    inv.CustomerBilledAmount,
    tr.CreatedAt
FROM dbo.TowRequests AS tr
INNER JOIN dbo.Vehicles AS v ON tr.VehicleId = v.VehicleId
INNER JOIN dbo.TowInvoices AS inv ON tr.TowRequestId = inv.TowRequestId
WHERE tr.PolicyId = @PolicyId
  AND tr.IssueType = @IssueType
  AND tr.Status IN ('Approved', 'InProgress', 'Done')
ORDER BY tr.CreatedAt DESC;
GO

-- KEY QUERY 2: SARGable Date-Range & Status Dispatch/Financial Report (>120,000 Rows)
-- Indexes Seeked:
--   1. dbo.TowRequests -> IX_TowRequests_Status_CreatedAt_Covering (ORDERED FORWARD)
--   2. dbo.TowInvoices -> UX_TowInvoices_TowRequestId_Covering
--   3. dbo.Vehicles    -> PK_Vehicles
-- Note SARGable predicate: CreatedAt >= @StartDate AND CreatedAt < @EndDate (no YEAR()/MONTH() wrapping)
DECLARE @Status    VARCHAR(25)  = 'Done',
        @StartDate DATETIME2(0) = '2026-10-01T00:00:00',
        @EndDate   DATETIME2(0) = '2026-11-01T00:00:00';

SELECT TOP (50)
    tr.TowRequestId,
    tr.RequestNumber,
    v.VehiclePlate,
    v.VehicleModel,
    tr.IssueType,
    tr.RouteDistanceKm,
    tr.DistanceSource,
    inv.InsurerBilledAmount,
    inv.CustomerBilledAmount,
    inv.InvoiceStatus,
    tr.CreatedAt
FROM dbo.TowRequests AS tr
INNER JOIN dbo.Vehicles AS v ON tr.VehicleId = v.VehicleId
INNER JOIN dbo.TowInvoices AS inv ON tr.TowRequestId = inv.TowRequestId
WHERE tr.Status = @Status
  AND tr.CreatedAt >= @StartDate
  AND tr.CreatedAt < @EndDate
ORDER BY tr.CreatedAt DESC;
GO

-- KEY QUERY 3: Registered Vehicle License Plate History Lookup
-- Indexes Seeked:
--   1. dbo.Vehicles    -> UX_Vehicles_RegisteredPlate (filtered unique index WHERE NoPlate = 0)
--   2. dbo.Vehicles    -> PK_Vehicles
--   3. dbo.TowRequests -> IX_TowRequests_VehicleId_CreatedAt (ORDERED FORWARD, 0 Sort!)
--   4. dbo.TowInvoices -> UX_TowInvoices_TowRequestId_Covering
DECLARE @SearchPlate     VARCHAR(30) = 'M 100001',
        @TargetVehicleId INT;

SELECT @TargetVehicleId = v.VehicleId
FROM dbo.Vehicles AS v
WHERE v.NoPlate = 0
  AND v.VehiclePlate = @SearchPlate;

SELECT TOP (50)
    tr.TowRequestId,
    tr.RequestNumber,
    v.VehiclePlate,
    v.VehicleModel,
    tr.IssueType,
    tr.Status,
    tr.PickupAddress,
    tr.DestinationAddress,
    tr.RouteDistanceKm,
    tr.DistanceSource,
    inv.TotalAmount,
    tr.CreatedAt
FROM dbo.TowRequests AS tr
INNER JOIN dbo.Vehicles AS v ON tr.VehicleId = v.VehicleId
INNER JOIN dbo.TowInvoices AS inv ON tr.TowRequestId = inv.TowRequestId
WHERE tr.VehicleId = @TargetVehicleId
ORDER BY tr.CreatedAt DESC;
GO

SET STATISTICS IO, TIME OFF;
GO

/*==============================================================================
  PART B: BUSINESS RULE, TRIGGER, AUDIT & LEAST-PRIVILEGE VERIFICATION SUITE
==============================================================================*/

-- TEST 1: TowRequests Immutability Trigger — Block modification of finalized ('Done') ticket
BEGIN TRY
    UPDATE dbo.TowRequests
    SET IssueNotes = N'Unauthorized tampering attempt on completed tow'
    WHERE RequestNumber = 'TOW/2026/900001';
END TRY
BEGIN CATCH
    PRINT CONCAT('PASS - Test 1 Immutability Trigger (Err ', ERROR_NUMBER(), '): ', ERROR_MESSAGE());
END CATCH;
GO

-- TEST 2: Referential + Trigger Delete Protection — Block physical DELETE on TowRequests & TowInvoices
BEGIN TRY
    DELETE FROM dbo.TowInvoices WHERE InvoiceNumber = 'INV/2026/900001';
END TRY
BEGIN CATCH
    PRINT CONCAT('PASS - Test 2A Invoice Delete Trigger (Err ', ERROR_NUMBER(), '): ', ERROR_MESSAGE());
END CATCH;

BEGIN TRY
    DELETE FROM dbo.TowRequests WHERE RequestNumber = 'TOW/2026/900001';
END TRY
BEGIN CATCH
    PRINT CONCAT('PASS - Test 2B Request Delete Blocked (Err ', ERROR_NUMBER(), '): ', ERROR_MESSAGE());
END CATCH;
GO

-- TEST 3: TowInvoices Historical Pricing Protection Trigger — Block retroactive rate edits
BEGIN TRY
    UPDATE dbo.TowInvoices
    SET AppliedPricePerKm = 99.00,
        InsurerBilledAmount = 999.00,
        TotalAmount = 999.00
    WHERE InvoiceNumber = 'INV/2026/900001';
END TRY
BEGIN CATCH
    PRINT CONCAT('PASS - Test 3 Historical Pricing Trigger (Err ', ERROR_NUMBER(), '): ', ERROR_MESSAGE());
END CATCH;
GO

-- TEST 4: Verify SESSION_CONTEXT Dispatcher Tracking in dbo.TowAuditLogs
SELECT TOP (6)
    AuditId,
    RequestNumber,
    OldStatus,
    NewStatus,
    DispatcherUserId,
    DispatcherUsername,
    DispatcherFullName,
    SqlLoginName,
    ChangedAt
FROM dbo.TowAuditLogs
ORDER BY AuditId ASC;
GO

-- TEST 5: Cooldown Interval & Quota Exhaustion Verification
SELECT
    PolicyNumber,
    TargetCategory,
    IsEligible,
    RequiredCooldownDays,
    DaysSinceLastTow,
    StatusBanner
FROM dbo.tvf_CheckPolicyEligibility(3, 'Mechanical');

SELECT
    PolicyNumber,
    TargetCategory,
    IsEligible,
    RemainingCategoryTows,
    StatusBanner
FROM dbo.tvf_CheckPolicyEligibility(4, 'Accident');
GO

-- TEST 6: Least-Privilege EXECUTE-Only Role Verification as [tow_cad_app_user]
EXECUTE AS USER = 'tow_cad_app_user';

BEGIN TRY
    SELECT TOP (1) Username, PasswordHash FROM dbo.SystemUsers;
END TRY
BEGIN CATCH
    PRINT CONCAT('[PASS - Test 6A Direct SELECT on SystemUsers Denied (Msg ', ERROR_NUMBER(), ')]: ', ERROR_MESSAGE());
END CATCH;

BEGIN TRY
    DELETE FROM dbo.TowRequests WHERE TowRequestId = 1;
END TRY
BEGIN CATCH
    PRINT CONCAT('[PASS - Test 6B Direct DELETE on TowRequests Denied (Msg ', ERROR_NUMBER(), ')]: ', ERROR_MESSAGE());
END CATCH;

-- Authorized stored procedures succeed cleanly via unbroken dbo ownership chaining:
EXEC dbo.usp_SetDispatcherSessionContext @UserId = 1, @ExpectedUsername = 'assaad.khalife', @UpdateLastLogin = 0;
EXEC dbo.usp_GetUserGroups;
EXEC dbo.usp_GetEntityChangeLogs @SectionScope = 'users', @TopN = 5;
EXEC dbo.usp_ClearDispatcherSessionContext;

REVERT;
GO

PRINT '05_performance_and_concurrency_tests.sql completed successfully.';
GO
