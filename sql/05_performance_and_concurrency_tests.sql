/*==============================================================================
  GIN401 - LAB PROJECT: ROADSIDE ASSISTANCE & TOWING CAD DISPATCH SYSTEM
  Script 05: Performance Execution Plans (>120,000 Rows), Constraint Tests,
             Immutability Trigger Tests & Concurrency Verification
  DBMS: Microsoft SQL Server
==============================================================================*/
USE GIN401_TowDispatch;
GO
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

/*==============================================================================
  PART A: PERFORMANCE ON >120,000-ROW TABLE (dbo.TowRequests)
  Turn on Actual Execution Plan (Ctrl+M in SSMS) and run the 3 Key Queries below.
  Every query uses SARGable predicates and achieves:
  - Index Seek (no Table/Clustered Index Scan)
  - 0 Key Lookups (all SELECT columns are in the index key or INCLUDE list)
  - 0 Sort Operators (index key order matches ORDER BY)
==============================================================================*/
SET STATISTICS IO, TIME ON;
GO

-- KEY QUERY 1: Policy Cooldown & Quota History Lookup
-- Uses: IX_TowRequests_Policy_Issue_CreatedAt (PolicyId ASC, IssueType ASC, CreatedAt DESC)
DECLARE @PolicyId INT = 42,
        @IssueType VARCHAR(20) = 'Mechanical';

SELECT TOP (15)
    tr.TowRequestId,
    tr.RequestNumber,
    tr.VehiclePlate,
    tr.Status,
    tr.ActualDistanceKm,
    tr.AllowedDistanceKm,
    tr.OverageAmount,
    tr.CreatedAt
FROM dbo.TowRequests AS tr
WHERE tr.PolicyId = @PolicyId
  AND tr.IssueType = @IssueType
  AND tr.Status IN ('Approved', 'InProgress', 'Done')
ORDER BY tr.CreatedAt DESC;
GO

-- KEY QUERY 2: Date-Range & Status Financial/Dispatch Report on >120,000 Rows
-- Uses: IX_TowRequests_Status_CreatedAt_Covering (Status ASC, CreatedAt DESC)
-- Note SARGable date filter: CreatedAt >= @StartDate AND CreatedAt < @EndDate
DECLARE @Status VARCHAR(25) = 'Done',
        @StartDate DATETIME2(0) = '2026-10-01T00:00:00',
        @EndDate   DATETIME2(0) = '2026-11-01T00:00:00';

SELECT TOP (50)
    tr.TowRequestId,
    tr.RequestNumber,
    tr.VehiclePlate,
    tr.VehicleModel,
    tr.IssueType,
    tr.ActualDistanceKm,
    tr.OverageKm,
    tr.OverageAmount,
    tr.CashCollected,
    tr.CreatedAt
FROM dbo.TowRequests AS tr
WHERE tr.Status = @Status
  AND tr.CreatedAt >= @StartDate
  AND tr.CreatedAt < @EndDate
ORDER BY tr.CreatedAt DESC;
GO

-- KEY QUERY 3: Fast Vehicle License Plate History Lookup
-- Uses: IX_TowRequests_VehiclePlate_CreatedAt (VehiclePlate ASC, CreatedAt DESC)
DECLARE @SearchPlate VARCHAR(30) = 'M 100001';

SELECT
    tr.TowRequestId,
    tr.RequestNumber,
    tr.VehiclePlate,
    tr.VehicleModel,
    tr.IssueType,
    tr.Status,
    tr.PickupAddress,
    tr.DestinationAddress,
    tr.ActualDistanceKm,
    tr.OverageAmount,
    tr.CreatedAt
FROM dbo.TowRequests AS tr
WHERE tr.VehiclePlate = @SearchPlate
ORDER BY tr.CreatedAt DESC;
GO

SET STATISTICS IO, TIME OFF;
GO

/*==============================================================================
  PART B: BUSINESS RULE & CONSTRAINT TESTS (EXPECTED TO CATCH ERRORS CLEANLY)
==============================================================================*/

-- TEST 1: Trigger Immutability Check — Attempt to modify a finalized ('Done') TowRequest
BEGIN TRY
    UPDATE dbo.TowRequests
    SET CashCollected = 9999.00
    WHERE RequestNumber = 'TOW/2026/900001'; -- Already 'Done'
END TRY
BEGIN CATCH
    PRINT CONCAT('[PASS - Trigger Blocked Edit on Done Ticket]: ', ERROR_MESSAGE());
END CATCH;
GO

-- TEST 2: Trigger Delete Protection — Attempt to DELETE a TowRequest
BEGIN TRY
    DELETE FROM dbo.TowRequests WHERE RequestNumber = 'TOW/2026/900001';
END TRY
BEGIN CATCH
    PRINT CONCAT('[PASS - Trigger Blocked Delete]: ', ERROR_MESSAGE());
END CATCH;
GO

-- TEST 3: Cooldown Interval Restriction — Policy 3 ('POL-2026-COOLDOWN7') had a tow 2 days ago
SELECT
    PolicyNumber,
    TargetCategory,
    IsEligible,
    RequiredCooldownDays,
    DaysSinceLastTow,
    StatusBanner
FROM dbo.tvf_CheckPolicyEligibility(3, 'Mechanical');
GO

-- TEST 4: Accident Quota Exhaustion — Policy 4 ('POL-2026-NO-ACCIDENT') has 0 Accident tows left
SELECT
    PolicyNumber,
    TargetCategory,
    IsEligible,
    RemainingCategoryTows,
    StatusBanner
FROM dbo.tvf_CheckPolicyEligibility(4, 'Accident');
GO
