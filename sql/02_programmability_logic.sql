/*==============================================================================
  GIN401 - LAB PROJECT: ROADSIDE ASSISTANCE & TOWING CAD DISPATCH SYSTEM
  Script 02: T-SQL Programmability (Functions, Triggers, Window Views &
             Authorized Stored Procedures with SESSION_CONTEXT & Concurrency)
  DBMS: Microsoft SQL Server
==============================================================================*/
USE GIN401_TowDispatch;
GO
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

/*==============================================================================
  1A. SCALAR FUNCTION: dbo.fn_CalculateStraightLineDistanceKm
  Computes pure geodesic Haversine straight-line distance in KM between two
  coordinates. Explicitly separated from road distance so straight-line math is
  NEVER misrepresented as actual driving distance.
==============================================================================*/
DROP FUNCTION IF EXISTS dbo.fn_EstimateRoadHeuristicKm;
GO

CREATE OR ALTER FUNCTION dbo.fn_CalculateStraightLineDistanceKm
(
    @Lat1 DECIMAL(9,6),
    @Lng1 DECIMAL(9,6),
    @Lat2 DECIMAL(9,6),
    @Lng2 DECIMAL(9,6)
)
RETURNS DECIMAL(8,2)
WITH SCHEMABINDING
AS
BEGIN
    IF @Lat1 IS NULL OR @Lng1 IS NULL OR @Lat2 IS NULL OR @Lng2 IS NULL
        RETURN 1.00;

    DECLARE @EarthRadiusKm FLOAT = 6371.0;
    DECLARE @dLat FLOAT = RADIANS(CAST(@Lat2 - @Lat1 AS FLOAT));
    DECLARE @dLng FLOAT = RADIANS(CAST(@Lng2 - @Lng1 AS FLOAT));

    DECLARE @a FLOAT =
        SIN(@dLat / 2.0) * SIN(@dLat / 2.0) +
        COS(RADIANS(CAST(@Lat1 AS FLOAT))) * COS(RADIANS(CAST(@Lat2 AS FLOAT))) *
        SIN(@dLng / 2.0) * SIN(@dLng / 2.0);

    IF @a > 1.0 SET @a = 1.0;
    IF @a < 0.0 SET @a = 0.0;

    DECLARE @c FLOAT = 2.0 * ATN2(SQRT(@a), SQRT(1.0 - @a));
    DECLARE @StraightKm FLOAT = @EarthRadiusKm * @c;

    IF @StraightKm < 0.20 SET @StraightKm = 0.20;
    RETURN CAST(ROUND(@StraightKm, 2) AS DECIMAL(8,2));
END;
GO

/*==============================================================================
  1B. SCALAR FUNCTION: dbo.fn_EstimateRoadHeuristicKm
  Fallback road-distance heuristic used ONLY when external routing (OSRM) is
  offline and no dispatcher-verified road distance was supplied. Always tagged
  with DistanceSource = 'HeuristicFallbackEstimate'.
==============================================================================*/
CREATE OR ALTER FUNCTION dbo.fn_EstimateRoadHeuristicKm
(
    @Lat1 DECIMAL(9,6),
    @Lng1 DECIMAL(9,6),
    @Lat2 DECIMAL(9,6),
    @Lng2 DECIMAL(9,6)
)
RETURNS DECIMAL(8,2)
WITH SCHEMABINDING
AS
BEGIN
    DECLARE @StraightKm DECIMAL(8,2) = dbo.fn_CalculateStraightLineDistanceKm(@Lat1, @Lng1, @Lat2, @Lng2);
    DECLARE @EstimatedKm FLOAT = CAST(@StraightKm AS FLOAT) * 1.42;
    IF @EstimatedKm < 3.00 SET @EstimatedKm = 3.00;
    RETURN CAST(ROUND(@EstimatedKm, 2) AS DECIMAL(8,2));
END;
GO

/*==============================================================================
  2A. TABLE-VALUED FUNCTION: dbo.tvf_GetActiveTariff
  Resolves the effective Tariff from dbo.Tariffs for a given IssueType and date.
==============================================================================*/
CREATE OR ALTER FUNCTION dbo.tvf_GetActiveTariff
(
    @IssueType  VARCHAR(20),
    @AsOfDate   DATE
)
RETURNS @Tariff TABLE
(
    TariffId        INT,
    TariffCode      VARCHAR(30),
    TariffName      NVARCHAR(100),
    ServiceCategory VARCHAR(20),
    BaseFee         DECIMAL(10,2),
    PricePerKm      DECIMAL(8,2),
    NightSurcharge  DECIMAL(10,2)
)
AS
BEGIN
    DECLARE @TargetCategory VARCHAR(20) =
        CASE WHEN @IssueType IN ('Accident', 'Winch') THEN 'Accident' ELSE 'Mechanical' END;

    INSERT INTO @Tariff
    SELECT TOP (1)
        t.TariffId, t.TariffCode, t.TariffName, t.ServiceCategory,
        t.BaseFee, t.PricePerKm, t.NightSurcharge
    FROM dbo.Tariffs AS t
    WHERE t.ServiceCategory IN (@TargetCategory, 'All')
      AND t.EffectiveFrom <= @AsOfDate
      AND (t.EffectiveTo IS NULL OR t.EffectiveTo >= @AsOfDate)
    ORDER BY
        CASE WHEN t.ServiceCategory = @TargetCategory THEN 0 ELSE 1 END ASC,
        t.EffectiveFrom DESC,
        t.TariffId DESC;

    IF NOT EXISTS (SELECT 1 FROM @Tariff)
    BEGIN
        INSERT INTO @Tariff
        SELECT TOP (1)
            t.TariffId, t.TariffCode, t.TariffName, t.ServiceCategory,
            t.BaseFee, t.PricePerKm, t.NightSurcharge
        FROM dbo.Tariffs AS t
        ORDER BY t.IsActive DESC, t.EffectiveFrom DESC, t.TariffId DESC;
    END;

    RETURN;
END;
GO

/*==============================================================================
  2B. TABLE-VALUED FUNCTION: dbo.tvf_CheckPolicyEligibility
  Evaluates a customer's Insurance Policy for a given Breakdown IssueType:
  - Maps IssueType ('Accident','Winch' -> 'Accident', others -> 'Mechanical')
  - Finds first sequential Quota Tier with remaining tows > 0
  - Checks Cooldown Interval restriction (MinIntervalDays since last tow of type)
==============================================================================*/
CREATE OR ALTER FUNCTION dbo.tvf_CheckPolicyEligibility
(
    @PolicyId   INT,
    @IssueType  VARCHAR(20)
)
RETURNS @Result TABLE
(
    PolicyId                INT,
    PolicyNumber            VARCHAR(40),
    ProviderId              INT,
    TargetCategory          VARCHAR(20),
    IsEligible              BIT,
    MatchedQuotaTierId      INT,
    MatchedTierName         NVARCHAR(120),
    AllowedDistanceKm       DECIMAL(8,2),
    RemainingCategoryTows   INT,
    RequiredCooldownDays    INT,
    DaysSinceLastTow        DECIMAL(8,2),
    LastTowRequestNumber    VARCHAR(30),
    LastTowDate             DATETIME2(0),
    StatusBanner            NVARCHAR(400)
)
AS
BEGIN
    DECLARE @TargetCategory VARCHAR(20) =
        CASE WHEN @IssueType IN ('Accident', 'Winch') THEN 'Accident' ELSE 'Mechanical' END;

    DECLARE @PolicyNumber VARCHAR(40),
            @ProviderId INT,
            @ExpirationDate DATE,
            @PolicyStatus VARCHAR(20),
            @DefaultAllowedKm DECIMAL(8,2),
            @DefaultCooldown INT;

    SELECT
        @PolicyNumber     = p.PolicyNumber,
        @ProviderId       = p.ProviderId,
        @ExpirationDate   = p.ExpirationDate,
        @PolicyStatus     = p.PolicyStatus,
        @DefaultAllowedKm = p.DefaultAllowedKm,
        @DefaultCooldown  = p.DefaultMinIntervalDays
    FROM dbo.InsurancePolicies AS p
    WHERE p.PolicyId = @PolicyId;

    IF @PolicyNumber IS NULL
    BEGIN
        INSERT INTO @Result VALUES (@PolicyId, 'UNKNOWN', NULL, @TargetCategory, 0, NULL, NULL, 0, 0, 0, NULL, NULL, NULL,
            N'Insurance Policy not found. Direct customer invoicing required.');
        RETURN;
    END;

    -- 1. Check Policy Expiration
    IF @ExpirationDate < CAST(SYSDATETIME() AS DATE) OR @PolicyStatus = 'Expired'
    BEGIN
        INSERT INTO @Result VALUES (@PolicyId, @PolicyNumber, @ProviderId, @TargetCategory, 0, NULL, NULL, 0, 0, 0, NULL, NULL, NULL,
            CONCAT(N'POLICY EXPIRED: Policy ', @PolicyNumber, N' expired on ', CONVERT(VARCHAR(10), @ExpirationDate, 23), N'. Direct customer billing required.'));
        RETURN;
    END;

    -- 2. Calculate Remaining Tows for this Category across all PolicyQuotaTiers
    DECLARE @RemainingCategoryTows INT = 0;
    SELECT @RemainingCategoryTows = ISNULL(SUM(qt.AllowedTows - qt.UsedTows), 0)
    FROM dbo.PolicyQuotaTiers AS qt
    WHERE qt.PolicyId = @PolicyId
      AND qt.CoverageType IN (@TargetCategory, 'All');

    -- Find next sequential tier with remaining quota
    DECLARE @MatchedTierId INT = NULL,
            @TierAllowedKm DECIMAL(8,2) = 0,
            @TierCooldown INT = 0,
            @TierSeq INT = 0,
            @TierAllowedTows INT = 0,
            @TierRemaining INT = 0,
            @TierCovType VARCHAR(20) = NULL;

    SELECT TOP (1)
        @MatchedTierId   = qt.QuotaTierId,
        @TierAllowedKm   = qt.MaxDistanceKm,
        @TierCooldown    = qt.MinIntervalDays,
        @TierSeq         = qt.TierSequence,
        @TierAllowedTows = qt.AllowedTows,
        @TierRemaining   = (qt.AllowedTows - qt.UsedTows),
        @TierCovType     = qt.CoverageType
    FROM dbo.PolicyQuotaTiers AS qt
    WHERE qt.PolicyId = @PolicyId
      AND qt.CoverageType IN (@TargetCategory, 'All')
      AND qt.UsedTows < qt.AllowedTows
    ORDER BY qt.TierSequence ASC, qt.QuotaTierId ASC;

    -- 3. Check Quota Exhaustion
    IF @RemainingCategoryTows <= 0 OR @MatchedTierId IS NULL
    BEGIN
        DECLARE @ExhaustMsg NVARCHAR(400) =
            CASE WHEN @TargetCategory = 'Accident'
                THEN CONCAT(N'ACCIDENT TOW NOT ALLOWED: Policy ', @PolicyNumber, N' does not allow any accidental tows anymore (0 remaining). Direct customer billing required.')
                ELSE CONCAT(N'MECHANICAL QUOTA EXHAUSTED: Policy ', @PolicyNumber, N' has 0 remaining mechanical breakdown tows. Direct customer billing required.')
            END;

        INSERT INTO @Result VALUES (@PolicyId, @PolicyNumber, @ProviderId, @TargetCategory, 0, NULL, NULL, 0, 0, 0, NULL, NULL, NULL, @ExhaustMsg);
        RETURN;
    END;

    -- 4. Check Cooldown Interval Passed Since Last Tow of Same Category
    DECLARE @EffectiveCooldown INT = CASE WHEN @TierCooldown > 0 THEN @TierCooldown ELSE @DefaultCooldown END;
    DECLARE @LastTowNumber VARCHAR(30) = NULL,
            @LastTowDate DATETIME2(0) = NULL,
            @DaysElapsed DECIMAL(8,2) = NULL;

    IF @EffectiveCooldown > 0
    BEGIN
        SELECT TOP (1)
            @LastTowNumber = tr.RequestNumber,
            @LastTowDate   = tr.CreatedAt,
            @DaysElapsed   = CAST(DATEDIFF(MINUTE, tr.CreatedAt, SYSDATETIME()) / 1440.0 AS DECIMAL(8,2))
        FROM dbo.TowRequests AS tr
        WHERE tr.PolicyId = @PolicyId
          AND tr.Status IN ('Approved', 'InProgress', 'Done')
          AND (
                (@TargetCategory = 'Accident' AND tr.IssueType IN ('Accident', 'Winch'))
                OR (@TargetCategory = 'Mechanical' AND tr.IssueType NOT IN ('Accident', 'Winch'))
              )
        ORDER BY tr.CreatedAt DESC;

        IF @LastTowDate IS NOT NULL AND @DaysElapsed < @EffectiveCooldown
        BEGIN
            DECLARE @DaysLeft DECIMAL(8,1) = CAST(@EffectiveCooldown - @DaysElapsed AS DECIMAL(8,1));
            INSERT INTO @Result VALUES (
                @PolicyId, @PolicyNumber, @ProviderId, @TargetCategory, 0,
                @MatchedTierId,
                CONCAT(N'Tier #', @TierSeq, N' (', @TierCovType, N' - Max ', CAST(@TierAllowedKm AS INT), N' KM)'),
                @TierAllowedKm, @RemainingCategoryTows, @EffectiveCooldown, @DaysElapsed, @LastTowNumber, @LastTowDate,
                CONCAT(N'COOLDOWN RESTRICTION: Policy ', @PolicyNumber, N' requires at least ', @EffectiveCooldown,
                       N' day(s) between ', @TargetCategory, N' tows. Last tow (', @LastTowNumber, N') was ',
                       @DaysElapsed, N' day(s) ago. Wait ', @DaysLeft, N' more day(s).')
            );
            RETURN;
        END;
    END;

    -- 5. Eligible! Return Matched Sequential Tier
    DECLARE @TierDesc NVARCHAR(120) = CONCAT(N'Tier #', @TierSeq, N': ', @TierAllowedTows, N'x ', @TierCovType, N' (Max ', CAST(@TierAllowedKm AS INT), N' KM)');
    INSERT INTO @Result VALUES (
        @PolicyId, @PolicyNumber, @ProviderId, @TargetCategory, 1,
        @MatchedTierId, @TierDesc, @TierAllowedKm, @RemainingCategoryTows,
        @EffectiveCooldown, @DaysElapsed, @LastTowNumber, @LastTowDate,
        CONCAT(N'ELIGIBLE: Applied ', @TierDesc, N' — ', @TierRemaining, N' left in tier (Total ', @RemainingCategoryTows, N' ', @TargetCategory, N' left).')
    );
    RETURN;
END;
GO

/*==============================================================================
  3A. TRIGGER: dbo.trg_TowRequests_ImmutabilityAndAudit
  - Blocks DELETE operations on TowRequests
  - Blocks modification of finalized requests ('Done', 'UnableToLoad', 'Rejected')
  - Reads the authenticated application user from SQL Server SESSION_CONTEXT
    (AppUserId, AppUsername, AppFullName) to record which dispatcher acted!
==============================================================================*/
CREATE OR ALTER TRIGGER dbo.trg_TowRequests_ImmutabilityAndAudit
ON dbo.TowRequests
AFTER INSERT, UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;

    -- 1. Block physical deletion of TowRequests
    IF EXISTS (SELECT 1 FROM deleted) AND NOT EXISTS (SELECT 1 FROM inserted)
    BEGIN
        THROW 50011, 'Security Policy Violation: Tow requests cannot be physically deleted from the database.', 1;
    END;

    -- 2. Block updates to already-finalized TowRequests ('Done', 'UnableToLoad', 'Rejected')
    IF EXISTS (
        SELECT 1
        FROM deleted AS d
        INNER JOIN inserted AS i ON d.TowRequestId = i.TowRequestId
        WHERE d.Status IN ('Done', 'UnableToLoad', 'Rejected')
    )
    BEGIN
        DECLARE @LockedReq VARCHAR(30), @LockedStatus VARCHAR(25);
        SELECT TOP (1) @LockedReq = d.RequestNumber, @LockedStatus = d.Status
        FROM deleted AS d
        WHERE d.Status IN ('Done', 'UnableToLoad', 'Rejected');

        DECLARE @ErrMsg NVARCHAR(300) = CONCAT(
            N'Immutability Violation: Tow Request ', @LockedReq,
            N' is finalized (', @LockedStatus,
            N') and cannot be undone, reopened, or modified.'
        );
        THROW 50010, @ErrMsg, 1;
    END;

    -- 3. Read authenticated dispatcher identity from SQL Server SESSION_CONTEXT
    DECLARE @AppUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    DECLARE @AppUsername VARCHAR(60) = COALESCE(
        NULLIF(LTRIM(RTRIM(CAST(SESSION_CONTEXT(N'AppUsername') AS VARCHAR(60)))), ''),
        CONCAT('SQL:', LEFT(SUSER_SNAME(), 55))
    );
    DECLARE @AppFullName NVARCHAR(120) = CAST(SESSION_CONTEXT(N'AppFullName') AS NVARCHAR(120));

    -- 4. Insert Audit Log entries for newly created or state/assignment-changed TowRequests
    INSERT INTO dbo.TowAuditLogs
    (
        TowRequestId, RequestNumber, OldStatus, NewStatus, ActionNote,
        DispatcherUserId, DispatcherUsername, DispatcherFullName, SqlLoginName
    )
    SELECT
        i.TowRequestId,
        i.RequestNumber,
        d.Status AS OldStatus,
        i.Status AS NewStatus,
        CASE
            WHEN d.TowRequestId IS NULL THEN CONCAT(
                N'Ticket created with status ', i.Status,
                N' for vehicle ', v.VehiclePlate,
                N' (', i.DistanceSource, N': ', i.RouteDistanceKm, N' km)'
            )
            WHEN d.Status <> i.Status THEN CONCAT(
                N'Status transitioned from ', d.Status, N' to ', i.Status
            )
            ELSE CONCAT(N'Ticket dispatch/details updated while in ', i.Status, N' state')
        END,
        @AppUserId,
        @AppUsername,
        @AppFullName,
        SUSER_SNAME()
    FROM inserted AS i
    INNER JOIN dbo.Vehicles AS v ON i.VehicleId = v.VehicleId
    LEFT JOIN deleted AS d ON i.TowRequestId = d.TowRequestId
    WHERE d.TowRequestId IS NULL
       OR d.Status <> i.Status
       OR ISNULL(d.AssignedTruckId, 0) <> ISNULL(i.AssignedTruckId, 0)
       OR ISNULL(d.SubcontractorId, 0) <> ISNULL(i.SubcontractorId, 0);
END;
GO

/*==============================================================================
  3B. TRIGGER: dbo.trg_TowInvoices_ProtectHistoricalPricing
  - Blocks DELETE on TowInvoices
  - Prevents altering historical tariff rates or billed obligations once an
    invoice is issued ('Unpaid', 'PartiallyPaid', 'Paid', 'Void'), while allowing
    payment settlement updates (InsurerPaidAmount, CustomerPaidAmount, InvoiceStatus).
==============================================================================*/
CREATE OR ALTER TRIGGER dbo.trg_TowInvoices_ProtectHistoricalPricing
ON dbo.TowInvoices
AFTER UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;

    IF EXISTS (SELECT 1 FROM deleted) AND NOT EXISTS (SELECT 1 FROM inserted)
    BEGIN
        THROW 50012, 'Financial Audit Violation: Issued tow invoices cannot be deleted.', 1;
    END;

    IF EXISTS (
        SELECT 1
        FROM deleted AS d
        INNER JOIN inserted AS i ON d.InvoiceId = i.InvoiceId
        WHERE d.InvoiceStatus IN ('Unpaid', 'PartiallyPaid', 'Paid', 'Void')
          AND (
                d.TariffId <> i.TariffId
                OR d.AppliedBaseFee <> i.AppliedBaseFee
                OR d.AppliedPricePerKm <> i.AppliedPricePerKm
                OR d.AppliedNightSurcharge <> i.AppliedNightSurcharge
                OR d.InsurerBilledAmount <> i.InsurerBilledAmount
                OR d.CustomerBilledAmount <> i.CustomerBilledAmount
                OR d.TotalAmount <> i.TotalAmount
              )
    )
    BEGIN
        THROW 50013, 'Historical Pricing Violation: Issued invoice rates and billed obligations are locked and cannot be altered retroactively.', 1;
    END;
END;
GO

/*==============================================================================
  4A. VIEW WITH WINDOW FUNCTIONS: dbo.vw_FleetPriorityQueueAndRankings
  Uses ROW_NUMBER(), SUM() OVER(), and COUNT() OVER() across normalized tables.
==============================================================================*/
CREATE OR ALTER VIEW dbo.vw_FleetPriorityQueueAndRankings
AS
SELECT
    tr.TowRequestId,
    tr.RequestNumber,
    tr.AssignedTruckId,
    t.TruckCode,
    t.LicensePlate AS TruckPlate,
    COALESCE(drv.FullName, N'Unassigned Driver') AS DriverName,
    t.FleetStatus,
    v.VehiclePlate,
    v.VehicleModel,
    tr.IssueType,
    tr.Status,
    tr.TruckPrioritySequence,
    tr.PickupAddress,
    tr.PickupLat,
    tr.PickupLng,
    tr.DestinationAddress,
    tr.DestinationLat,
    tr.DestinationLng,
    tr.RouteDistanceKm AS ActualDistanceKm,
    tr.DistanceSource,
    ISNULL(inv.CustomerBilledAmount, 0.00) AS OverageAmount,
    ISNULL(inv.InsurerBilledAmount, 0.00) AS InsurerBilledAmount,
    ROW_NUMBER() OVER (
        PARTITION BY tr.AssignedTruckId
        ORDER BY tr.TruckPrioritySequence ASC, tr.TowRequestId ASC
    ) AS StopNumberInTruckQueue,
    SUM(tr.RouteDistanceKm) OVER (
        PARTITION BY tr.AssignedTruckId
        ORDER BY tr.TruckPrioritySequence ASC, tr.TowRequestId ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS CumulativeQueueDistanceKm,
    COUNT(*) OVER (
        PARTITION BY tr.AssignedTruckId
    ) AS TotalActiveJobsForTruck
FROM dbo.TowRequests AS tr
INNER JOIN dbo.TowTrucks AS t ON tr.AssignedTruckId = t.TruckId
INNER JOIN dbo.Vehicles AS v ON tr.VehicleId = v.VehicleId
LEFT JOIN dbo.TowInvoices AS inv ON tr.TowRequestId = inv.TowRequestId
LEFT JOIN dbo.DriverTruckAssignments AS dta
    ON dta.TruckId = t.TruckId AND dta.EndDate IS NULL
LEFT JOIN dbo.Drivers AS drv
    ON drv.DriverId = COALESCE(tr.AssignedDriverId, dta.DriverId)
WHERE tr.Status IN ('Approved', 'InProgress');
GO

/*==============================================================================
  4B. VIEW: dbo.vw_DriverPayrollAndCashReport
  Computes Driver Payroll per normalized dbo.Drivers entity, joining active
  DriverTruckAssignments and on-scene cash payments from dbo.InvoicePayments.
==============================================================================*/
CREATE OR ALTER VIEW dbo.vw_DriverPayrollAndCashReport
AS
WITH MonthlyDriverTows AS
(
    SELECT
        tr.AssignedDriverId AS DriverId,
        COUNT(*) AS CompletedTowsThisMonth,
        COUNT(CASE WHEN tr.IsNightShift = 1 THEN 1 END) AS NightShiftTowsCount
    FROM dbo.TowRequests AS tr
    WHERE tr.Status = 'Done'
      AND tr.CreatedAt >= '2026-11-01'
      AND tr.AssignedDriverId IS NOT NULL
    GROUP BY tr.AssignedDriverId
),
MonthlyDriverCash AS
(
    SELECT
        ip.CollectedByDriverId AS DriverId,
        SUM(ip.AmountPaid) AS TotalCashCollectedByDriver
    FROM dbo.InvoicePayments AS ip
    WHERE ip.PaymentMethod = 'OnSceneCash'
      AND ip.PaidAt >= '2026-11-01'
      AND ip.CollectedByDriverId IS NOT NULL
    GROUP BY ip.CollectedByDriverId
)
SELECT
    d.DriverId,
    d.EmployeeCode,
    d.FullName AS DriverName,
    d.Phone AS DriverPhone,
    d.DriverStatus,
    t.TruckId,
    ISNULL(t.TruckCode, 'UNASSIGNED') AS TruckCode,
    ISNULL(t.LicensePlate, '—') AS LicensePlate,
    ISNULL(t.FleetStatus, 'OffDuty') AS FleetStatus,
    d.BaseMonthlySalary,
    d.OvertimeRatePerTow,
    d.IsWorkingOffDay,
    ISNULL(mt.CompletedTowsThisMonth, 0) AS CompletedTowsThisMonth,
    CASE
        WHEN d.IsWorkingOffDay = 1 THEN ISNULL(mt.CompletedTowsThisMonth, 0)
        ELSE ISNULL(mt.NightShiftTowsCount, 0)
    END AS OvertimeTowsCount,
    CAST(
        (CASE
            WHEN d.IsWorkingOffDay = 1 THEN ISNULL(mt.CompletedTowsThisMonth, 0)
            ELSE ISNULL(mt.NightShiftTowsCount, 0)
        END) * d.OvertimeRatePerTow AS DECIMAL(10,2)
    ) AS OvertimePayEarned,
    ISNULL(mc.TotalCashCollectedByDriver, 0.00) AS TotalCashCollectedByDriver,
    CAST(
        d.BaseMonthlySalary
        + (CASE
            WHEN d.IsWorkingOffDay = 1 THEN ISNULL(mt.CompletedTowsThisMonth, 0)
            ELSE ISNULL(mt.NightShiftTowsCount, 0)
          END) * d.OvertimeRatePerTow
        - ISNULL(mc.TotalCashCollectedByDriver, 0.00)
        AS DECIMAL(10,2)
    ) AS NetSalaryPayoutAfterCashDeduction
FROM dbo.Drivers AS d
LEFT JOIN dbo.DriverTruckAssignments AS dta
    ON dta.DriverId = d.DriverId AND dta.EndDate IS NULL
LEFT JOIN dbo.TowTrucks AS t
    ON t.TruckId = dta.TruckId
LEFT JOIN MonthlyDriverTows AS mt
    ON mt.DriverId = d.DriverId
LEFT JOIN MonthlyDriverCash AS mc
    ON mc.DriverId = d.DriverId;
GO

/*==============================================================================
  5A. AUTHENTICATION & SESSION_CONTEXT STORED PROCEDURES
  Ensures pooled database connections always have a clean, validated dispatcher
  SESSION_CONTEXT before executing any operational query or mutation.
==============================================================================*/
CREATE OR ALTER PROCEDURE dbo.usp_ClearDispatcherSessionContext
AS
BEGIN
    SET NOCOUNT ON;
    EXEC sys.sp_set_session_context @key = N'AppUserId', @value = NULL;
    EXEC sys.sp_set_session_context @key = N'AppUsername', @value = NULL;
    EXEC sys.sp_set_session_context @key = N'AppFullName', @value = NULL;
    EXEC sys.sp_set_session_context @key = N'AppAccessRole', @value = NULL;
    EXEC sys.sp_set_session_context @key = N'CanManageUsers', @value = NULL;
END;
GO

CREATE OR ALTER PROCEDURE dbo.usp_GetSystemUserForAuth
    @Username VARCHAR(60)
AS
BEGIN
    SET NOCOUNT ON;

    SELECT
        u.UserId,
        u.Username,
        u.PasswordHash,
        u.FullName,
        u.RoleTitle,
        u.Department,
        u.StationCode,
        u.IsActive,
        ug.GroupCode AS AccessRole,
        ug.CanDispatch,
        ug.CanManageFleet,
        ug.CanManagePolicies,
        ug.CanManageBilling,
        ug.CanManageUsers,
        u.GroupId,
        ug.GroupCode,
        ug.GroupName
    FROM dbo.SystemUsers AS u
    INNER JOIN dbo.UserGroups AS ug ON u.GroupId = ug.GroupId
    WHERE LOWER(LTRIM(RTRIM(u.Username))) = LOWER(LTRIM(RTRIM(@Username)))
      AND u.IsActive = 1;
END;
GO

CREATE OR ALTER PROCEDURE dbo.usp_SetDispatcherSessionContext
    @UserId             INT,
    @ExpectedUsername   VARCHAR(60),
    @UpdateLastLogin    BIT = 0
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @DbUsername VARCHAR(60),
            @DbFullName NVARCHAR(120),
            @DbGroupCode VARCHAR(30),
            @DbCanManageUsers BIT;

    SELECT
        @DbUsername       = u.Username,
        @DbFullName       = u.FullName,
        @DbGroupCode      = ug.GroupCode,
        @DbCanManageUsers = ug.CanManageUsers
    FROM dbo.SystemUsers AS u
    INNER JOIN dbo.UserGroups AS ug ON u.GroupId = ug.GroupId
    WHERE u.UserId = @UserId
      AND LOWER(u.Username) = LOWER(LTRIM(RTRIM(@ExpectedUsername)))
      AND u.IsActive = 1;

    IF @DbUsername IS NULL
    BEGIN
        EXEC dbo.usp_ClearDispatcherSessionContext;
        THROW 50030, 'Session Context Validation Failed: Operator account is invalid or inactive.', 1;
    END;

    EXEC sys.sp_set_session_context @key = N'AppUserId', @value = @UserId;
    EXEC sys.sp_set_session_context @key = N'AppUsername', @value = @DbUsername;
    EXEC sys.sp_set_session_context @key = N'AppFullName', @value = @DbFullName;
    EXEC sys.sp_set_session_context @key = N'AppAccessRole', @value = @DbGroupCode;
    EXEC sys.sp_set_session_context @key = N'CanManageUsers', @value = @DbCanManageUsers;

    IF @UpdateLastLogin = 1
    BEGIN
        UPDATE dbo.SystemUsers
        SET LastLoginAt = SYSUTCDATETIME()
        WHERE UserId = @UserId;
    END;

    SELECT
        TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT) AS ConfirmedUserId,
        CAST(SESSION_CONTEXT(N'AppUsername') AS VARCHAR(60)) AS ConfirmedUsername,
        CAST(SESSION_CONTEXT(N'AppFullName') AS NVARCHAR(120)) AS ConfirmedFullName;
END;
GO

/*==============================================================================
  5B. STORED PROCEDURE: dbo.usp_CheckPolicyAndPreviewTariff
  Evaluates policy eligibility, computes geodesic vs routed distance, selects
  the active Tariff, and previews separate Insurer vs Customer obligations.
==============================================================================*/
CREATE OR ALTER PROCEDURE dbo.usp_CheckPolicyAndPreviewTariff
    @PolicyId               INT = NULL,
    @IssueType              VARCHAR(20),
    @PickupLat              DECIMAL(9,6),
    @PickupLng              DECIMAL(9,6),
    @DestinationLat         DECIMAL(9,6),
    @DestinationLng         DECIMAL(9,6),
    @RoutedDistanceKm       DECIMAL(8,2) = NULL,
    @DistanceSource         VARCHAR(30) = 'HeuristicFallbackEstimate',
    @RouteDurationMinutes   DECIMAL(6,1) = NULL,
    @IsNightShift           BIT = NULL
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @StraightKm DECIMAL(8,2) = dbo.fn_CalculateStraightLineDistanceKm(@PickupLat, @PickupLng, @DestinationLat, @DestinationLng);
    DECLARE @FinalSource VARCHAR(30) = @DistanceSource;
    DECLARE @FinalRouteKm DECIMAL(8,2);

    IF @RoutedDistanceKm IS NOT NULL AND @RoutedDistanceKm >= ROUND(@StraightKm * 0.95, 2)
        SET @FinalRouteKm = @RoutedDistanceKm;
    ELSE
    BEGIN
        SET @FinalRouteKm = dbo.fn_EstimateRoadHeuristicKm(@PickupLat, @PickupLng, @DestinationLat, @DestinationLng);
        SET @FinalSource = 'HeuristicFallbackEstimate';
    END;

    DECLARE @EffectiveNight BIT = COALESCE(
        @IsNightShift,
        CASE WHEN DATEPART(HOUR, SYSDATETIME()) >= 19 OR DATEPART(HOUR, SYSDATETIME()) < 7 THEN 1 ELSE 0 END
    );

    -- Resolve active tariff
    DECLARE @TariffId INT, @TariffCode VARCHAR(30), @TariffName NVARCHAR(100),
            @BaseFee DECIMAL(10,2), @PricePerKm DECIMAL(8,2), @NightSurcharge DECIMAL(10,2);

    SELECT
        @TariffId       = tf.TariffId,
        @TariffCode     = tf.TariffCode,
        @TariffName     = tf.TariffName,
        @BaseFee        = tf.BaseFee,
        @PricePerKm     = tf.PricePerKm,
        @NightSurcharge = CASE WHEN @EffectiveNight = 1 THEN tf.NightSurcharge ELSE 0.00 END
    FROM dbo.tvf_GetActiveTariff(@IssueType, CAST(SYSDATETIME() AS DATE)) AS tf;

    -- Evaluate policy if supplied
    DECLARE @IsEligible BIT = 0,
            @PolicyNumber VARCHAR(40) = 'CASH-DIRECT',
            @TargetCategory VARCHAR(20) = CASE WHEN @IssueType IN ('Accident', 'Winch') THEN 'Accident' ELSE 'Mechanical' END,
            @MatchedQuotaTierId INT = NULL,
            @MatchedTierName NVARCHAR(120) = NULL,
            @AllowedKm DECIMAL(8,2) = 0.00,
            @RemainingTows INT = 0,
            @RequiredCooldown INT = 0,
            @DaysSinceLast DECIMAL(8,2) = NULL,
            @LastTowNum VARCHAR(30) = NULL,
            @LastTowDate DATETIME2(0) = NULL,
            @StatusBanner NVARCHAR(400) = N'Direct Customer Billing (No Insurance Policy Selected)';

    IF @PolicyId IS NOT NULL AND @PolicyId > 0
    BEGIN
        SELECT
            @PolicyNumber       = e.PolicyNumber,
            @TargetCategory     = e.TargetCategory,
            @IsEligible         = e.IsEligible,
            @MatchedQuotaTierId = e.MatchedQuotaTierId,
            @MatchedTierName    = e.MatchedTierName,
            @AllowedKm          = CASE WHEN e.IsEligible = 1 THEN e.AllowedDistanceKm ELSE 0.00 END,
            @RemainingTows      = e.RemainingCategoryTows,
            @RequiredCooldown   = e.RequiredCooldownDays,
            @DaysSinceLast      = e.DaysSinceLastTow,
            @LastTowNum         = e.LastTowRequestNumber,
            @LastTowDate        = e.LastTowDate,
            @StatusBanner       = e.StatusBanner
        FROM dbo.tvf_CheckPolicyEligibility(@PolicyId, @IssueType) AS e;
    END;

    DECLARE @CoveredKm DECIMAL(8,2) =
        CASE WHEN @IsEligible = 1 THEN
            (CASE WHEN @FinalRouteKm <= @AllowedKm THEN @FinalRouteKm ELSE @AllowedKm END)
        ELSE 0.00 END;

    DECLARE @OverageKm DECIMAL(8,2) =
        CASE WHEN @FinalRouteKm > @CoveredKm THEN (@FinalRouteKm - @CoveredKm) ELSE 0.00 END;

    DECLARE @InsurerBilled DECIMAL(10,2) =
        CASE WHEN @IsEligible = 1
             THEN ROUND(@BaseFee + (@CoveredKm * @PricePerKm) + @NightSurcharge, 2)
             ELSE 0.00
        END;

    DECLARE @CustomerBilled DECIMAL(10,2) =
        CASE WHEN @IsEligible = 1
             THEN ROUND(@OverageKm * @PricePerKm, 2)
             ELSE ROUND(@BaseFee + (@FinalRouteKm * @PricePerKm) + @NightSurcharge, 2)
        END;

    SELECT
        ISNULL(@PolicyId, 0) AS PolicyId,
        @PolicyNumber AS PolicyNumber,
        @TargetCategory AS TargetCategory,
        @IsEligible AS IsEligible,
        @MatchedQuotaTierId AS MatchedQuotaTierId,
        @MatchedTierName AS MatchedTierName,
        @AllowedKm AS AllowedDistanceKm,
        @RemainingTows AS RemainingCategoryTows,
        @RequiredCooldown AS RequiredCooldownDays,
        @DaysSinceLast AS DaysSinceLastTow,
        @LastTowNum AS LastTowRequestNumber,
        @LastTowDate AS LastTowDate,
        @StatusBanner AS StatusBanner,
        @StraightKm AS StraightLineDistanceKm,
        @FinalRouteKm AS CalculatedRoadKm,
        @FinalSource AS DistanceSource,
        @RouteDurationMinutes AS RouteDurationMinutes,
        @CoveredKm AS CoveredDistanceKm,
        @OverageKm AS OverageKm,
        @TariffId AS TariffId,
        @TariffCode AS TariffCode,
        @TariffName AS TariffName,
        @BaseFee AS AppliedBaseFee,
        @PricePerKm AS AppliedPricePerKm,
        @NightSurcharge AS AppliedNightSurcharge,
        @InsurerBilled AS InsurerBilledAmount,
        @CustomerBilled AS CustomerBilledAmount,
        (@InsurerBilled + @CustomerBilled) AS TotalInvoiceAmount;
END;
GO

/*==============================================================================
  5C. STORED PROCEDURE: dbo.usp_ApproveAndDispatchTow
  Multi-step ACID transaction with PESSIMISTIC CONCURRENCY LOCKING
  (WITH (UPDLOCK, ROWLOCK)) on TowRequests, TowTrucks, InsurancePolicies, and
  PolicyQuotaTiers. Resolves active driver from DriverTruckAssignments and
  issues the normalized TowInvoice with separate Insurer & Customer obligations.
==============================================================================*/
CREATE OR ALTER PROCEDURE dbo.usp_ApproveAndDispatchTow
    @TowRequestId       INT,
    @AssignedTruckId    INT = NULL,
    @SubcontractorId    INT = NULL,
    @SimulatedHoldMs    INT = 0
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @CurrentUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @CurrentUserId IS NULL
        THROW 50031, 'Security Context Violation: Authenticated dispatcher SESSION_CONTEXT(AppUserId) is required.', 1;

    BEGIN TRY
        BEGIN TRANSACTION;

        -- Step 1: Lock TowRequest row with UPDLOCK, ROWLOCK
        DECLARE @CurrentStatus      VARCHAR(25),
                @CustomerId         INT,
                @PolicyId           INT,
                @IssueType          VARCHAR(20),
                @RouteDistanceKm    DECIMAL(8,2),
                @IsNightShift       BIT,
                @RequestNumber      VARCHAR(30),
                @ExistingTruckId    INT,
                @ExistingSubId      INT;

        SELECT
            @CurrentStatus   = tr.Status,
            @CustomerId      = tr.CustomerId,
            @PolicyId        = tr.PolicyId,
            @IssueType       = tr.IssueType,
            @RouteDistanceKm = tr.RouteDistanceKm,
            @IsNightShift    = tr.IsNightShift,
            @RequestNumber   = tr.RequestNumber,
            @ExistingTruckId = tr.AssignedTruckId,
            @ExistingSubId   = tr.SubcontractorId
        FROM dbo.TowRequests AS tr WITH (UPDLOCK, ROWLOCK)
        WHERE tr.TowRequestId = @TowRequestId;

        IF @CurrentStatus IS NULL
            THROW 50001, 'Tow Request does not exist.', 1;

        IF @CurrentStatus NOT IN ('Draft', 'PendingInsurance')
        BEGIN
            DECLARE @StateErr NVARCHAR(200) = CONCAT(N'Dispatch Blocked: Request ', @RequestNumber, N' is already in status "', @CurrentStatus, N'".');
            THROW 50002, @StateErr, 1;
        END;

        DECLARE @FinalTruckId INT = COALESCE(@AssignedTruckId, @ExistingTruckId);
        DECLARE @FinalSubId   INT = CASE WHEN @FinalTruckId IS NOT NULL THEN NULL ELSE COALESCE(@SubcontractorId, @ExistingSubId) END;
        DECLARE @ResolvedDriverId INT = NULL;
        DECLARE @DefaultSubFee DECIMAL(10,2) = 0.00;

        IF @FinalTruckId IS NULL AND @FinalSubId IS NULL
            THROW 50003, 'Either an internal Tow Truck or an external Subcontractor must be selected for dispatch.', 1;

        -- Step 2: Validate & Lock internal TowTruck + resolve active Driver from DriverTruckAssignments
        IF @FinalTruckId IS NOT NULL
        BEGIN
            DECLARE @TruckStatus VARCHAR(20);
            SELECT @TruckStatus = t.FleetStatus
            FROM dbo.TowTrucks AS t WITH (UPDLOCK, ROWLOCK)
            WHERE t.TruckId = @FinalTruckId;

            IF @TruckStatus IS NULL
                THROW 50003, 'Assigned Tow Truck does not exist.', 1;
            IF @TruckStatus IN ('OffDuty', 'Maintenance')
                THROW 50004, 'Assigned Tow Truck is currently Off-Duty or in Maintenance and cannot be dispatched.', 1;

            SELECT @ResolvedDriverId = dta.DriverId
            FROM dbo.DriverTruckAssignments AS dta
            WHERE dta.TruckId = @FinalTruckId AND dta.EndDate IS NULL;
        END
        ELSE
        BEGIN
            SELECT @DefaultSubFee = s.DefaultDispatchFee
            FROM dbo.Subcontractors AS s
            WHERE s.SubcontractorId = @FinalSubId AND s.IsActive = 1;

            IF @DefaultSubFee IS NULL
                THROW 50006, 'Selected Subcontractor does not exist or is inactive.', 1;
        END;

        -- Step 3: If PolicyId is set, lock Policy & QuotaTiers with UPDLOCK, ROWLOCK
        DECLARE @MatchedQuotaTierId INT = NULL,
                @AllowedDistanceKm  DECIMAL(8,2) = 0.00,
                @InsurerProviderId  INT = NULL;

        IF @PolicyId IS NOT NULL
        BEGIN
            SELECT @InsurerProviderId = p.ProviderId
            FROM dbo.InsurancePolicies AS p WITH (UPDLOCK, ROWLOCK)
            WHERE p.PolicyId = @PolicyId;

            IF @SimulatedHoldMs > 0 AND @SimulatedHoldMs <= 5000
            BEGIN
                DECLARE @DelayStr CHAR(12) = CONVERT(CHAR(12), DATEADD(MILLISECOND, @SimulatedHoldMs, 0), 114);
                WAITFOR DELAY @DelayStr;
            END;

            DECLARE @IsEligible BIT, @StatusBanner NVARCHAR(400);
            SELECT
                @IsEligible         = elig.IsEligible,
                @MatchedQuotaTierId = elig.MatchedQuotaTierId,
                @AllowedDistanceKm  = elig.AllowedDistanceKm,
                @StatusBanner       = elig.StatusBanner
            FROM dbo.tvf_CheckPolicyEligibility(@PolicyId, @IssueType) AS elig;

            IF @IsEligible = 0 OR @MatchedQuotaTierId IS NULL
                THROW 50005, @StatusBanner, 1;

            -- Increment UsedTows on matched Quota Tier
            UPDATE dbo.PolicyQuotaTiers WITH (ROWLOCK)
            SET UsedTows = UsedTows + 1
            WHERE QuotaTierId = @MatchedQuotaTierId;

            -- Mark policy QuotaExceeded if all tiers are now full
            IF NOT EXISTS (
                SELECT 1
                FROM dbo.PolicyQuotaTiers
                WHERE PolicyId = @PolicyId AND UsedTows < AllowedTows
            )
            BEGIN
                UPDATE dbo.InsurancePolicies
                SET PolicyStatus = 'QuotaExceeded'
                WHERE PolicyId = @PolicyId;
            END;
        END;

        -- Step 4: Resolve active Tariff and finalize TowInvoice obligations
        DECLARE @TariffId INT, @BaseFee DECIMAL(10,2), @PricePerKm DECIMAL(8,2), @NightFee DECIMAL(10,2);
        SELECT
            @TariffId   = tf.TariffId,
            @BaseFee    = tf.BaseFee,
            @PricePerKm = tf.PricePerKm,
            @NightFee   = CASE WHEN @IsNightShift = 1 THEN tf.NightSurcharge ELSE 0.00 END
        FROM dbo.tvf_GetActiveTariff(@IssueType, CAST(SYSDATETIME() AS DATE)) AS tf;

        DECLARE @CoveredKm DECIMAL(8,2) =
            CASE WHEN @PolicyId IS NOT NULL THEN
                (CASE WHEN @RouteDistanceKm <= @AllowedDistanceKm THEN @RouteDistanceKm ELSE @AllowedDistanceKm END)
            ELSE 0.00 END;

        DECLARE @OverageKm DECIMAL(8,2) =
            CASE WHEN @RouteDistanceKm > @CoveredKm THEN (@RouteDistanceKm - @CoveredKm) ELSE 0.00 END;

        DECLARE @InsurerBilled DECIMAL(10,2) =
            CASE WHEN @PolicyId IS NOT NULL
                 THEN ROUND(@BaseFee + (@CoveredKm * @PricePerKm) + @NightFee, 2)
                 ELSE 0.00 END;

        DECLARE @CustomerBilled DECIMAL(10,2) =
            CASE WHEN @PolicyId IS NOT NULL
                 THEN ROUND(@OverageKm * @PricePerKm, 2)
                 ELSE ROUND(@BaseFee + (@RouteDistanceKm * @PricePerKm) + @NightFee, 2) END;

        DECLARE @TotalAmt DECIMAL(10,2) = @InsurerBilled + @CustomerBilled;

        IF EXISTS (SELECT 1 FROM dbo.TowInvoices WHERE TowRequestId = @TowRequestId)
        BEGIN
            UPDATE dbo.TowInvoices
            SET TariffId              = @TariffId,
                InsuranceProviderId   = @InsurerProviderId,
                AppliedBaseFee        = @BaseFee,
                AppliedPricePerKm     = @PricePerKm,
                AppliedNightSurcharge = @NightFee,
                CoveredDistanceKm     = @CoveredKm,
                OverageDistanceKm     = @OverageKm,
                SubcontractorCost     = CASE WHEN SubcontractorCost > 0 THEN SubcontractorCost ELSE @DefaultSubFee END,
                InsurerBilledAmount   = @InsurerBilled,
                CustomerBilledAmount  = @CustomerBilled,
                TotalAmount           = @TotalAmt,
                InvoiceStatus         = CASE WHEN @TotalAmt = 0 THEN 'Paid' ELSE 'Unpaid' END,
                IssuedAt              = SYSDATETIME()
            WHERE TowRequestId = @TowRequestId;
        END
        ELSE
        BEGIN
            DECLARE @InvSeq INT = NEXT VALUE FOR dbo.seq_TowInvoiceNumber;
            DECLARE @InvNum VARCHAR(30) = CONCAT('INV/', FORMAT(SYSDATETIME(), 'yyyy'), '/', FORMAT(@InvSeq, '000000'));
            INSERT INTO dbo.TowInvoices
            (
                InvoiceNumber, TowRequestId, TariffId, InsuranceProviderId, CustomerId,
                AppliedBaseFee, AppliedPricePerKm, AppliedNightSurcharge,
                CoveredDistanceKm, OverageDistanceKm, SubcontractorCost,
                InsurerBilledAmount, CustomerBilledAmount, TotalAmount, InvoiceStatus
            )
            VALUES
            (
                @InvNum, @TowRequestId, @TariffId, @InsurerProviderId, @CustomerId,
                @BaseFee, @PricePerKm, @NightFee,
                @CoveredKm, @OverageKm, @DefaultSubFee,
                @InsurerBilled, @CustomerBilled, @TotalAmt,
                CASE WHEN @TotalAmt = 0 THEN 'Paid' ELSE 'Unpaid' END
            );
        END;

        -- Step 5: Compute next TruckPrioritySequence
        DECLARE @NextPrioritySeq INT = 10;
        IF @FinalTruckId IS NOT NULL
        BEGIN
            SELECT @NextPrioritySeq = ISNULL(MAX(tr.TruckPrioritySequence), 0) + 10
            FROM dbo.TowRequests AS tr WITH (UPDLOCK)
            WHERE tr.AssignedTruckId = @FinalTruckId
              AND tr.Status IN ('Approved', 'InProgress');
        END;

        -- Step 6: Update TowRequest to 'Approved'
        UPDATE dbo.TowRequests
        SET AssignedTruckId       = @FinalTruckId,
            AssignedDriverId      = @ResolvedDriverId,
            SubcontractorId       = @FinalSubId,
            QuotaTierId           = @MatchedQuotaTierId,
            TruckPrioritySequence = @NextPrioritySeq,
            Status                = 'Approved'
        WHERE TowRequestId = @TowRequestId;

        -- Step 7: Update TowTruck FleetStatus to 'EnRoute' if 'Available'
        IF @FinalTruckId IS NOT NULL
        BEGIN
            UPDATE dbo.TowTrucks
            SET FleetStatus     = CASE WHEN FleetStatus = 'Available' THEN 'EnRoute' ELSE FleetStatus END,
                LastTelemetryAt = SYSDATETIME()
            WHERE TruckId = @FinalTruckId;
        END;

        COMMIT TRANSACTION;

        SELECT
            tr.TowRequestId,
            tr.RequestNumber,
            tr.Status,
            ISNULL(tr.AssignedTruckId, 0) AS AssignedTruckId,
            tr.TruckPrioritySequence,
            tr.QuotaTierId,
            tr.RouteDistanceKm AS ActualDistanceKm,
            inv.CoveredDistanceKm AS AllowedDistanceKm,
            inv.OverageDistanceKm AS OverageKm,
            inv.CustomerBilledAmount AS OverageAmount,
            inv.InsurerBilledAmount,
            inv.TotalAmount
        FROM dbo.TowRequests AS tr
        INNER JOIN dbo.TowInvoices AS inv ON tr.TowRequestId = inv.TowRequestId
        WHERE tr.TowRequestId = @TowRequestId;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;
        THROW;
    END CATCH;
END;
GO

/*==============================================================================
  5D. STORED PROCEDURE: dbo.usp_CreateTowRequest
  Normalizes vehicle into dbo.Vehicles, validates road-distance provenance,
  creates dbo.TowRequests + draft dbo.TowInvoices atomically, and optionally
  dispatches via dbo.usp_ApproveAndDispatchTow.
==============================================================================*/
CREATE OR ALTER PROCEDURE dbo.usp_CreateTowRequest
    @CustomerId                 INT,
    @CallerPhone                VARCHAR(30),
    @PlateCodeId                INT = NULL,
    @PlateDigits                VARCHAR(20) = NULL,
    @NoPlate                    BIT = 0,
    @VehicleModel               NVARCHAR(80),
    @IssueType                  VARCHAR(20),
    @IssueNotes                 NVARCHAR(400) = NULL,
    @PickupAddress              NVARCHAR(200),
    @PickupLat                  DECIMAL(9,6),
    @PickupLng                  DECIMAL(9,6),
    @DestinationAddress         NVARCHAR(200),
    @DestinationLat             DECIMAL(9,6),
    @DestinationLng             DECIMAL(9,6),
    @HasInsurance               BIT = 0,
    @PolicyId                   INT = NULL,
    @IsOutsourced               BIT = 0,
    @SubcontractorId            INT = NULL,
    @SubcontractorFee           DECIMAL(10,2) = 0.00,
    @AssignedTruckId            INT = NULL,
    @AutoApprove                BIT = 0,
    @InitialStatus              VARCHAR(25) = 'Draft',
    @RoutedDistanceKm           DECIMAL(8,2) = NULL,
    @DistanceSource             VARCHAR(30) = 'HeuristicFallbackEstimate',
    @RouteDurationMinutes       DECIMAL(6,1) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @CurrentUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @CurrentUserId IS NULL
        THROW 50031, 'Security Context Violation: Authenticated dispatcher SESSION_CONTEXT(AppUserId) is required.', 1;

    BEGIN TRY
        BEGIN TRANSACTION;

        -- 1. Resolve or register normalized Vehicle in dbo.Vehicles
        DECLARE @VehiclePlate VARCHAR(30);
        DECLARE @VehicleId INT = NULL;

        IF @NoPlate = 1
        BEGIN
            SET @VehiclePlate = 'NO-PLATE';
            INSERT INTO dbo.Vehicles (CustomerId, PlateCodeId, PlateDigits, NoPlate, VehiclePlate, VehicleModel)
            VALUES (@CustomerId, NULL, NULL, 1, 'NO-PLATE', @VehicleModel);
            SET @VehicleId = SCOPE_IDENTITY();
        END
        ELSE
        BEGIN
            DECLARE @CodeLetter VARCHAR(10) = '';
            SELECT @CodeLetter = Code FROM dbo.PlateCodes WHERE PlateCodeId = @PlateCodeId;
            IF @CodeLetter = '' OR @CodeLetter IS NULL
                THROW 50040, 'Valid Lebanese PlateCodeId is required when NoPlate = 0.', 1;

            DECLARE @CleanDigits VARCHAR(20) = LTRIM(RTRIM(ISNULL(@PlateDigits, '')));
            SET @VehiclePlate = LTRIM(RTRIM(CONCAT(@CodeLetter, ' ', @CleanDigits)));

            SELECT @VehicleId = v.VehicleId
            FROM dbo.Vehicles AS v WITH (UPDLOCK, HOLDLOCK)
            WHERE v.NoPlate = 0 AND v.VehiclePlate = @VehiclePlate;

            IF @VehicleId IS NULL
            BEGIN
                INSERT INTO dbo.Vehicles (CustomerId, PlateCodeId, PlateDigits, NoPlate, VehiclePlate, VehicleModel)
                VALUES (@CustomerId, @PlateCodeId, @CleanDigits, 0, @VehiclePlate, @VehicleModel);
                SET @VehicleId = SCOPE_IDENTITY();
            END;
        END;

        -- 2. Compute Straight-Line Geodesic Distance & Validate Routed Road Distance
        DECLARE @StraightKm DECIMAL(8,2) = dbo.fn_CalculateStraightLineDistanceKm(@PickupLat, @PickupLng, @DestinationLat, @DestinationLng);
        DECLARE @FinalRouteKm DECIMAL(8,2);
        DECLARE @FinalDistanceSource VARCHAR(30) = @DistanceSource;

        IF @RoutedDistanceKm IS NOT NULL AND @RoutedDistanceKm > 0
        BEGIN
            IF @DistanceSource = 'DispatcherVerifiedEstimate' AND @RoutedDistanceKm < ROUND(@StraightKm * 0.95, 2)
                THROW 50041, 'Validated Road Distance Error: Road driving distance cannot be shorter than straight-line geodesic distance.', 1;

            IF @RoutedDistanceKm >= ROUND(@StraightKm * 0.95, 2)
                SET @FinalRouteKm = @RoutedDistanceKm;
            ELSE
            BEGIN
                SET @FinalRouteKm = dbo.fn_EstimateRoadHeuristicKm(@PickupLat, @PickupLng, @DestinationLat, @DestinationLng);
                SET @FinalDistanceSource = 'HeuristicFallbackEstimate';
            END;
        END
        ELSE
        BEGIN
            SET @FinalRouteKm = dbo.fn_EstimateRoadHeuristicKm(@PickupLat, @PickupLng, @DestinationLat, @DestinationLng);
            SET @FinalDistanceSource = 'HeuristicFallbackEstimate';
        END;

        -- 3. Determine Night Shift & Resolve Active Driver if Truck pre-selected
        DECLARE @CurrentHour INT = DATEPART(HOUR, SYSDATETIME());
        DECLARE @IsNightShift BIT = CASE WHEN @CurrentHour >= 19 OR @CurrentHour < 7 THEN 1 ELSE 0 END;

        DECLARE @EffectivePolicyId INT = CASE WHEN @HasInsurance = 1 AND @PolicyId > 0 THEN @PolicyId ELSE NULL END;
        DECLARE @EffectiveTruckId INT = CASE WHEN @IsOutsourced = 1 THEN NULL ELSE @AssignedTruckId END;
        DECLARE @EffectiveSubId INT = CASE WHEN @IsOutsourced = 1 THEN @SubcontractorId ELSE NULL END;
        DECLARE @EffectiveDriverId INT = NULL;

        IF @EffectiveTruckId IS NOT NULL
        BEGIN
            SELECT @EffectiveDriverId = dta.DriverId
            FROM dbo.DriverTruckAssignments AS dta
            WHERE dta.TruckId = @EffectiveTruckId AND dta.EndDate IS NULL;
        END;

        -- 4. Preview Policy Allowance & Active Tariff for Draft Invoice
        DECLARE @AllowedKm DECIMAL(8,2) = 0.00,
                @PreviewTierId INT = NULL,
                @InsProviderId INT = NULL,
                @PolicyIsEligible BIT = 0;

        IF @EffectivePolicyId IS NOT NULL
        BEGIN
            SELECT
                @PolicyIsEligible = elig.IsEligible,
                @AllowedKm        = CASE WHEN elig.IsEligible = 1 THEN elig.AllowedDistanceKm ELSE 0.00 END,
                @PreviewTierId    = elig.MatchedQuotaTierId,
                @InsProviderId    = elig.ProviderId
            FROM dbo.tvf_CheckPolicyEligibility(@EffectivePolicyId, @IssueType) AS elig;
        END;

        DECLARE @TariffId INT, @BaseFee DECIMAL(10,2), @PricePerKm DECIMAL(8,2), @NightFee DECIMAL(10,2);
        SELECT
            @TariffId   = tf.TariffId,
            @BaseFee    = tf.BaseFee,
            @PricePerKm = tf.PricePerKm,
            @NightFee   = CASE WHEN @IsNightShift = 1 THEN tf.NightSurcharge ELSE 0.00 END
        FROM dbo.tvf_GetActiveTariff(@IssueType, CAST(SYSDATETIME() AS DATE)) AS tf;

        DECLARE @CoveredKm DECIMAL(8,2) =
            CASE WHEN @PolicyIsEligible = 1 THEN
                (CASE WHEN @FinalRouteKm <= @AllowedKm THEN @FinalRouteKm ELSE @AllowedKm END)
            ELSE 0.00 END;
        DECLARE @OverageKm DECIMAL(8,2) =
            CASE WHEN @FinalRouteKm > @CoveredKm THEN (@FinalRouteKm - @CoveredKm) ELSE 0.00 END;

        DECLARE @InsurerBilled DECIMAL(10,2) =
            CASE WHEN @PolicyIsEligible = 1 THEN ROUND(@BaseFee + (@CoveredKm * @PricePerKm) + @NightFee, 2) ELSE 0.00 END;
        DECLARE @CustomerBilled DECIMAL(10,2) =
            CASE WHEN @PolicyIsEligible = 1
                 THEN ROUND(@OverageKm * @PricePerKm, 2)
                 ELSE ROUND(@BaseFee + (@FinalRouteKm * @PricePerKm) + @NightFee, 2) END;

        DECLARE @DraftStatus VARCHAR(25) =
            CASE WHEN @InitialStatus IN ('Draft', 'PendingInsurance') THEN @InitialStatus ELSE 'Draft' END;

        DECLARE @ReqSeq INT = NEXT VALUE FOR dbo.seq_TowRequestNumber;
        DECLARE @FinalReqNum VARCHAR(30) = CONCAT('TOW/', FORMAT(SYSDATETIME(), 'yyyy'), '/', FORMAT(@ReqSeq, '000000'));

        INSERT INTO dbo.TowRequests
        (
            RequestNumber, CustomerId, VehicleId, CallerPhone, IssueType, IssueNotes,
            PickupAddress, PickupLat, PickupLng, DestinationAddress, DestinationLat, DestinationLng,
            StraightLineDistanceKm, RouteDistanceKm, DistanceSource, RouteDurationMinutes,
            PolicyId, QuotaTierId, AssignedTruckId, AssignedDriverId, SubcontractorId,
            IsNightShift, Status, CreatedByUserId
        )
        VALUES
        (
            @FinalReqNum, @CustomerId, @VehicleId, @CallerPhone, @IssueType, @IssueNotes,
            @PickupAddress, @PickupLat, @PickupLng, @DestinationAddress, @DestinationLat, @DestinationLng,
            @StraightKm, @FinalRouteKm, @FinalDistanceSource, @RouteDurationMinutes,
            @EffectivePolicyId, @PreviewTierId, @EffectiveTruckId, @EffectiveDriverId, @EffectiveSubId,
            @IsNightShift, @DraftStatus, @CurrentUserId
        );

        DECLARE @NewTowRequestId INT = SCOPE_IDENTITY();

        DECLARE @InvSeq INT = NEXT VALUE FOR dbo.seq_TowInvoiceNumber;
        DECLARE @InvNum VARCHAR(30) = CONCAT('INV/', FORMAT(SYSDATETIME(), 'yyyy'), '/', FORMAT(@InvSeq, '000000'));

        INSERT INTO dbo.TowInvoices
        (
            InvoiceNumber, TowRequestId, TariffId, InsuranceProviderId, CustomerId,
            AppliedBaseFee, AppliedPricePerKm, AppliedNightSurcharge,
            CoveredDistanceKm, OverageDistanceKm, SubcontractorCost,
            InsurerBilledAmount, CustomerBilledAmount, TotalAmount, InvoiceStatus
        )
        VALUES
        (
            @InvNum, @NewTowRequestId, @TariffId,
            CASE WHEN @PolicyIsEligible = 1 THEN @InsProviderId ELSE NULL END,
            @CustomerId,
            @BaseFee, @PricePerKm, @NightFee,
            @CoveredKm, @OverageKm, ISNULL(@SubcontractorFee, 0.00),
            @InsurerBilled, @CustomerBilled, (@InsurerBilled + @CustomerBilled), 'Draft'
        );

        -- Optional atomic dispatch
        IF @AutoApprove = 1 AND (@EffectiveTruckId IS NOT NULL OR @EffectiveSubId IS NOT NULL)
        BEGIN
            EXEC dbo.usp_ApproveAndDispatchTow
                @TowRequestId    = @NewTowRequestId,
                @AssignedTruckId = @EffectiveTruckId,
                @SubcontractorId = @EffectiveSubId,
                @SimulatedHoldMs = 0;
        END;

        COMMIT TRANSACTION;

        SELECT
            tr.TowRequestId,
            tr.RequestNumber,
            tr.Status,
            v.VehiclePlate,
            tr.RouteDistanceKm AS ActualDistanceKm,
            tr.DistanceSource,
            inv.CoveredDistanceKm AS AllowedDistanceKm,
            inv.OverageDistanceKm AS OverageKm,
            inv.CustomerBilledAmount AS OverageAmount,
            inv.InsurerBilledAmount,
            inv.TotalAmount
        FROM dbo.TowRequests AS tr
        INNER JOIN dbo.Vehicles AS v ON tr.VehicleId = v.VehicleId
        INNER JOIN dbo.TowInvoices AS inv ON tr.TowRequestId = inv.TowRequestId
        WHERE tr.TowRequestId = @NewTowRequestId;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;
        THROW;
    END CATCH;
END;
GO

/*==============================================================================
  5E. STORED PROCEDURE: dbo.usp_RecordInvoicePayment
  Records an individual partial or full payment row in dbo.InvoicePayments
  linked to the relevant Invoice and Payer (InsuranceProvider vs Customer),
  updating InsurerPaidAmount / CustomerPaidAmount & InvoiceStatus atomically.
==============================================================================*/
CREATE OR ALTER PROCEDURE dbo.usp_RecordInvoicePayment
    @InvoiceId              INT,
    @PayerType              VARCHAR(20), -- 'InsuranceProvider' or 'Customer'
    @AmountPaid             DECIMAL(10,2),
    @PaymentMethod          VARCHAR(30),
    @ReferenceNumber        VARCHAR(60) = NULL,
    @CollectedByDriverId    INT = NULL,
    @Notes                  NVARCHAR(200) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @CurrentUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @CurrentUserId IS NULL
        THROW 50031, 'Security Context Violation: Authenticated dispatcher SESSION_CONTEXT(AppUserId) is required.', 1;

    BEGIN TRY
        BEGIN TRANSACTION;

        DECLARE @InsProviderId  INT,
                @CustomerId     INT,
                @InsBilled      DECIMAL(10,2),
                @CustBilled     DECIMAL(10,2),
                @InsPaid        DECIMAL(10,2),
                @CustPaid       DECIMAL(10,2),
                @TotalAmt       DECIMAL(10,2),
                @InvStatus      VARCHAR(20);

        SELECT
            @InsProviderId = inv.InsuranceProviderId,
            @CustomerId    = inv.CustomerId,
            @InsBilled     = inv.InsurerBilledAmount,
            @CustBilled    = inv.CustomerBilledAmount,
            @InsPaid       = inv.InsurerPaidAmount,
            @CustPaid      = inv.CustomerPaidAmount,
            @TotalAmt      = inv.TotalAmount,
            @InvStatus     = inv.InvoiceStatus
        FROM dbo.TowInvoices AS inv WITH (UPDLOCK, ROWLOCK)
        WHERE inv.InvoiceId = @InvoiceId;

        IF @InvStatus IS NULL
            THROW 50050, 'Invoice not found.', 1;
        IF @InvStatus = 'Void'
            THROW 50051, 'Cannot record payment against a voided invoice.', 1;
        IF @AmountPaid <= 0
            THROW 50052, 'Payment amount must be strictly positive.', 1;

        IF @PayerType = 'InsuranceProvider'
        BEGIN
            IF @InsProviderId IS NULL OR @InsBilled <= 0
                THROW 50053, 'This invoice has no insurance provider obligation.', 1;
            IF (@InsPaid + @AmountPaid) > @InsBilled
                THROW 50054, 'Payment exceeds remaining Insurance Provider obligation balance.', 1;

            SET @InsPaid = @InsPaid + @AmountPaid;

            INSERT INTO dbo.InvoicePayments
            (
                InvoiceId, PayerType, InsuranceProviderId, CustomerId, CollectedByDriverId,
                AmountPaid, PaymentMethod, ReferenceNumber, RecordedByUserId, Notes
            )
            VALUES
            (
                @InvoiceId, 'InsuranceProvider', @InsProviderId, NULL, NULL,
                @AmountPaid, @PaymentMethod, @ReferenceNumber, @CurrentUserId, @Notes
            );
        END
        ELSE IF @PayerType = 'Customer'
        BEGIN
            IF (@CustPaid + @AmountPaid) > @CustBilled
                THROW 50055, 'Payment exceeds remaining Customer obligation balance.', 1;

            SET @CustPaid = @CustPaid + @AmountPaid;

            INSERT INTO dbo.InvoicePayments
            (
                InvoiceId, PayerType, InsuranceProviderId, CustomerId, CollectedByDriverId,
                AmountPaid, PaymentMethod, ReferenceNumber, RecordedByUserId, Notes
            )
            VALUES
            (
                @InvoiceId, 'Customer', NULL, @CustomerId, @CollectedByDriverId,
                @AmountPaid, @PaymentMethod, @ReferenceNumber, @CurrentUserId, @Notes
            );
        END
        ELSE
            THROW 50056, 'Invalid PayerType. Must be InsuranceProvider or Customer.', 1;

        DECLARE @NewStatus VARCHAR(20) =
            CASE
                WHEN (@InsPaid + @CustPaid) >= @TotalAmt THEN 'Paid'
                WHEN (@InsPaid + @CustPaid) > 0 THEN 'PartiallyPaid'
                ELSE 'Unpaid'
            END;

        UPDATE dbo.TowInvoices
        SET InsurerPaidAmount  = @InsPaid,
            CustomerPaidAmount = @CustPaid,
            InvoiceStatus      = @NewStatus
        WHERE InvoiceId = @InvoiceId;

        COMMIT TRANSACTION;

        SELECT
            inv.InvoiceId,
            inv.InvoiceNumber,
            inv.InsurerBilledAmount,
            inv.InsurerPaidAmount,
            (inv.InsurerBilledAmount - inv.InsurerPaidAmount) AS InsurerBalanceDue,
            inv.CustomerBilledAmount,
            inv.CustomerPaidAmount,
            (inv.CustomerBilledAmount - inv.CustomerPaidAmount) AS CustomerBalanceDue,
            inv.InvoiceStatus
        FROM dbo.TowInvoices AS inv
        WHERE inv.InvoiceId = @InvoiceId;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;
        THROW;
    END CATCH;
END;
GO

/*==============================================================================
  5F. STORED PROCEDURE: dbo.usp_UpdateTowLifecycleStatus
  Transitions a tow ticket ('PendingInsurance','InProgress','Done','UnableToLoad','Rejected')
  and records any on-scene cash collected by the driver into dbo.InvoicePayments.
==============================================================================*/
CREATE OR ALTER PROCEDURE dbo.usp_UpdateTowLifecycleStatus
    @TowRequestId       INT,
    @NewStatus          VARCHAR(25),
    @CashCollected      DECIMAL(10,2) = 0.00,
    @RejectionReason    NVARCHAR(300) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @CurrentUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @CurrentUserId IS NULL
        THROW 50031, 'Security Context Violation: Authenticated dispatcher SESSION_CONTEXT(AppUserId) is required.', 1;

    BEGIN TRY
        BEGIN TRANSACTION;

        DECLARE @AssignedTruckId INT,
                @AssignedDriverId INT;

        SELECT
            @AssignedTruckId  = tr.AssignedTruckId,
            @AssignedDriverId = tr.AssignedDriverId
        FROM dbo.TowRequests AS tr WITH (UPDLOCK, ROWLOCK)
        WHERE tr.TowRequestId = @TowRequestId;

        -- Trigger dbo.trg_TowRequests_ImmutabilityAndAudit blocks updates if already finalized!
        UPDATE dbo.TowRequests
        SET Status          = @NewStatus,
            RejectionReason = CASE WHEN @NewStatus = 'Rejected' THEN @RejectionReason ELSE RejectionReason END,
            CompletedAt     = CASE WHEN @NewStatus IN ('Done', 'UnableToLoad', 'Rejected') THEN SYSDATETIME() ELSE CompletedAt END
        WHERE TowRequestId = @TowRequestId;

        -- Update invoice status on rejection or on-scene customer cash collection
        DECLARE @InvoiceId INT, @CustRemaining DECIMAL(10,2), @InvStatus VARCHAR(20);
        SELECT
            @InvoiceId     = inv.InvoiceId,
            @CustRemaining = (inv.CustomerBilledAmount - inv.CustomerPaidAmount),
            @InvStatus     = inv.InvoiceStatus
        FROM dbo.TowInvoices AS inv WITH (UPDLOCK, ROWLOCK)
        WHERE inv.TowRequestId = @TowRequestId;

        IF @NewStatus = 'Rejected' AND @InvStatus = 'Draft'
        BEGIN
            UPDATE dbo.TowInvoices
            SET InvoiceStatus = 'Void'
            WHERE InvoiceId = @InvoiceId;
        END
        ELSE IF @NewStatus = 'Done' AND @InvoiceId IS NOT NULL
        BEGIN
            IF @InvStatus = 'Draft'
            BEGIN
                UPDATE dbo.TowInvoices
                SET InvoiceStatus = CASE WHEN TotalAmount = 0 THEN 'Paid' ELSE 'Unpaid' END
                WHERE InvoiceId = @InvoiceId;
            END;

            DECLARE @EffectiveCash DECIMAL(10,2) =
                CASE WHEN @CashCollected > @CustRemaining THEN @CustRemaining ELSE @CashCollected END;

            IF @EffectiveCash > 0
            BEGIN
                EXEC dbo.usp_RecordInvoicePayment
                    @InvoiceId           = @InvoiceId,
                    @PayerType           = 'Customer',
                    @AmountPaid          = @EffectiveCash,
                    @PaymentMethod       = 'OnSceneCash',
                    @ReferenceNumber     = 'CASH-SCENE',
                    @CollectedByDriverId = @AssignedDriverId,
                    @Notes               = N'Collected on scene upon tow completion';
            END;
        END;

        -- Synchronize TowTruck live FleetStatus
        IF @AssignedTruckId IS NOT NULL
        BEGIN
            IF @NewStatus = 'InProgress'
            BEGIN
                UPDATE dbo.TowTrucks
                SET FleetStatus = 'Towing', LastTelemetryAt = SYSDATETIME()
                WHERE TruckId = @AssignedTruckId;
            END
            ELSE IF @NewStatus IN ('Done', 'UnableToLoad', 'Rejected')
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM dbo.TowRequests
                    WHERE AssignedTruckId = @AssignedTruckId
                      AND Status IN ('Approved', 'InProgress')
                )
                BEGIN
                    UPDATE dbo.TowTrucks
                    SET FleetStatus = 'EnRoute', LastTelemetryAt = SYSDATETIME()
                    WHERE TruckId = @AssignedTruckId;
                END
                ELSE
                BEGIN
                    UPDATE dbo.TowTrucks
                    SET FleetStatus = 'Available', SpeedKmh = 0.0, LastTelemetryAt = SYSDATETIME()
                    WHERE TruckId = @AssignedTruckId;
                END;
            END;
        END;

        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;
        THROW;
    END CATCH;
END;
GO

/*==============================================================================
  5G. STORED PROCEDURE: dbo.usp_UpdateDraftTowOptimistic
  Demonstrates OPTIMISTIC CONCURRENCY CONTROL using ROWVERSION.
==============================================================================*/
CREATE OR ALTER PROCEDURE dbo.usp_UpdateDraftTowOptimistic
    @TowRequestId       INT,
    @NewIssueType       VARCHAR(20),
    @NewIssueNotes      NVARCHAR(400),
    @ExpectedRowVer     BINARY(8)
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @CurrentUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @CurrentUserId IS NULL
        THROW 50031, 'Security Context Violation: Authenticated dispatcher SESSION_CONTEXT(AppUserId) is required.', 1;

    BEGIN TRY
        BEGIN TRANSACTION;

        UPDATE dbo.TowRequests
        SET IssueType  = @NewIssueType,
            IssueNotes = @NewIssueNotes
        WHERE TowRequestId = @TowRequestId
          AND RowVer       = @ExpectedRowVer;

        IF @@ROWCOUNT = 0
        BEGIN
            THROW 50020, 'Optimistic Concurrency Conflict (ROWVERSION mismatch): Another dispatcher modified this ticket before your save. Please refresh and try again.', 1;
        END;

        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;
        THROW;
    END CATCH;
END;
GO

/*==============================================================================
  5H. STORED PROCEDURE: dbo.usp_ReorderTruckJobQueue
==============================================================================*/
CREATE OR ALTER PROCEDURE dbo.usp_ReorderTruckJobQueue
    @TruckId        INT,
    @TowRequestId   INT,
    @Direction      VARCHAR(10)
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @CurrentUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @CurrentUserId IS NULL
        THROW 50031, 'Security Context Violation: Authenticated dispatcher SESSION_CONTEXT(AppUserId) is required.', 1;

    BEGIN TRY
        BEGIN TRANSACTION;

        DECLARE @Ordered TABLE (
            RowNum INT IDENTITY(1,1),
            TowRequestId INT,
            NewOrderKey INT
        );

        INSERT INTO @Ordered (TowRequestId, NewOrderKey)
        SELECT
            tr.TowRequestId,
            ROW_NUMBER() OVER (ORDER BY tr.TruckPrioritySequence ASC, tr.TowRequestId ASC) * 10
        FROM dbo.TowRequests AS tr WITH (UPDLOCK)
        WHERE tr.AssignedTruckId = @TruckId
          AND tr.Status IN ('Approved', 'InProgress');

        DECLARE @TargetRow INT;
        SELECT @TargetRow = RowNum FROM @Ordered WHERE TowRequestId = @TowRequestId;

        IF @TargetRow IS NOT NULL
        BEGIN
            IF @Direction = 'up' AND @TargetRow > 1
                UPDATE @Ordered SET NewOrderKey = NewOrderKey - 15 WHERE RowNum = @TargetRow;
            ELSE IF @Direction = 'down' AND @TargetRow < (SELECT MAX(RowNum) FROM @Ordered)
                UPDATE @Ordered SET NewOrderKey = NewOrderKey + 15 WHERE RowNum = @TargetRow;

            ;WITH Renumbered AS (
                SELECT
                    TowRequestId,
                    ROW_NUMBER() OVER (ORDER BY NewOrderKey ASC, RowNum ASC) * 10 AS FinalSeq
                FROM @Ordered
            )
            UPDATE tr
            SET tr.TruckPrioritySequence = r.FinalSeq
            FROM dbo.TowRequests AS tr
            INNER JOIN Renumbered AS r ON tr.TowRequestId = r.TowRequestId;
        END;

        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;
        THROW;
    END CATCH;
END;
GO

/*==============================================================================
  5I. DRIVER, ASSIGNMENT, TARIFF & ADMIN STORED PROCEDURES
==============================================================================*/
CREATE OR ALTER PROCEDURE dbo.usp_AssignDriverToTruck
    @DriverId           INT,
    @TruckId            INT,
    @AssignmentNotes    NVARCHAR(200) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @CurrentUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @CurrentUserId IS NULL
        THROW 50031, 'Security Context Violation: Authenticated dispatcher SESSION_CONTEXT(AppUserId) is required.', 1;

    BEGIN TRY
        BEGIN TRANSACTION;

        DECLARE @Now DATETIME2(0) = SYSDATETIME();

        -- Close any existing active assignment on this Truck or for this Driver (preserving history!)
        UPDATE dbo.DriverTruckAssignments
        SET EndDate = @Now
        WHERE EndDate IS NULL
          AND (TruckId = @TruckId OR DriverId = @DriverId);

        INSERT INTO dbo.DriverTruckAssignments (DriverId, TruckId, StartDate, EndDate, AssignmentNotes)
        VALUES (@DriverId, @TruckId, @Now, NULL, @AssignmentNotes);

        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;
        THROW;
    END CATCH;
END;
GO

CREATE OR ALTER PROCEDURE dbo.usp_UpdateDriverContact
    @DriverId               INT,
    @Phone                  VARCHAR(30),
    @IsWorkingOffDay        BIT,
    @FullName               NVARCHAR(100) = NULL,
    @LicenseNumber          VARCHAR(40)   = NULL,
    @BaseMonthlySalary      DECIMAL(10,2) = NULL,
    @OvertimeRatePerTow     DECIMAL(8,2)  = NULL,
    @DriverStatus           VARCHAR(20)   = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @CurrentUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @CurrentUserId IS NULL
        THROW 50031, 'Security Context Violation: Authenticated dispatcher SESSION_CONTEXT(AppUserId) is required.', 1;

    UPDATE dbo.Drivers
    SET Phone               = LTRIM(RTRIM(@Phone)),
        IsWorkingOffDay     = @IsWorkingOffDay,
        FullName            = COALESCE(NULLIF(LTRIM(RTRIM(@FullName)), N''), FullName),
        LicenseNumber       = COALESCE(NULLIF(LTRIM(RTRIM(@LicenseNumber)), ''), LicenseNumber),
        BaseMonthlySalary   = COALESCE(@BaseMonthlySalary, BaseMonthlySalary),
        OvertimeRatePerTow  = COALESCE(@OvertimeRatePerTow, OvertimeRatePerTow),
        DriverStatus        = COALESCE(NULLIF(LTRIM(RTRIM(@DriverStatus)), ''), DriverStatus)
    WHERE DriverId = @DriverId;
END;
GO

CREATE OR ALTER PROCEDURE dbo.usp_CreateDriver
    @EmployeeCode           VARCHAR(20),
    @FullName               NVARCHAR(100),
    @Phone                  VARCHAR(30),
    @LicenseNumber          VARCHAR(40),
    @BaseMonthlySalary      DECIMAL(10,2) = 850.00,
    @OvertimeRatePerTow     DECIMAL(8,2)  = 15.00,
    @IsWorkingOffDay        BIT           = 0,
    @DriverStatus           VARCHAR(20)   = 'Active'
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @CurrentUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @CurrentUserId IS NULL
        THROW 50031, 'Security Context Violation: Authenticated dispatcher SESSION_CONTEXT(AppUserId) is required.', 1;

    IF NOT EXISTS (
        SELECT 1 FROM dbo.SystemUsers AS u
        INNER JOIN dbo.UserGroups AS ug ON u.GroupId = ug.GroupId
        WHERE u.UserId = @CurrentUserId AND u.IsActive = 1 AND (ug.CanManageFleet = 1 OR ug.CanManageUsers = 1)
    )
        THROW 50060, 'Access Denied: Fleet Configuration or Administrator permission is required to create drivers.', 1;

    INSERT INTO dbo.Drivers (
        EmployeeCode, FullName, Phone, LicenseNumber,
        BaseMonthlySalary, OvertimeRatePerTow, IsWorkingOffDay, DriverStatus
    )
    VALUES (
        UPPER(LTRIM(RTRIM(@EmployeeCode))),
        LTRIM(RTRIM(@FullName)),
        LTRIM(RTRIM(@Phone)),
        UPPER(LTRIM(RTRIM(@LicenseNumber))),
        @BaseMonthlySalary,
        @OvertimeRatePerTow,
        @IsWorkingOffDay,
        @DriverStatus
    );

    SELECT CAST(SCOPE_IDENTITY() AS INT) AS NewDriverId;
END;
GO

CREATE OR ALTER PROCEDURE dbo.usp_CreateTowTruck
    @TruckCode              VARCHAR(20),
    @LicensePlate           VARCHAR(20),
    @TruckModel             NVARCHAR(80),
    @MaxPayloadKg           INT           = 5000,
    @CurrentLat             DECIMAL(9,6)  = 33.893800,
    @CurrentLng             DECIMAL(9,6)  = 35.501800,
    @FleetStatus            VARCHAR(20)   = 'Available'
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @CurrentUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @CurrentUserId IS NULL
        THROW 50031, 'Security Context Violation: Authenticated dispatcher SESSION_CONTEXT(AppUserId) is required.', 1;

    IF NOT EXISTS (
        SELECT 1 FROM dbo.SystemUsers AS u
        INNER JOIN dbo.UserGroups AS ug ON u.GroupId = ug.GroupId
        WHERE u.UserId = @CurrentUserId AND u.IsActive = 1 AND (ug.CanManageFleet = 1 OR ug.CanManageUsers = 1)
    )
        THROW 50060, 'Access Denied: Fleet Configuration or Administrator permission is required to register tow trucks.', 1;

    INSERT INTO dbo.TowTrucks (
        TruckCode, LicensePlate, TruckModel, MaxPayloadKg,
        CurrentLat, CurrentLng, SpeedKmh, FleetStatus, LastTelemetryAt
    )
    VALUES (
        UPPER(LTRIM(RTRIM(@TruckCode))),
        UPPER(LTRIM(RTRIM(@LicensePlate))),
        LTRIM(RTRIM(@TruckModel)),
        @MaxPayloadKg,
        @CurrentLat,
        @CurrentLng,
        0.0,
        @FleetStatus,
        SYSDATETIME()
    );

    SELECT CAST(SCOPE_IDENTITY() AS INT) AS NewTruckId;
END;
GO

CREATE OR ALTER PROCEDURE dbo.usp_UpdateTowTruck
    @TruckId                INT,
    @TruckCode              VARCHAR(20),
    @LicensePlate           VARCHAR(20),
    @TruckModel             NVARCHAR(80),
    @MaxPayloadKg           INT,
    @CurrentLat             DECIMAL(9,6),
    @CurrentLng             DECIMAL(9,6),
    @FleetStatus            VARCHAR(20)
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @CurrentUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @CurrentUserId IS NULL
        THROW 50031, 'Security Context Violation: Authenticated dispatcher SESSION_CONTEXT(AppUserId) is required.', 1;

    IF NOT EXISTS (
        SELECT 1 FROM dbo.SystemUsers AS u
        INNER JOIN dbo.UserGroups AS ug ON u.GroupId = ug.GroupId
        WHERE u.UserId = @CurrentUserId AND u.IsActive = 1 AND (ug.CanManageFleet = 1 OR ug.CanManageUsers = 1)
    )
        THROW 50060, 'Access Denied: Fleet Configuration or Administrator permission is required to modify tow trucks.', 1;

    UPDATE dbo.TowTrucks
    SET TruckCode       = UPPER(LTRIM(RTRIM(@TruckCode))),
        LicensePlate    = UPPER(LTRIM(RTRIM(@LicensePlate))),
        TruckModel      = LTRIM(RTRIM(@TruckModel)),
        MaxPayloadKg    = @MaxPayloadKg,
        CurrentLat      = @CurrentLat,
        CurrentLng      = @CurrentLng,
        FleetStatus     = @FleetStatus,
        LastTelemetryAt = SYSDATETIME()
    WHERE TruckId = @TruckId;
END;
GO

CREATE OR ALTER PROCEDURE dbo.usp_EndDriverTruckAssignment
    @AssignmentId           INT,
    @EndNotes               NVARCHAR(200) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @CurrentUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @CurrentUserId IS NULL
        THROW 50031, 'Security Context Violation: Authenticated dispatcher SESSION_CONTEXT(AppUserId) is required.', 1;

    UPDATE dbo.DriverTruckAssignments
    SET EndDate = SYSDATETIME(),
        AssignmentNotes = CASE
            WHEN NULLIF(LTRIM(RTRIM(@EndNotes)), N'') IS NOT NULL THEN LTRIM(RTRIM(@EndNotes))
            ELSE AssignmentNotes
        END
    WHERE AssignmentId = @AssignmentId
      AND EndDate IS NULL;
END;
GO

CREATE OR ALTER PROCEDURE dbo.usp_UpdateCustomer
    @CustomerId             INT,
    @FullName               NVARCHAR(120),
    @Phone                  VARCHAR(30),
    @Email                  VARCHAR(120) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @CurrentUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @CurrentUserId IS NULL
        THROW 50031, 'Security Context Violation: Authenticated dispatcher SESSION_CONTEXT(AppUserId) is required.', 1;

    UPDATE dbo.Customers
    SET FullName = LTRIM(RTRIM(@FullName)),
        Phone    = LTRIM(RTRIM(@Phone)),
        Email    = NULLIF(LTRIM(RTRIM(@Email)), '')
    WHERE CustomerId = @CustomerId;
END;
GO

CREATE OR ALTER PROCEDURE dbo.usp_CreateTariff
    @TariffCode         VARCHAR(30),
    @TariffName         NVARCHAR(100),
    @ServiceCategory    VARCHAR(20),
    @BaseFee            DECIMAL(10,2),
    @PricePerKm         DECIMAL(8,2),
    @NightSurcharge     DECIMAL(10,2),
    @EffectiveFrom      DATE
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @CurrentUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @CurrentUserId IS NULL
        THROW 50031, 'Security Context Violation: Authenticated dispatcher SESSION_CONTEXT(AppUserId) is required.', 1;

    BEGIN TRY
        BEGIN TRANSACTION;

        -- Close previous open-ended tariff in same category without modifying any historical TowInvoices!
        UPDATE dbo.Tariffs
        SET EffectiveTo = CASE
                WHEN EffectiveFrom >= @EffectiveFrom THEN EffectiveFrom
                ELSE DATEADD(DAY, -1, @EffectiveFrom)
            END,
            IsActive = 0
        WHERE ServiceCategory = @ServiceCategory
          AND EffectiveTo IS NULL;

        INSERT INTO dbo.Tariffs
        (
            TariffCode, TariffName, ServiceCategory,
            BaseFee, PricePerKm, NightSurcharge, EffectiveFrom, EffectiveTo, IsActive
        )
        VALUES
        (
            UPPER(LTRIM(RTRIM(@TariffCode))), @TariffName, @ServiceCategory,
            @BaseFee, @PricePerKm, @NightSurcharge, @EffectiveFrom, NULL, 1
        );

        DECLARE @NewTariffId INT = SCOPE_IDENTITY();
        COMMIT TRANSACTION;

        SELECT TariffId, TariffCode, TariffName, ServiceCategory, BaseFee, PricePerKm, NightSurcharge, EffectiveFrom
        FROM dbo.Tariffs
        WHERE TariffId = @NewTariffId;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;
        THROW;
    END CATCH;
END;
GO

CREATE OR ALTER PROCEDURE dbo.usp_CreateCustomer
    @FullName   NVARCHAR(120),
    @Phone      VARCHAR(30),
    @Email      VARCHAR(120) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @CurrentUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @CurrentUserId IS NULL
        THROW 50031, 'Security Context Violation: Authenticated dispatcher SESSION_CONTEXT(AppUserId) is required.', 1;

    INSERT INTO dbo.Customers (FullName, Phone, Email)
    VALUES (@FullName, @Phone, @Email);

    SELECT CAST(SCOPE_IDENTITY() AS INT) AS NewCustomerId;
END;
GO

CREATE OR ALTER PROCEDURE dbo.usp_CreatePolicyWithTiers
    @InputCustomerId        INT = NULL,
    @FullName               NVARCHAR(120) = NULL,
    @Phone                  VARCHAR(30) = NULL,
    @Email                  VARCHAR(120) = NULL,
    @PolicyNumber           VARCHAR(40),
    @ProviderId             INT,
    @StartDate              DATE,
    @ExpirationDate         DATE,
    @DefaultAllowedKm       DECIMAL(8,2),
    @MechanicalAllowedTows  INT,
    @MechanicalCooldownDays INT,
    @AccidentAllowedTows    INT,
    @AccidentCooldownDays   INT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @CurrentUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @CurrentUserId IS NULL
        THROW 50031, 'Security Context Violation: Authenticated dispatcher SESSION_CONTEXT(AppUserId) is required.', 1;

    BEGIN TRY
        BEGIN TRANSACTION;

        DECLARE @CustId INT = @InputCustomerId;
        IF @CustId IS NULL OR @CustId <= 0
        BEGIN
            SELECT @CustId = CustomerId FROM dbo.Customers WHERE Phone = @Phone;
            IF @CustId IS NULL
            BEGIN
                INSERT INTO dbo.Customers (FullName, Phone, Email)
                VALUES (@FullName, @Phone, @Email);
                SET @CustId = SCOPE_IDENTITY();
            END;
        END;

        INSERT INTO dbo.InsurancePolicies
        (
            PolicyNumber, CustomerId, ProviderId, StartDate, ExpirationDate,
            DefaultAllowedKm, DefaultMinIntervalDays, PolicyStatus
        )
        VALUES
        (
            @PolicyNumber, @CustId, @ProviderId, @StartDate, @ExpirationDate,
            @DefaultAllowedKm, @MechanicalCooldownDays, 'Active'
        );

        DECLARE @NewPolicyId INT = SCOPE_IDENTITY();

        INSERT INTO dbo.PolicyQuotaTiers (PolicyId, TierSequence, CoverageType, AllowedTows, UsedTows, MaxDistanceKm, MinIntervalDays)
        VALUES
            (@NewPolicyId, 10, 'Mechanical', @MechanicalAllowedTows, 0, @DefaultAllowedKm, @MechanicalCooldownDays),
            (@NewPolicyId, 20, 'Accident',   @AccidentAllowedTows,   0, @DefaultAllowedKm, @AccidentCooldownDays);

        COMMIT TRANSACTION;
        SELECT @NewPolicyId AS NewPolicyId, @CustId AS FinalCustomerId;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;
        THROW;
    END CATCH;
END;
GO

CREATE OR ALTER PROCEDURE dbo.usp_UpsertQuotaTier
    @QuotaTierId        INT = NULL,
    @PolicyId           INT = NULL,
    @TierSequence       INT,
    @CoverageType       VARCHAR(20),
    @AllowedTows        INT,
    @UsedTows           INT = 0,
    @MaxDistanceKm      DECIMAL(8,2),
    @MinIntervalDays    INT
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @CurrentUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @CurrentUserId IS NULL
        THROW 50031, 'Security Context Violation: Authenticated dispatcher SESSION_CONTEXT(AppUserId) is required.', 1;

    IF @QuotaTierId IS NOT NULL AND @QuotaTierId > 0
    BEGIN
        UPDATE dbo.PolicyQuotaTiers
        SET TierSequence    = @TierSequence,
            CoverageType    = @CoverageType,
            AllowedTows     = @AllowedTows,
            UsedTows        = @UsedTows,
            MaxDistanceKm   = @MaxDistanceKm,
            MinIntervalDays = @MinIntervalDays
        WHERE QuotaTierId = @QuotaTierId;
    END
    ELSE
    BEGIN
        INSERT INTO dbo.PolicyQuotaTiers (PolicyId, TierSequence, CoverageType, AllowedTows, UsedTows, MaxDistanceKm, MinIntervalDays)
        VALUES (@PolicyId, @TierSequence, @CoverageType, @AllowedTows, 0, @MaxDistanceKm, @MinIntervalDays);
    END;
END;
GO

CREATE OR ALTER PROCEDURE dbo.usp_AddPlateCode
    @Code               VARCHAR(10),
    @RegionDescription  NVARCHAR(100),
    @DisplaySequence    INT
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @CurrentUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @CurrentUserId IS NULL
        THROW 50031, 'Security Context Violation: Authenticated dispatcher SESSION_CONTEXT(AppUserId) is required.', 1;

    INSERT INTO dbo.PlateCodes (Code, RegionDescription, DisplaySequence, IsActive)
    VALUES (UPPER(LTRIM(RTRIM(@Code))), @RegionDescription, @DisplaySequence, 1);
END;
GO

/*==============================================================================
  5J. CONCURRENCY RACE DEMO PREPARATION & OUTCOME PROCEDURE
==============================================================================*/
CREATE OR ALTER PROCEDURE dbo.usp_PrepareConcurrencyRaceDemo
    @CheckOnly BIT = 0
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    IF @CheckOnly = 1
    BEGIN
        SELECT AllowedTows, UsedTows
        FROM dbo.PolicyQuotaTiers
        WHERE PolicyId = 2 AND CoverageType = 'Accident';
        RETURN;
    END;

    DECLARE @CurrentUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @CurrentUserId IS NULL
        THROW 50031, 'Security Context Violation: Authenticated dispatcher SESSION_CONTEXT(AppUserId) is required.', 1;

    BEGIN TRY
        BEGIN TRANSACTION;

        UPDATE dbo.PolicyQuotaTiers
        SET AllowedTows = 2, UsedTows = 1
        WHERE PolicyId = 2 AND CoverageType = 'Accident';

        UPDATE dbo.InsurancePolicies
        SET PolicyStatus = 'Active'
        WHERE PolicyId = 2;

        DECLARE @ReqIdA INT, @ReqIdB INT;
        DECLARE @Tmp TABLE (
            TowRequestId INT, RequestNumber VARCHAR(30), Status VARCHAR(25),
            VehiclePlate VARCHAR(30), ActualDistanceKm DECIMAL(8,2), DistanceSource VARCHAR(30),
            AllowedDistanceKm DECIMAL(8,2), OverageKm DECIMAL(8,2), OverageAmount DECIMAL(10,2),
            InsurerBilledAmount DECIMAL(10,2), TotalAmount DECIMAL(10,2)
        );

        INSERT INTO @Tmp
        EXEC dbo.usp_CreateTowRequest
            @CustomerId = 2, @CallerPhone = '+961-70-222333',
            @PlateCodeId = 2, @PlateDigits = '881001', @NoPlate = 0,
            @VehicleModel = N'BMW X5 (Dispatcher #1)', @IssueType = 'Accident',
            @IssueNotes = N'Concurrent 2-Dispatcher Race Condition Test (Tab A)',
            @PickupAddress = N'Dora Highway, Metn', @PickupLat = 33.8980, @PickupLng = 35.5520,
            @DestinationAddress = N'Bouchrieh Bodyshop', @DestinationLat = 33.8920, @DestinationLng = 35.5590,
            @HasInsurance = 1, @PolicyId = 2, @IsOutsourced = 0, @SubcontractorId = NULL,
            @SubcontractorFee = 0, @AssignedTruckId = NULL, @AutoApprove = 0,
            @RoutedDistanceKm = 22.00, @DistanceSource = 'OSRM_DrivingRoute';

        SELECT TOP (1) @ReqIdA = TowRequestId FROM @Tmp;
        DELETE FROM @Tmp;

        INSERT INTO @Tmp
        EXEC dbo.usp_CreateTowRequest
            @CustomerId = 2, @CallerPhone = '+961-70-222333',
            @PlateCodeId = 2, @PlateDigits = '882002', @NoPlate = 0,
            @VehicleModel = N'Range Rover (Dispatcher #2)', @IssueType = 'Accident',
            @IssueNotes = N'Concurrent 2-Dispatcher Race Condition Test (Tab B)',
            @PickupAddress = N'Jal El Dib Autostrade, Metn', @PickupLat = 33.9102, @PickupLng = 35.5754,
            @DestinationAddress = N'Sin El Fil Bodyshop', @DestinationLat = 33.8780, @DestinationLng = 35.5390,
            @HasInsurance = 1, @PolicyId = 2, @IsOutsourced = 0, @SubcontractorId = NULL,
            @SubcontractorFee = 0, @AssignedTruckId = NULL, @AutoApprove = 0,
            @RoutedDistanceKm = 26.00, @DistanceSource = 'OSRM_DrivingRoute';

        SELECT TOP (1) @ReqIdB = TowRequestId FROM @Tmp;

        COMMIT TRANSACTION;

        SELECT TowRequestId, RequestNumber
        FROM dbo.TowRequests
        WHERE TowRequestId IN (@ReqIdA, @ReqIdB)
        ORDER BY TowRequestId ASC;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;
        THROW;
    END CATCH;
END;
GO

/*==============================================================================
  5K. STORED PROCEDURE: dbo.usp_SearchTowRequestsArchive
  Executes SARGable covering-index queries across the >120,000-row normalized
  schema (TowRequests + Vehicles + TowInvoices).
==============================================================================*/
CREATE OR ALTER PROCEDURE dbo.usp_SearchTowRequestsArchive
    @Mode           VARCHAR(20)   = 'domain',
    @PolicyId       INT           = 42,
    @IssueType      VARCHAR(20)   = 'Mechanical',
    @Status         VARCHAR(25)   = 'Done',
    @StartDate      DATETIME2(0)  = '2026-10-01T00:00:00',
    @EndDate        DATETIME2(0)  = '2026-11-01T00:00:00',
    @VehiclePlate   VARCHAR(30)   = 'M 100001',
    @MatchMode      VARCHAR(10)   = 'all',
    @DomainJson     NVARCHAR(MAX) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET STATISTICS IO ON;

    IF @Mode = 'domain' AND @DomainJson IS NOT NULL
    BEGIN
        DECLARE @Rules TABLE
        (
            RuleId     INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
            Field      VARCHAR(40)       NOT NULL,
            Op         VARCHAR(20)       NOT NULL,
            Val        NVARCHAR(120)     NOT NULL,
            EscapedVal NVARCHAR(360)     NOT NULL
        );

        INSERT INTO @Rules (Field, Op, Val, EscapedVal)
        SELECT
            LTRIM(RTRIM(ISNULL(j.field, ''))),
            LTRIM(RTRIM(ISNULL(j.op, '='))),
            LTRIM(RTRIM(ISNULL(j.val, ''))),
            REPLACE(REPLACE(REPLACE(LTRIM(RTRIM(ISNULL(j.val, ''))), N'[', N'[[]'), N'%', N'[%]'), N'_', N'[_]')
        FROM OPENJSON(@DomainJson)
        WITH
        (
            field VARCHAR(40)   '$.field',
            op    VARCHAR(20)   '$.op',
            val   NVARCHAR(120) '$.value'
        ) AS j
        WHERE LEN(LTRIM(RTRIM(ISNULL(j.field, '')))) > 0
          AND LEN(LTRIM(RTRIM(ISNULL(j.val, '')))) > 0;

        DECLARE @RuleCount INT = (SELECT COUNT(*) FROM @Rules);
        DECLARE @IsAll BIT = CASE WHEN LOWER(ISNULL(@MatchMode, 'all')) = 'any' THEN 0 ELSE 1 END;

        -- Extract SARGable index pre-bounds when MatchMode = 'all' (AND)
        DECLARE @BoundStatus      VARCHAR(25)   = NULL,
                @BoundMinDate     DATETIME2(0)  = NULL,
                @BoundMaxDateExcl DATETIME2(0)  = NULL,
                @UsePlatePreSeek  BIT           = 0;

        DECLARE @MatchedVehicles TABLE (VehicleId INT NOT NULL PRIMARY KEY);

        IF @IsAll = 1 AND @RuleCount > 0
        BEGIN
            SELECT TOP (1) @BoundStatus = r.Val
            FROM @Rules AS r
            WHERE r.Field = 'status' AND r.Op = '=';

            SELECT @BoundMinDate = MAX(TRY_CAST(r.Val AS DATETIME2(0)))
            FROM @Rules AS r
            WHERE r.Field = 'createdAt' AND r.Op IN ('>=', '=')
              AND TRY_CAST(r.Val AS DATETIME2(0)) IS NOT NULL;

            SELECT @BoundMaxDateExcl = MIN(CAST(DATEADD(DAY, 1, TRY_CAST(r.Val AS DATE)) AS DATETIME2(0)))
            FROM @Rules AS r
            WHERE r.Field = 'createdAt' AND r.Op IN ('<=', '=')
              AND TRY_CAST(r.Val AS DATE) IS NOT NULL;

            IF EXISTS (SELECT 1 FROM @Rules WHERE Field = 'vehiclePlate' AND Op IN ('=', 'starts_with'))
            BEGIN
                SET @UsePlatePreSeek = 1;
                DECLARE @PlateOp VARCHAR(20), @PlateRaw VARCHAR(60), @PlateEsc NVARCHAR(180);
                SELECT TOP (1)
                    @PlateOp  = r.Op,
                    @PlateRaw = LEFT(r.Val, 60),
                    @PlateEsc = LEFT(r.EscapedVal, 180)
                FROM @Rules AS r
                WHERE r.Field = 'vehiclePlate' AND r.Op IN ('=', 'starts_with')
                ORDER BY CASE WHEN r.Op = '=' THEN 0 ELSE 1 END;

                IF @PlateOp = '='
                BEGIN
                    INSERT INTO @MatchedVehicles (VehicleId)
                    SELECT v.VehicleId
                    FROM dbo.Vehicles AS v
                    WHERE v.NoPlate = 0 AND v.VehiclePlate = @PlateRaw;
                END
                ELSE
                BEGIN
                    INSERT INTO @MatchedVehicles (VehicleId)
                    SELECT v.VehicleId
                    FROM dbo.Vehicles AS v
                    WHERE v.NoPlate = 0 AND v.VehiclePlate LIKE @PlateEsc + N'%';
                END;
            END;
        END;

        SELECT TOP (50)
            tr.TowRequestId,
            tr.RequestNumber,
            v.VehiclePlate,
            v.VehicleModel,
            tr.IssueType,
            tr.Status,
            tr.RouteDistanceKm AS ActualDistanceKm,
            tr.DistanceSource,
            inv.CoveredDistanceKm AS AllowedDistanceKm,
            inv.CustomerBilledAmount AS OverageAmount,
            inv.InsurerBilledAmount,
            inv.TotalAmount,
            inv.InvoiceStatus,
            tr.CreatedAt
        FROM dbo.TowRequests AS tr
        INNER JOIN dbo.Vehicles AS v ON tr.VehicleId = v.VehicleId
        INNER JOIN dbo.TowInvoices AS inv ON tr.TowRequestId = inv.TowRequestId
        WHERE (@BoundStatus IS NULL OR tr.Status = @BoundStatus)
          AND (@BoundMinDate IS NULL OR tr.CreatedAt >= @BoundMinDate)
          AND (@BoundMaxDateExcl IS NULL OR tr.CreatedAt < @BoundMaxDateExcl)
          AND (@UsePlatePreSeek = 0 OR tr.VehicleId IN (SELECT mv.VehicleId FROM @MatchedVehicles AS mv))
          AND (
              @RuleCount = 0
              OR (
                  @IsAll = 1
                  AND NOT EXISTS (
                      SELECT 1
                      FROM @Rules AS r
                      WHERE NOT (
                          (r.Field = 'vehiclePlate' AND (
                              (r.Op = '='           AND v.VehiclePlate = r.Val) OR
                              (r.Op = '!='          AND v.VehiclePlate <> r.Val) OR
                              (r.Op = 'starts_with' AND v.VehiclePlate LIKE r.EscapedVal + N'%') OR
                              (r.Op = 'contains'    AND v.VehiclePlate LIKE N'%' + r.EscapedVal + N'%')
                          ))
                          OR (r.Field = 'status' AND (
                              (r.Op = '='  AND tr.Status = r.Val) OR
                              (r.Op = '!=' AND tr.Status <> r.Val)
                          ))
                          OR (r.Field = 'createdAt' AND (
                              (r.Op = '>=' AND TRY_CAST(r.Val AS DATETIME2(0)) IS NOT NULL AND tr.CreatedAt >= TRY_CAST(r.Val AS DATETIME2(0))) OR
                              (r.Op = '<=' AND TRY_CAST(r.Val AS DATE) IS NOT NULL AND tr.CreatedAt < DATEADD(DAY, 1, TRY_CAST(r.Val AS DATE))) OR
                              (r.Op = '='  AND TRY_CAST(r.Val AS DATE) IS NOT NULL AND CAST(tr.CreatedAt AS DATE) = TRY_CAST(r.Val AS DATE))
                          ))
                          OR (r.Field = 'issueType' AND (
                              (r.Op = '='  AND tr.IssueType = r.Val) OR
                              (r.Op = '!=' AND tr.IssueType <> r.Val)
                          ))
                          OR (r.Field = 'requestNumber' AND (
                              (r.Op = '='           AND tr.RequestNumber = r.Val) OR
                              (r.Op = '!='          AND tr.RequestNumber <> r.Val) OR
                              (r.Op = 'starts_with' AND tr.RequestNumber LIKE r.EscapedVal + N'%') OR
                              (r.Op = 'contains'    AND tr.RequestNumber LIKE N'%' + r.EscapedVal + N'%')
                          ))
                          OR (r.Field = 'invoiceStatus' AND (
                              (r.Op = '='  AND inv.InvoiceStatus = r.Val) OR
                              (r.Op = '!=' AND inv.InvoiceStatus <> r.Val)
                          ))
                          OR (r.Field = 'policyId' AND TRY_CAST(r.Val AS INT) IS NOT NULL AND (
                              (r.Op = '='  AND tr.PolicyId = TRY_CAST(r.Val AS INT)) OR
                              (r.Op = '>=' AND tr.PolicyId >= TRY_CAST(r.Val AS INT)) OR
                              (r.Op = '<=' AND tr.PolicyId <= TRY_CAST(r.Val AS INT))
                          ))
                          OR (r.Field = 'distanceKm' AND TRY_CAST(r.Val AS DECIMAL(8,2)) IS NOT NULL AND (
                              (r.Op = '='  AND tr.RouteDistanceKm = TRY_CAST(r.Val AS DECIMAL(8,2))) OR
                              (r.Op = '>=' AND tr.RouteDistanceKm >= TRY_CAST(r.Val AS DECIMAL(8,2))) OR
                              (r.Op = '<=' AND tr.RouteDistanceKm <= TRY_CAST(r.Val AS DECIMAL(8,2)))
                          ))
                      )
                  )
              )
              OR (
                  @IsAll = 0
                  AND EXISTS (
                      SELECT 1
                      FROM @Rules AS r
                      WHERE (
                          (r.Field = 'vehiclePlate' AND (
                              (r.Op = '='           AND v.VehiclePlate = r.Val) OR
                              (r.Op = '!='          AND v.VehiclePlate <> r.Val) OR
                              (r.Op = 'starts_with' AND v.VehiclePlate LIKE r.EscapedVal + N'%') OR
                              (r.Op = 'contains'    AND v.VehiclePlate LIKE N'%' + r.EscapedVal + N'%')
                          ))
                          OR (r.Field = 'status' AND (
                              (r.Op = '='  AND tr.Status = r.Val) OR
                              (r.Op = '!=' AND tr.Status <> r.Val)
                          ))
                          OR (r.Field = 'createdAt' AND (
                              (r.Op = '>=' AND TRY_CAST(r.Val AS DATETIME2(0)) IS NOT NULL AND tr.CreatedAt >= TRY_CAST(r.Val AS DATETIME2(0))) OR
                              (r.Op = '<=' AND TRY_CAST(r.Val AS DATE) IS NOT NULL AND tr.CreatedAt < DATEADD(DAY, 1, TRY_CAST(r.Val AS DATE))) OR
                              (r.Op = '='  AND TRY_CAST(r.Val AS DATE) IS NOT NULL AND CAST(tr.CreatedAt AS DATE) = TRY_CAST(r.Val AS DATE))
                          ))
                          OR (r.Field = 'issueType' AND (
                              (r.Op = '='  AND tr.IssueType = r.Val) OR
                              (r.Op = '!=' AND tr.IssueType <> r.Val)
                          ))
                          OR (r.Field = 'requestNumber' AND (
                              (r.Op = '='           AND tr.RequestNumber = r.Val) OR
                              (r.Op = '!='          AND tr.RequestNumber <> r.Val) OR
                              (r.Op = 'starts_with' AND tr.RequestNumber LIKE r.EscapedVal + N'%') OR
                              (r.Op = 'contains'    AND tr.RequestNumber LIKE N'%' + r.EscapedVal + N'%')
                          ))
                          OR (r.Field = 'invoiceStatus' AND (
                              (r.Op = '='  AND inv.InvoiceStatus = r.Val) OR
                              (r.Op = '!=' AND inv.InvoiceStatus <> r.Val)
                          ))
                          OR (r.Field = 'policyId' AND TRY_CAST(r.Val AS INT) IS NOT NULL AND (
                              (r.Op = '='  AND tr.PolicyId = TRY_CAST(r.Val AS INT)) OR
                              (r.Op = '>=' AND tr.PolicyId >= TRY_CAST(r.Val AS INT)) OR
                              (r.Op = '<=' AND tr.PolicyId <= TRY_CAST(r.Val AS INT))
                          ))
                          OR (r.Field = 'distanceKm' AND TRY_CAST(r.Val AS DECIMAL(8,2)) IS NOT NULL AND (
                              (r.Op = '='  AND tr.RouteDistanceKm = TRY_CAST(r.Val AS DECIMAL(8,2))) OR
                              (r.Op = '>=' AND tr.RouteDistanceKm >= TRY_CAST(r.Val AS DECIMAL(8,2))) OR
                              (r.Op = '<=' AND tr.RouteDistanceKm <= TRY_CAST(r.Val AS DECIMAL(8,2)))
                          ))
                      )
                  )
              )
          )
        ORDER BY tr.CreatedAt DESC;

        SET STATISTICS IO OFF;
        RETURN;
    END;

    IF @Mode = 'policy'
    BEGIN
        SELECT TOP (50)
            tr.TowRequestId,
            tr.RequestNumber,
            v.VehiclePlate,
            v.VehicleModel,
            tr.IssueType,
            tr.Status,
            tr.RouteDistanceKm AS ActualDistanceKm,
            tr.DistanceSource,
            inv.CoveredDistanceKm AS AllowedDistanceKm,
            inv.CustomerBilledAmount AS OverageAmount,
            inv.InsurerBilledAmount,
            inv.TotalAmount,
            inv.InvoiceStatus,
            tr.CreatedAt
        FROM dbo.TowRequests AS tr
        INNER JOIN dbo.Vehicles AS v ON tr.VehicleId = v.VehicleId
        INNER JOIN dbo.TowInvoices AS inv ON tr.TowRequestId = inv.TowRequestId
        WHERE tr.PolicyId = @PolicyId
          AND tr.IssueType = @IssueType
          AND tr.Status IN ('Approved', 'InProgress', 'Done')
        ORDER BY tr.CreatedAt DESC;
    END
    ELSE IF @Mode = 'plate'
    BEGIN
        DECLARE @TargetVehicleId INT;
        SELECT @TargetVehicleId = v.VehicleId
        FROM dbo.Vehicles AS v
        WHERE v.NoPlate = 0
          AND v.VehiclePlate = @VehiclePlate;

        SELECT TOP (50)
            tr.TowRequestId,
            tr.RequestNumber,
            v.VehiclePlate,
            v.VehicleModel,
            tr.IssueType,
            tr.Status,
            tr.RouteDistanceKm AS ActualDistanceKm,
            tr.DistanceSource,
            inv.CoveredDistanceKm AS AllowedDistanceKm,
            inv.CustomerBilledAmount AS OverageAmount,
            inv.InsurerBilledAmount,
            inv.TotalAmount,
            inv.InvoiceStatus,
            tr.CreatedAt
        FROM dbo.TowRequests AS tr
        INNER JOIN dbo.Vehicles AS v ON tr.VehicleId = v.VehicleId
        INNER JOIN dbo.TowInvoices AS inv ON tr.TowRequestId = inv.TowRequestId
        WHERE tr.VehicleId = @TargetVehicleId
        ORDER BY tr.CreatedAt DESC;
    END
    ELSE
    BEGIN
        SELECT TOP (50)
            tr.TowRequestId,
            tr.RequestNumber,
            v.VehiclePlate,
            v.VehicleModel,
            tr.IssueType,
            tr.Status,
            tr.RouteDistanceKm AS ActualDistanceKm,
            tr.DistanceSource,
            inv.CoveredDistanceKm AS AllowedDistanceKm,
            inv.CustomerBilledAmount AS OverageAmount,
            inv.InsurerBilledAmount,
            inv.TotalAmount,
            inv.InvoiceStatus,
            tr.CreatedAt
        FROM dbo.TowRequests AS tr
        INNER JOIN dbo.Vehicles AS v ON tr.VehicleId = v.VehicleId
        INNER JOIN dbo.TowInvoices AS inv ON tr.TowRequestId = inv.TowRequestId
        WHERE tr.Status = @Status
          AND tr.CreatedAt >= @StartDate
          AND tr.CreatedAt < @EndDate
        ORDER BY tr.CreatedAt DESC;
    END;

    SET STATISTICS IO OFF;
END;
GO

/*==============================================================================
  5L. STORED PROCEDURE: dbo.usp_GetDashboardSnapshot
  Loads all normalized entities, KPIs, security diagnostics, fleet telemetry,
  driver assignments, tariffs, invoices/payments, and audit trail in one call.
==============================================================================*/
CREATE OR ALTER PROCEDURE dbo.usp_GetDashboardSnapshot
AS
BEGIN
    SET NOCOUNT ON;

    -- Result Set 1: KPIs + Least-Privilege & SESSION_CONTEXT Diagnostics
    SELECT
        (SELECT COUNT(*) FROM dbo.TowRequests) AS TotalTowRequests,
        (SELECT COUNT(*) FROM dbo.TowRequests WHERE Status IN ('Approved', 'InProgress')) AS ActiveDispatches,
        (SELECT COUNT(*) FROM dbo.TowRequests WHERE Status IN ('Draft', 'PendingInsurance')) AS PendingDrafts,
        (SELECT COUNT(*) FROM dbo.TowTrucks WHERE FleetStatus = 'Available') AS AvailableTrucks,
        (SELECT COUNT(*) FROM dbo.InsurancePolicies WHERE PolicyStatus = 'Active') AS ActivePolicies,
        (SELECT COUNT(*) FROM dbo.TowAuditLogs) AS TotalAuditLogs,
        ISNULL((SELECT SUM(InsurerBilledAmount - InsurerPaidAmount) FROM dbo.TowInvoices WHERE InvoiceStatus IN ('Unpaid', 'PartiallyPaid')), 0.00) AS UnpaidInsurerBalance,
        ISNULL((SELECT SUM(CustomerBilledAmount - CustomerPaidAmount) FROM dbo.TowInvoices WHERE InvoiceStatus IN ('Unpaid', 'PartiallyPaid')), 0.00) AS UnpaidCustomerBalance,
        SUSER_SNAME() AS ConnectedSqlLogin,
        USER_NAME() AS ConnectedDatabaseUser,
        IS_ROLEMEMBER('db_tow_dispatcher_role') AS IsLeastPrivilegeRoleMember,
        IS_SRVROLEMEMBER('sysadmin') AS IsSysAdmin,
        ISNULL(HAS_PERMS_BY_NAME('dbo.TowRequests', 'OBJECT', 'SELECT'), 0) AS DirectTableSelectAllowed,
        TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT) AS SessionUserId,
        ISNULL(CAST(SESSION_CONTEXT(N'AppUsername') AS VARCHAR(60)), '') AS SessionUsername;

    -- Result Set 2: Active PlateCodes
    SELECT PlateCodeId, Code, RegionDescription, DisplaySequence
    FROM dbo.PlateCodes
    WHERE IsActive = 1
    ORDER BY DisplaySequence ASC, Code ASC;

    -- Result Set 3: Featured Customers (1:N parent of Vehicles & InsurancePolicies)
    SELECT
        c.CustomerId,
        c.FullName,
        c.Phone,
        ISNULL(c.Email, '') AS Email,
        (SELECT COUNT(*) FROM dbo.InsurancePolicies AS p WHERE p.CustomerId = c.CustomerId) AS PolicyCount,
        (SELECT COUNT(*) FROM dbo.Vehicles AS v WHERE v.CustomerId = c.CustomerId) AS VehicleCount
    FROM dbo.Customers AS c
    WHERE c.CustomerId <= 25 OR c.CustomerId > 2000
    ORDER BY CASE WHEN c.CustomerId > 2000 THEN 0 ELSE 1 END, c.CustomerId ASC;

    -- Result Set 4: Featured Customers' Normalized Vehicles
    SELECT
        v.VehicleId, v.CustomerId, v.PlateCodeId, ISNULL(v.PlateDigits, '') AS PlateDigits,
        v.NoPlate, v.VehiclePlate, v.VehicleModel
    FROM dbo.Vehicles AS v
    WHERE v.CustomerId <= 25 OR v.CustomerId > 2000 OR v.VehicleId <= 30
    ORDER BY v.CustomerId ASC, v.VehicleId ASC;

    -- Result Set 5: InsuranceProviders
    SELECT ProviderId, ProviderName, SupportPhone, ContractEmail
    FROM dbo.InsuranceProviders
    WHERE IsActive = 1
    ORDER BY ProviderId ASC;

    -- Result Set 6: Featured InsurancePolicies
    SELECT
        p.PolicyId, p.PolicyNumber, p.CustomerId, c.FullName AS CustomerName, c.Phone AS CustomerPhone,
        p.ProviderId, pr.ProviderName, p.StartDate, p.ExpirationDate,
        p.DefaultAllowedKm, p.DefaultMinIntervalDays, p.PolicyStatus
    FROM dbo.InsurancePolicies AS p
    INNER JOIN dbo.Customers AS c ON p.CustomerId = c.CustomerId
    INNER JOIN dbo.InsuranceProviders AS pr ON p.ProviderId = pr.ProviderId
    WHERE p.CustomerId <= 25 OR p.CustomerId > 2000 OR p.PolicyId <= 25 OR p.PolicyId > 1500
    ORDER BY p.CustomerId ASC, p.PolicyId ASC;

    -- Result Set 7: Quota Tiers for Featured Policies
    SELECT
        qt.QuotaTierId, qt.PolicyId, qt.TierSequence, qt.CoverageType,
        qt.AllowedTows, qt.UsedTows, (qt.AllowedTows - qt.UsedTows) AS RemainingTows,
        qt.MaxDistanceKm, qt.MinIntervalDays
    FROM dbo.PolicyQuotaTiers AS qt
    INNER JOIN dbo.InsurancePolicies AS p ON qt.PolicyId = p.PolicyId
    WHERE p.CustomerId <= 25 OR p.CustomerId > 2000 OR p.PolicyId <= 25 OR p.PolicyId > 1500
    ORDER BY qt.PolicyId ASC, qt.TierSequence ASC, qt.QuotaTierId ASC;

    -- Result Set 8: Normalized Drivers
    SELECT
        d.DriverId, d.EmployeeCode, d.FullName, d.Phone, d.LicenseNumber,
        d.BaseMonthlySalary, d.OvertimeRatePerTow, d.IsWorkingOffDay, d.DriverStatus,
        dta.TruckId AS ActiveTruckId, ISNULL(t.TruckCode, 'UNASSIGNED') AS ActiveTruckCode
    FROM dbo.Drivers AS d
    LEFT JOIN dbo.DriverTruckAssignments AS dta ON dta.DriverId = d.DriverId AND dta.EndDate IS NULL
    LEFT JOIN dbo.TowTrucks AS t ON t.TruckId = dta.TruckId
    ORDER BY d.EmployeeCode ASC;

    -- Result Set 9: DriverTruckAssignments History (Active + Historical)
    SELECT TOP (80)
        dta.AssignmentId, dta.DriverId, d.EmployeeCode, d.FullName AS DriverName,
        dta.TruckId, t.TruckCode, t.LicensePlate AS TruckPlate,
        dta.StartDate, dta.EndDate, ISNULL(dta.AssignmentNotes, '') AS AssignmentNotes
    FROM dbo.DriverTruckAssignments AS dta
    INNER JOIN dbo.Drivers AS d ON dta.DriverId = d.DriverId
    INNER JOIN dbo.TowTrucks AS t ON dta.TruckId = t.TruckId
    ORDER BY CASE WHEN dta.EndDate IS NULL THEN 0 ELSE 1 END ASC, dta.StartDate DESC, dta.AssignmentId DESC;

    -- Result Set 10: Fleet TowTrucks (joined with currently assigned Driver)
    SELECT
        t.TruckId, t.TruckCode, t.LicensePlate, t.TruckModel, t.MaxPayloadKg,
        t.CurrentLat, t.CurrentLng, t.SpeedKmh, t.FleetStatus, t.LastTelemetryAt,
        dta.DriverId,
        ISNULL(d.FullName, N'Unassigned') AS DriverName,
        ISNULL(d.Phone, '—') AS DriverPhone,
        ISNULL(d.BaseMonthlySalary, 0.00) AS BaseMonthlySalary,
        ISNULL(d.OvertimeRatePerTow, 0.00) AS OvertimeRatePerTow,
        ISNULL(d.IsWorkingOffDay, 0) AS IsWorkingOffDay
    FROM dbo.TowTrucks AS t
    LEFT JOIN dbo.DriverTruckAssignments AS dta ON dta.TruckId = t.TruckId AND dta.EndDate IS NULL
    LEFT JOIN dbo.Drivers AS d ON d.DriverId = dta.DriverId
    ORDER BY t.TruckCode ASC;

    -- Result Set 11: Normalized Subcontractors
    SELECT SubcontractorId, CompanyName, ISNULL(ContactPerson, '') AS ContactPerson, Phone, CoverageRegion, DefaultDispatchFee
    FROM dbo.Subcontractors
    WHERE IsActive = 1
    ORDER BY CompanyName ASC;

    -- Result Set 12: Tariffs (Active & Historical)
    SELECT
        TariffId, TariffCode, TariffName, ServiceCategory,
        BaseFee, PricePerKm, NightSurcharge, EffectiveFrom, EffectiveTo, IsActive
    FROM dbo.Tariffs
    ORDER BY IsActive DESC, EffectiveFrom DESC, TariffId DESC;

    -- Result Set 13: Window Function Priority Queue View
    SELECT
        TowRequestId, RequestNumber, AssignedTruckId, TruckCode, TruckPlate, DriverName,
        FleetStatus, VehiclePlate, VehicleModel, IssueType, Status, TruckPrioritySequence,
        PickupAddress, PickupLat, PickupLng, DestinationAddress, DestinationLat, DestinationLng,
        ActualDistanceKm, DistanceSource, OverageAmount, InsurerBilledAmount,
        StopNumberInTruckQueue, CumulativeQueueDistanceKm, TotalActiveJobsForTruck
    FROM dbo.vw_FleetPriorityQueueAndRankings
    ORDER BY TruckCode ASC, StopNumberInTruckQueue ASC;

    -- Result Set 14: Recent Operational TowRequests (joined across normalized tables)
    SELECT TOP (60)
        tr.TowRequestId, tr.RequestNumber, tr.CustomerId, c.FullName AS CustomerName,
        tr.CallerPhone, v.VehicleId, v.VehiclePlate, v.VehicleModel,
        tr.IssueType, ISNULL(tr.IssueNotes, '') AS IssueNotes,
        tr.PickupAddress, tr.PickupLat, tr.PickupLng,
        tr.DestinationAddress, tr.DestinationLat, tr.DestinationLng,
        CAST(CASE WHEN tr.PolicyId IS NOT NULL THEN 1 ELSE 0 END AS BIT) AS HasInsurance,
        tr.PolicyId, p.PolicyNumber,
        CAST(CASE WHEN tr.SubcontractorId IS NOT NULL THEN 1 ELSE 0 END AS BIT) AS IsOutsourced,
        tr.SubcontractorId, sub.CompanyName AS SubcontractorName, ISNULL(inv.SubcontractorCost, 0.00) AS SubcontractorFee,
        tr.AssignedTruckId, t.TruckCode, tr.AssignedDriverId, drv.FullName AS AssignedDriverName,
        tr.TruckPrioritySequence,
        tr.StraightLineDistanceKm, tr.RouteDistanceKm AS ActualDistanceKm, tr.DistanceSource,
        ISNULL(inv.CoveredDistanceKm, 0.00) AS AllowedDistanceKm,
        ISNULL(inv.OverageDistanceKm, 0.00) AS OverageKm,
        ISNULL(inv.CustomerBilledAmount, 0.00) AS OverageAmount,
        ISNULL(inv.InsurerBilledAmount, 0.00) AS InsurerBilledAmount,
        ISNULL(inv.TotalAmount, 0.00) AS TotalInvoiceAmount,
        ISNULL(inv.CustomerPaidAmount, 0.00) AS CashCollected,
        ISNULL(inv.InvoiceStatus, 'Draft') AS InvoiceStatus,
        ISNULL(inv.InvoiceId, 0) AS InvoiceId,
        tr.IsNightShift, tr.Status, tr.RejectionReason, tr.CreatedAt,
        CAST(tr.RowVer AS BINARY(8)) AS RowVerBytes,
        tr.CreatedByUserId,
        ISNULL(cu.Username, '') AS CreatedByUsername
    FROM dbo.TowRequests AS tr
    INNER JOIN dbo.Customers AS c ON tr.CustomerId = c.CustomerId
    INNER JOIN dbo.Vehicles AS v ON tr.VehicleId = v.VehicleId
    LEFT JOIN dbo.InsurancePolicies AS p ON tr.PolicyId = p.PolicyId
    LEFT JOIN dbo.TowTrucks AS t ON tr.AssignedTruckId = t.TruckId
    LEFT JOIN dbo.Drivers AS drv ON tr.AssignedDriverId = drv.DriverId
    LEFT JOIN dbo.Subcontractors AS sub ON tr.SubcontractorId = sub.SubcontractorId
    LEFT JOIN dbo.TowInvoices AS inv ON tr.TowRequestId = inv.TowRequestId
    LEFT JOIN dbo.SystemUsers AS cu ON tr.CreatedByUserId = cu.UserId
    ORDER BY tr.TowRequestId DESC;

    -- Result Set 15: Recent TowInvoices (Insurer vs Customer Obligations & Partial Balances)
    SELECT TOP (60)
        inv.InvoiceId, inv.InvoiceNumber, inv.TowRequestId, tr.RequestNumber,
        inv.TariffId, tf.TariffCode, tf.TariffName,
        inv.InsuranceProviderId, pr.ProviderName AS InsuranceProviderName,
        inv.CustomerId, c.FullName AS CustomerName,
        inv.AppliedBaseFee, inv.AppliedPricePerKm, inv.AppliedNightSurcharge,
        inv.CoveredDistanceKm, inv.OverageDistanceKm, inv.SubcontractorCost,
        inv.InsurerBilledAmount, inv.InsurerPaidAmount,
        (inv.InsurerBilledAmount - inv.InsurerPaidAmount) AS InsurerBalanceDue,
        inv.CustomerBilledAmount, inv.CustomerPaidAmount,
        (inv.CustomerBilledAmount - inv.CustomerPaidAmount) AS CustomerBalanceDue,
        inv.TotalAmount, inv.InvoiceStatus, inv.IssuedAt
    FROM dbo.TowInvoices AS inv
    INNER JOIN dbo.TowRequests AS tr ON inv.TowRequestId = tr.TowRequestId
    INNER JOIN dbo.Tariffs AS tf ON inv.TariffId = tf.TariffId
    INNER JOIN dbo.Customers AS c ON inv.CustomerId = c.CustomerId
    LEFT JOIN dbo.InsuranceProviders AS pr ON inv.InsuranceProviderId = pr.ProviderId
    ORDER BY inv.InvoiceId DESC;

    -- Result Set 16: Recent Individual InvoicePayments (Each Partial Payment Row)
    SELECT TOP (60)
        ip.PaymentId, ip.InvoiceId, inv.InvoiceNumber, tr.RequestNumber,
        ip.PayerType,
        CASE WHEN ip.PayerType = 'InsuranceProvider' THEN pr.ProviderName ELSE c.FullName END AS PayerName,
        ip.AmountPaid, ip.PaymentMethod, ISNULL(ip.ReferenceNumber, '') AS ReferenceNumber,
        drv.FullName AS CollectedByDriverName,
        u.Username AS RecordedByUsername,
        ip.PaidAt, ISNULL(ip.Notes, '') AS Notes,
        ip.CollectedByDriverId,
        ip.RecordedByUserId
    FROM dbo.InvoicePayments AS ip
    INNER JOIN dbo.TowInvoices AS inv ON ip.InvoiceId = inv.InvoiceId
    INNER JOIN dbo.TowRequests AS tr ON inv.TowRequestId = tr.TowRequestId
    LEFT JOIN dbo.InsuranceProviders AS pr ON ip.InsuranceProviderId = pr.ProviderId
    LEFT JOIN dbo.Customers AS c ON ip.CustomerId = c.CustomerId
    LEFT JOIN dbo.Drivers AS drv ON ip.CollectedByDriverId = drv.DriverId
    LEFT JOIN dbo.SystemUsers AS u ON ip.RecordedByUserId = u.UserId
    ORDER BY ip.PaymentId DESC;

    -- Result Set 17: Driver Payroll Report View
    SELECT
        DriverId, EmployeeCode, DriverName, DriverPhone, DriverStatus,
        ISNULL(TruckId, 0) AS TruckId, TruckCode, LicensePlate, FleetStatus,
        BaseMonthlySalary, OvertimeRatePerTow, IsWorkingOffDay,
        CompletedTowsThisMonth, OvertimeTowsCount, OvertimePayEarned,
        TotalCashCollectedByDriver, NetSalaryPayoutAfterCashDeduction
    FROM dbo.vw_DriverPayrollAndCashReport
    ORDER BY EmployeeCode ASC;

    -- Result Set 18: Trigger Audit Logs (showing actual SESSION_CONTEXT Dispatcher!)
    SELECT TOP (25)
        AuditId, TowRequestId, RequestNumber, OldStatus, NewStatus, ActionNote,
        DispatcherUserId, DispatcherUsername, ISNULL(DispatcherFullName, '') AS DispatcherFullName,
        SqlLoginName, ChangedAt
    FROM dbo.TowAuditLogs
    ORDER BY AuditId DESC;
END;
GO

/*==============================================================================
  5M. NORMALIZED 3NF USER GROUPS & SYSTEM USERS STORED PROCEDURES
  - Permissions belong exclusively to dbo.UserGroups (3NF).
  - dbo.SystemUsers references GroupId -> dbo.UserGroups(GroupId).
==============================================================================*/
CREATE OR ALTER PROCEDURE dbo.usp_GetUserGroups
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @CurrentUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @CurrentUserId IS NULL
        THROW 50031, 'Security Context Violation: Authenticated dispatcher SESSION_CONTEXT(AppUserId) is required.', 1;

    SELECT
        ug.GroupId,
        ug.GroupCode,
        ug.GroupName,
        ISNULL(ug.Description, N'') AS Description,
        ug.CanDispatch,
        ug.CanManageFleet,
        ug.CanManagePolicies,
        ug.CanManageBilling,
        ug.CanManageUsers,
        ug.IsSystemBuiltIn,
        ug.CreatedAt,
        (SELECT COUNT(*) FROM dbo.SystemUsers AS u WHERE u.GroupId = ug.GroupId) AS MemberCount
    FROM dbo.UserGroups AS ug
    ORDER BY ug.GroupId ASC;
END;
GO

CREATE OR ALTER PROCEDURE dbo.usp_CreateUserGroup
    @GroupCode          VARCHAR(30),
    @GroupName          NVARCHAR(80),
    @Description        NVARCHAR(250) = NULL,
    @CanDispatch        BIT = 1,
    @CanManageFleet     BIT = 0,
    @CanManagePolicies  BIT = 0,
    @CanManageBilling   BIT = 0,
    @CanManageUsers     BIT = 0
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @CurrentUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @CurrentUserId IS NULL
        THROW 50031, 'Security Context Violation: Authenticated dispatcher SESSION_CONTEXT(AppUserId) is required.', 1;

    IF NOT EXISTS (
        SELECT 1 FROM dbo.SystemUsers AS u
        INNER JOIN dbo.UserGroups AS ug ON u.GroupId = ug.GroupId
        WHERE u.UserId = @CurrentUserId AND u.IsActive = 1 AND ug.CanManageUsers = 1
    )
        THROW 50032, 'Access Denied: Administrator permission (CanManageUsers = 1) is required to create user groups.', 1;

    DECLARE @CleanCode VARCHAR(30) = UPPER(REPLACE(LTRIM(RTRIM(@GroupCode)), ' ', '_'));
    INSERT INTO dbo.UserGroups (
        GroupCode, GroupName, Description,
        CanDispatch, CanManageFleet, CanManagePolicies, CanManageBilling, CanManageUsers, IsSystemBuiltIn
    )
    VALUES (
        @CleanCode, LTRIM(RTRIM(@GroupName)), NULLIF(LTRIM(RTRIM(@Description)), N''),
        @CanDispatch, @CanManageFleet, @CanManagePolicies, @CanManageBilling, @CanManageUsers, 0
    );

    SELECT CAST(SCOPE_IDENTITY() AS INT) AS NewGroupId;
END;
GO

CREATE OR ALTER PROCEDURE dbo.usp_UpdateUserGroup
    @GroupId            INT,
    @GroupCode          VARCHAR(30),
    @GroupName          NVARCHAR(80),
    @Description        NVARCHAR(250) = NULL,
    @CanDispatch        BIT,
    @CanManageFleet     BIT,
    @CanManagePolicies  BIT,
    @CanManageBilling   BIT,
    @CanManageUsers     BIT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @CurrentUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @CurrentUserId IS NULL
        THROW 50031, 'Security Context Violation: Authenticated dispatcher SESSION_CONTEXT(AppUserId) is required.', 1;

    DECLARE @MyGroupId INT, @IsAdmin BIT = 0;
    SELECT @MyGroupId = u.GroupId, @IsAdmin = ug.CanManageUsers
    FROM dbo.SystemUsers AS u
    INNER JOIN dbo.UserGroups AS ug ON u.GroupId = ug.GroupId
    WHERE u.UserId = @CurrentUserId AND u.IsActive = 1;

    IF ISNULL(@IsAdmin, 0) = 0
        THROW 50032, 'Access Denied: Administrator permission (CanManageUsers = 1) is required to edit user groups.', 1;

    IF @GroupId = @MyGroupId AND @CanManageUsers = 0
        THROW 50038, 'Safety Lockout Guard: You cannot strip CanManageUsers permission from your own assigned User Group.', 1;

    UPDATE dbo.UserGroups
    SET GroupCode         = CASE WHEN IsSystemBuiltIn = 1 THEN GroupCode ELSE UPPER(REPLACE(LTRIM(RTRIM(@GroupCode)), ' ', '_')) END,
        GroupName         = LTRIM(RTRIM(@GroupName)),
        Description       = NULLIF(LTRIM(RTRIM(@Description)), N''),
        CanDispatch       = @CanDispatch,
        CanManageFleet    = @CanManageFleet,
        CanManagePolicies = @CanManagePolicies,
        CanManageBilling  = @CanManageBilling,
        CanManageUsers    = @CanManageUsers
    WHERE GroupId = @GroupId;
END;
GO

CREATE OR ALTER PROCEDURE dbo.usp_DeleteUserGroup
    @GroupId INT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @CurrentUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @CurrentUserId IS NULL
        THROW 50031, 'Security Context Violation: Authenticated dispatcher SESSION_CONTEXT(AppUserId) is required.', 1;

    IF NOT EXISTS (
        SELECT 1 FROM dbo.SystemUsers AS u
        INNER JOIN dbo.UserGroups AS ug ON u.GroupId = ug.GroupId
        WHERE u.UserId = @CurrentUserId AND u.IsActive = 1 AND ug.CanManageUsers = 1
    )
        THROW 50032, 'Access Denied: Administrator permission (CanManageUsers = 1) is required to delete user groups.', 1;

    IF EXISTS (SELECT 1 FROM dbo.UserGroups WHERE GroupId = @GroupId AND IsSystemBuiltIn = 1)
        THROW 50039, 'Protected System Group: Built-in system groups cannot be deleted.', 1;

    IF EXISTS (SELECT 1 FROM dbo.SystemUsers WHERE GroupId = @GroupId)
        THROW 50045, 'Referential Integrity Guard: Reassign all users in this group to another User Group before deleting it.', 1;

    DELETE FROM dbo.UserGroups WHERE GroupId = @GroupId;
END;
GO

CREATE OR ALTER PROCEDURE dbo.usp_GetAdminSystemUsers
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @CurrentUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @CurrentUserId IS NULL
        THROW 50031, 'Security Context Violation: Authenticated dispatcher SESSION_CONTEXT(AppUserId) is required.', 1;

    DECLARE @IsAdmin BIT = 0;
    SELECT @IsAdmin = ug.CanManageUsers
    FROM dbo.SystemUsers AS u
    INNER JOIN dbo.UserGroups AS ug ON u.GroupId = ug.GroupId
    WHERE u.UserId = @CurrentUserId AND u.IsActive = 1;

    IF ISNULL(@IsAdmin, 0) = 0
        THROW 50032, 'Access Denied: Administrator permission (CanManageUsers = 1) is required to view and manage system users.', 1;

    SELECT
        u.UserId,
        u.Username,
        u.FullName,
        u.RoleTitle,
        u.Department,
        u.StationCode,
        ug.GroupCode AS AccessRole,
        u.IsActive,
        ug.CanDispatch,
        ug.CanManageFleet,
        ug.CanManagePolicies,
        ug.CanManageBilling,
        ug.CanManageUsers,
        u.LastLoginAt,
        (SELECT COUNT(*) FROM dbo.TowRequests AS tr WHERE tr.CreatedByUserId = u.UserId) AS CreatedTowCount,
        (SELECT COUNT(*) FROM dbo.TowAuditLogs AS al WHERE al.DispatcherUserId = u.UserId) AS AuditActionCount,
        u.GroupId,
        ug.GroupCode,
        ug.GroupName
    FROM dbo.SystemUsers AS u
    INNER JOIN dbo.UserGroups AS ug ON u.GroupId = ug.GroupId
    ORDER BY u.UserId ASC;
END;
GO

CREATE OR ALTER PROCEDURE dbo.usp_AdminCreateSystemUser
    @Username           VARCHAR(60),
    @PasswordHash       VARCHAR(255),
    @FullName           NVARCHAR(120),
    @RoleTitle          NVARCHAR(80),
    @Department         NVARCHAR(80),
    @StationCode        VARCHAR(30),
    @GroupId            INT = NULL,
    @AccessRole         VARCHAR(30) = NULL,
    @IsActive           BIT = 1
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @CurrentUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @CurrentUserId IS NULL
        THROW 50031, 'Security Context Violation: Authenticated dispatcher SESSION_CONTEXT(AppUserId) is required.', 1;

    DECLARE @IsAdmin BIT = 0;
    SELECT @IsAdmin = ug.CanManageUsers
    FROM dbo.SystemUsers AS u
    INNER JOIN dbo.UserGroups AS ug ON u.GroupId = ug.GroupId
    WHERE u.UserId = @CurrentUserId AND u.IsActive = 1;

    IF ISNULL(@IsAdmin, 0) = 0
        THROW 50032, 'Access Denied: Administrator permission (CanManageUsers = 1) is required to create users.', 1;

    DECLARE @CleanUsername VARCHAR(60) = LOWER(LTRIM(RTRIM(@Username)));
    IF LEN(@CleanUsername) < 3
        THROW 50035, 'Validation Error: Username must be at least 3 characters.', 1;

    IF EXISTS (SELECT 1 FROM dbo.SystemUsers WHERE LOWER(Username) = @CleanUsername)
        THROW 50036, 'Duplicate Username: An operator with this username already exists.', 1;

    DECLARE @ResolvedGroupId INT = @GroupId;
    IF @ResolvedGroupId IS NULL OR NOT EXISTS (SELECT 1 FROM dbo.UserGroups WHERE GroupId = @ResolvedGroupId)
    BEGIN
        SELECT TOP (1) @ResolvedGroupId = ug.GroupId
        FROM dbo.UserGroups AS ug
        WHERE ug.GroupCode = CASE
            WHEN UPPER(ISNULL(@AccessRole, '')) IN ('ADMIN') THEN 'ADMIN'
            WHEN UPPER(ISNULL(@AccessRole, '')) IN ('FLEETMANAGER', 'FLEET_MANAGER') THEN 'FLEET_MANAGER'
            WHEN UPPER(ISNULL(@AccessRole, '')) IN ('UNDERWRITER') THEN 'UNDERWRITER'
            ELSE UPPER(ISNULL(@AccessRole, 'DISPATCHER'))
        END;
    END;
    IF @ResolvedGroupId IS NULL SET @ResolvedGroupId = 2;

    BEGIN TRY
        BEGIN TRANSACTION;

        INSERT INTO dbo.SystemUsers
        (
            Username, PasswordHash, FullName, RoleTitle, Department, StationCode, GroupId, IsActive
        )
        VALUES
        (
            @CleanUsername, @PasswordHash, LTRIM(RTRIM(@FullName)), LTRIM(RTRIM(@RoleTitle)),
            LTRIM(RTRIM(@Department)), UPPER(LTRIM(RTRIM(@StationCode))), @ResolvedGroupId, @IsActive
        );

        DECLARE @NewUserId INT = SCOPE_IDENTITY();
        COMMIT TRANSACTION;

        SELECT
            u.UserId, u.Username, u.FullName, u.RoleTitle, u.Department, u.StationCode,
            ug.GroupCode AS AccessRole, u.IsActive,
            ug.CanDispatch, ug.CanManageFleet, ug.CanManagePolicies, ug.CanManageBilling, ug.CanManageUsers,
            u.GroupId, ug.GroupName
        FROM dbo.SystemUsers AS u
        INNER JOIN dbo.UserGroups AS ug ON u.GroupId = ug.GroupId
        WHERE u.UserId = @NewUserId;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;
        THROW;
    END CATCH;
END;
GO

CREATE OR ALTER PROCEDURE dbo.usp_AdminUpdateSystemUser
    @TargetUserId       INT,
    @FullName           NVARCHAR(120),
    @RoleTitle          NVARCHAR(80),
    @Department         NVARCHAR(80),
    @StationCode        VARCHAR(30),
    @GroupId            INT = NULL,
    @AccessRole         VARCHAR(30) = NULL,
    @IsActive           BIT,
    @NewPasswordHash    VARCHAR(255) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @CurrentUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @CurrentUserId IS NULL
        THROW 50031, 'Security Context Violation: Authenticated dispatcher SESSION_CONTEXT(AppUserId) is required.', 1;

    DECLARE @IsAdmin BIT = 0;
    SELECT @IsAdmin = ug.CanManageUsers
    FROM dbo.SystemUsers AS u
    INNER JOIN dbo.UserGroups AS ug ON u.GroupId = ug.GroupId
    WHERE u.UserId = @CurrentUserId AND u.IsActive = 1;

    IF ISNULL(@IsAdmin, 0) = 0
        THROW 50032, 'Access Denied: Administrator permission (CanManageUsers = 1) is required to edit users.', 1;

    IF NOT EXISTS (SELECT 1 FROM dbo.SystemUsers WHERE UserId = @TargetUserId)
        THROW 50037, 'Target operator account does not exist.', 1;

    DECLARE @ResolvedGroupId INT = @GroupId;
    IF @ResolvedGroupId IS NULL OR NOT EXISTS (SELECT 1 FROM dbo.UserGroups WHERE GroupId = @ResolvedGroupId)
    BEGIN
        SELECT TOP (1) @ResolvedGroupId = ug.GroupId
        FROM dbo.UserGroups AS ug
        WHERE ug.GroupCode = CASE
            WHEN UPPER(ISNULL(@AccessRole, '')) IN ('ADMIN') THEN 'ADMIN'
            WHEN UPPER(ISNULL(@AccessRole, '')) IN ('FLEETMANAGER', 'FLEET_MANAGER') THEN 'FLEET_MANAGER'
            WHEN UPPER(ISNULL(@AccessRole, '')) IN ('UNDERWRITER') THEN 'UNDERWRITER'
            ELSE UPPER(ISNULL(@AccessRole, ''))
        END;
    END;
    IF @ResolvedGroupId IS NULL
        SELECT @ResolvedGroupId = GroupId FROM dbo.SystemUsers WHERE UserId = @TargetUserId;

    DECLARE @TargetGroupCanManageUsers BIT = 0;
    SELECT @TargetGroupCanManageUsers = CanManageUsers FROM dbo.UserGroups WHERE GroupId = @ResolvedGroupId;

    IF @TargetUserId = @CurrentUserId AND (@IsActive = 0 OR ISNULL(@TargetGroupCanManageUsers, 0) = 0)
        THROW 50033, 'Safety Lockout Guard: You cannot deactivate or move your own signed-in account out of an Administrator group.', 1;

    BEGIN TRY
        BEGIN TRANSACTION;

        UPDATE dbo.SystemUsers
        SET FullName     = LTRIM(RTRIM(@FullName)),
            RoleTitle    = LTRIM(RTRIM(@RoleTitle)),
            Department   = LTRIM(RTRIM(@Department)),
            StationCode  = UPPER(LTRIM(RTRIM(@StationCode))),
            GroupId      = @ResolvedGroupId,
            IsActive     = @IsActive,
            PasswordHash = COALESCE(@NewPasswordHash, PasswordHash)
        WHERE UserId = @TargetUserId;

        COMMIT TRANSACTION;

        SELECT
            u.UserId, u.Username, u.FullName, u.RoleTitle, u.Department, u.StationCode,
            ug.GroupCode AS AccessRole, u.IsActive,
            ug.CanDispatch, ug.CanManageFleet, ug.CanManagePolicies, ug.CanManageBilling, ug.CanManageUsers,
            u.GroupId, ug.GroupName
        FROM dbo.SystemUsers AS u
        INNER JOIN dbo.UserGroups AS ug ON u.GroupId = ug.GroupId
        WHERE u.UserId = @TargetUserId;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;
        THROW;
    END CATCH;
END;
GO

CREATE OR ALTER PROCEDURE dbo.usp_AdminDeleteSystemUser
    @TargetUserId INT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @CurrentUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @CurrentUserId IS NULL
        THROW 50031, 'Security Context Violation: Authenticated dispatcher SESSION_CONTEXT(AppUserId) is required.', 1;

    DECLARE @IsAdmin BIT = 0;
    SELECT @IsAdmin = ug.CanManageUsers
    FROM dbo.SystemUsers AS u
    INNER JOIN dbo.UserGroups AS ug ON u.GroupId = ug.GroupId
    WHERE u.UserId = @CurrentUserId AND u.IsActive = 1;

    IF ISNULL(@IsAdmin, 0) = 0
        THROW 50032, 'Access Denied: Administrator permission (CanManageUsers = 1) is required to delete users.', 1;

    IF @TargetUserId = @CurrentUserId
        THROW 50034, 'Safety Lockout Guard: You cannot delete your own currently signed-in Administrator account.', 1;

    DECLARE @TargetUsername VARCHAR(60);
    SELECT @TargetUsername = Username FROM dbo.SystemUsers WHERE UserId = @TargetUserId;
    IF @TargetUsername IS NULL
        THROW 50037, 'Target operator account does not exist.', 1;

    BEGIN TRY
        BEGIN TRANSACTION;

        DECLARE @DeletionMode VARCHAR(40);

        IF EXISTS (SELECT 1 FROM dbo.TowRequests WHERE CreatedByUserId = @TargetUserId)
           OR EXISTS (SELECT 1 FROM dbo.AuditChangeEvents WHERE ChangedByUserId = @TargetUserId)
        BEGIN
            UPDATE dbo.SystemUsers
            SET IsActive = 0
            WHERE UserId = @TargetUserId;

            SET @DeletionMode = 'DeactivatedForAuditIntegrity';
        END
        ELSE
        BEGIN
            UPDATE dbo.InvoicePayments SET RecordedByUserId = NULL WHERE RecordedByUserId = @TargetUserId;
            UPDATE dbo.TowAuditLogs SET DispatcherUserId = NULL WHERE DispatcherUserId = @TargetUserId;

            DELETE FROM dbo.SystemUsers WHERE UserId = @TargetUserId;
            SET @DeletionMode = 'HardDeleted';
        END;

        COMMIT TRANSACTION;

        SELECT
            @TargetUserId AS TargetUserId,
            @TargetUsername AS TargetUsername,
            @DeletionMode AS DeletionMode;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;
        THROW;
    END CATCH;
END;
GO

/*==============================================================================
  5N. NORMALIZED 3NF SYSTEM-WIDE ENTITY CHANGE LOG TRIGGERS & QUERY PROCEDURE
  Captures WHO changed WHAT (atomic FieldName, OldValue, NewValue) and WHEN
  via SQL Server SESSION_CONTEXT(N'AppUserId') across Configuration & CAD tables.
==============================================================================*/

-- 0. Trigger on dbo.UserGroups (Normalized Group Permission Matrix Changes)
CREATE OR ALTER TRIGGER dbo.trg_Audit_UserGroups
ON dbo.UserGroups
AFTER INSERT, UPDATE, DELETE
AS
BEGIN
    IF @@ROWCOUNT = 0 RETURN;
    SET NOCOUNT ON;
    DECLARE @ActorId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @ActorId IS NULL RETURN;

    DECLARE @EvtMap TABLE (ChangeEventId BIGINT, EntityId BIGINT);

    IF EXISTS (SELECT 1 FROM inserted) AND NOT EXISTS (SELECT 1 FROM deleted)
    BEGIN
        MERGE INTO dbo.AuditChangeEvents AS tgt
        USING (SELECT GroupId, GroupCode FROM inserted) AS src
        ON 1 = 0
        WHEN NOT MATCHED THEN
            INSERT (EntityType, EntityId, EntityCode, OperationType, ChangedByUserId)
            VALUES ('UserGroups', src.GroupId, src.GroupCode, 'CREATE', @ActorId)
        OUTPUT inserted.ChangeEventId, src.GroupId INTO @EvtMap (ChangeEventId, EntityId);

        INSERT INTO dbo.AuditChangeDetails (ChangeEventId, FieldName, OldValue, NewValue)
        SELECT m.ChangeEventId, v.FieldName, NULL, v.NewVal
        FROM inserted AS i
        INNER JOIN @EvtMap AS m ON m.EntityId = i.GroupId
        CROSS APPLY (VALUES
            ('GroupCode',         CAST(i.GroupCode AS NVARCHAR(400))),
            ('GroupName',         i.GroupName),
            ('CanDispatch',       CASE WHEN i.CanDispatch = 1 THEN N'true' ELSE N'false' END),
            ('CanManageFleet',    CASE WHEN i.CanManageFleet = 1 THEN N'true' ELSE N'false' END),
            ('CanManagePolicies', CASE WHEN i.CanManagePolicies = 1 THEN N'true' ELSE N'false' END),
            ('CanManageBilling',  CASE WHEN i.CanManageBilling = 1 THEN N'true' ELSE N'false' END),
            ('CanManageUsers',    CASE WHEN i.CanManageUsers = 1 THEN N'true' ELSE N'false' END)
        ) AS v(FieldName, NewVal);
    END
    ELSE IF EXISTS (SELECT 1 FROM deleted) AND NOT EXISTS (SELECT 1 FROM inserted)
    BEGIN
        MERGE INTO dbo.AuditChangeEvents AS tgt
        USING (SELECT GroupId, GroupCode FROM deleted) AS src
        ON 1 = 0
        WHEN NOT MATCHED THEN
            INSERT (EntityType, EntityId, EntityCode, OperationType, ChangedByUserId)
            VALUES ('UserGroups', src.GroupId, src.GroupCode, 'DELETE', @ActorId)
        OUTPUT inserted.ChangeEventId, src.GroupId INTO @EvtMap (ChangeEventId, EntityId);

        INSERT INTO dbo.AuditChangeDetails (ChangeEventId, FieldName, OldValue, NewValue)
        SELECT m.ChangeEventId, v.FieldName, v.OldVal, NULL
        FROM deleted AS d
        INNER JOIN @EvtMap AS m ON m.EntityId = d.GroupId
        CROSS APPLY (VALUES
            ('GroupCode', CAST(d.GroupCode AS NVARCHAR(400))),
            ('GroupName', d.GroupName)
        ) AS v(FieldName, OldVal);
    END
    ELSE IF EXISTS (SELECT 1 FROM inserted) AND EXISTS (SELECT 1 FROM deleted)
    BEGIN
        DECLARE @Diffs TABLE (
            EntityId BIGINT, EntityCode VARCHAR(100),
            FieldName VARCHAR(64), OldVal NVARCHAR(400), NewVal NVARCHAR(400)
        );

        INSERT INTO @Diffs (EntityId, EntityCode, FieldName, OldVal, NewVal)
        SELECT i.GroupId, i.GroupCode, v.FieldName, v.OldVal, v.NewVal
        FROM inserted AS i
        INNER JOIN deleted AS d ON i.GroupId = d.GroupId
        CROSS APPLY (VALUES
            ('GroupCode',         CAST(d.GroupCode AS NVARCHAR(400)),                 CAST(i.GroupCode AS NVARCHAR(400))),
            ('GroupName',         d.GroupName,                                        i.GroupName),
            ('Description',       d.Description,                                      i.Description),
            ('CanDispatch',       CASE WHEN d.CanDispatch = 1 THEN N'true' ELSE N'false' END,       CASE WHEN i.CanDispatch = 1 THEN N'true' ELSE N'false' END),
            ('CanManageFleet',    CASE WHEN d.CanManageFleet = 1 THEN N'true' ELSE N'false' END,    CASE WHEN i.CanManageFleet = 1 THEN N'true' ELSE N'false' END),
            ('CanManagePolicies', CASE WHEN d.CanManagePolicies = 1 THEN N'true' ELSE N'false' END, CASE WHEN i.CanManagePolicies = 1 THEN N'true' ELSE N'false' END),
            ('CanManageBilling',  CASE WHEN d.CanManageBilling = 1 THEN N'true' ELSE N'false' END,  CASE WHEN i.CanManageBilling = 1 THEN N'true' ELSE N'false' END),
            ('CanManageUsers',    CASE WHEN d.CanManageUsers = 1 THEN N'true' ELSE N'false' END,    CASE WHEN i.CanManageUsers = 1 THEN N'true' ELSE N'false' END)
        ) AS v(FieldName, OldVal, NewVal)
        WHERE ISNULL(v.OldVal, N'<<NULL>>') <> ISNULL(v.NewVal, N'<<NULL>>');

        IF NOT EXISTS (SELECT 1 FROM @Diffs) RETURN;

        MERGE INTO dbo.AuditChangeEvents AS tgt
        USING (SELECT DISTINCT EntityId, EntityCode FROM @Diffs) AS src
        ON 1 = 0
        WHEN NOT MATCHED THEN
            INSERT (EntityType, EntityId, EntityCode, OperationType, ChangedByUserId)
            VALUES ('UserGroups', src.EntityId, src.EntityCode, 'UPDATE', @ActorId)
        OUTPUT inserted.ChangeEventId, src.EntityId INTO @EvtMap (ChangeEventId, EntityId);

        INSERT INTO dbo.AuditChangeDetails (ChangeEventId, FieldName, OldValue, NewValue)
        SELECT m.ChangeEventId, dr.FieldName, dr.OldVal, dr.NewVal
        FROM @Diffs AS dr
        INNER JOIN @EvtMap AS m ON m.EntityId = dr.EntityId;
    END;
END;
GO

-- 1. Trigger on dbo.SystemUsers (Tracks UserGroup assignment changes; masks BCrypt hashes)
CREATE OR ALTER TRIGGER dbo.trg_Audit_SystemUsers
ON dbo.SystemUsers
AFTER INSERT, UPDATE, DELETE
AS
BEGIN
    IF @@ROWCOUNT = 0 RETURN;
    SET NOCOUNT ON;
    DECLARE @ActorId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @ActorId IS NULL RETURN;

    DECLARE @EvtMap TABLE (ChangeEventId BIGINT, EntityId BIGINT);

    IF EXISTS (SELECT 1 FROM inserted) AND NOT EXISTS (SELECT 1 FROM deleted)
    BEGIN
        MERGE INTO dbo.AuditChangeEvents AS tgt
        USING (SELECT UserId, Username FROM inserted) AS src
        ON 1 = 0
        WHEN NOT MATCHED THEN
            INSERT (EntityType, EntityId, EntityCode, OperationType, ChangedByUserId)
            VALUES ('SystemUsers', src.UserId, src.Username, 'CREATE', @ActorId)
        OUTPUT inserted.ChangeEventId, src.UserId INTO @EvtMap (ChangeEventId, EntityId);

        INSERT INTO dbo.AuditChangeDetails (ChangeEventId, FieldName, OldValue, NewValue)
        SELECT m.ChangeEventId, v.FieldName, NULL, v.NewVal
        FROM inserted AS i
        INNER JOIN dbo.UserGroups AS ug ON i.GroupId = ug.GroupId
        INNER JOIN @EvtMap AS m ON m.EntityId = i.UserId
        CROSS APPLY (VALUES
            ('Username',     CAST(i.Username AS NVARCHAR(400))),
            ('FullName',     i.FullName),
            ('UserGroup',    CONCAT(ug.GroupName, N' (', ug.GroupCode, N')')),
            ('StationCode',  CAST(i.StationCode AS NVARCHAR(400))),
            ('IsActive',     CASE WHEN i.IsActive = 1 THEN N'true' ELSE N'false' END),
            ('PasswordHash', N'[BCrypt Cost=12 Provisioned]')
        ) AS v(FieldName, NewVal);
    END
    ELSE IF EXISTS (SELECT 1 FROM deleted) AND NOT EXISTS (SELECT 1 FROM inserted)
    BEGIN
        MERGE INTO dbo.AuditChangeEvents AS tgt
        USING (SELECT UserId, Username FROM deleted) AS src
        ON 1 = 0
        WHEN NOT MATCHED THEN
            INSERT (EntityType, EntityId, EntityCode, OperationType, ChangedByUserId)
            VALUES ('SystemUsers', src.UserId, src.Username, 'DELETE', @ActorId)
        OUTPUT inserted.ChangeEventId, src.UserId INTO @EvtMap (ChangeEventId, EntityId);

        INSERT INTO dbo.AuditChangeDetails (ChangeEventId, FieldName, OldValue, NewValue)
        SELECT m.ChangeEventId, v.FieldName, v.OldVal, NULL
        FROM deleted AS d
        LEFT JOIN dbo.UserGroups AS ug ON d.GroupId = ug.GroupId
        INNER JOIN @EvtMap AS m ON m.EntityId = d.UserId
        CROSS APPLY (VALUES
            ('Username',  CAST(d.Username AS NVARCHAR(400))),
            ('FullName',  d.FullName),
            ('UserGroup', CONCAT(ISNULL(ug.GroupName, N'Group'), N' (', ISNULL(ug.GroupCode, ''), N')'))
        ) AS v(FieldName, OldVal);
    END
    ELSE IF EXISTS (SELECT 1 FROM inserted) AND EXISTS (SELECT 1 FROM deleted)
    BEGIN
        DECLARE @Diffs TABLE (
            EntityId BIGINT, EntityCode VARCHAR(100),
            FieldName VARCHAR(64), OldVal NVARCHAR(400), NewVal NVARCHAR(400)
        );

        INSERT INTO @Diffs (EntityId, EntityCode, FieldName, OldVal, NewVal)
        SELECT i.UserId, i.Username, v.FieldName, v.OldVal, v.NewVal
        FROM inserted AS i
        INNER JOIN deleted AS d ON i.UserId = d.UserId
        INNER JOIN dbo.UserGroups AS ugNew ON i.GroupId = ugNew.GroupId
        INNER JOIN dbo.UserGroups AS ugOld ON d.GroupId = ugOld.GroupId
        CROSS APPLY (VALUES
            ('FullName',    d.FullName,                                           i.FullName),
            ('RoleTitle',   d.RoleTitle,                                          i.RoleTitle),
            ('Department',  d.Department,                                         i.Department),
            ('StationCode', CAST(d.StationCode AS NVARCHAR(400)),                 CAST(i.StationCode AS NVARCHAR(400))),
            ('UserGroup',   CONCAT(ugOld.GroupName, N' (', ugOld.GroupCode, N')'), CONCAT(ugNew.GroupName, N' (', ugNew.GroupCode, N')')),
            ('IsActive',    CASE WHEN d.IsActive = 1 THEN N'true' ELSE N'false' END, CASE WHEN i.IsActive = 1 THEN N'true' ELSE N'false' END),
            ('PasswordHash',
                CASE WHEN d.PasswordHash <> i.PasswordHash THEN N'[Previous BCrypt Hash]' ELSE N'[Unchanged]' END,
                CASE WHEN d.PasswordHash <> i.PasswordHash THEN N'[Rotated BCrypt Cost=12 Hash]' ELSE N'[Unchanged]' END)
        ) AS v(FieldName, OldVal, NewVal)
        WHERE ISNULL(v.OldVal, N'<<NULL>>') <> ISNULL(v.NewVal, N'<<NULL>>');

        IF NOT EXISTS (SELECT 1 FROM @Diffs) RETURN;

        MERGE INTO dbo.AuditChangeEvents AS tgt
        USING (SELECT DISTINCT EntityId, EntityCode FROM @Diffs) AS src
        ON 1 = 0
        WHEN NOT MATCHED THEN
            INSERT (EntityType, EntityId, EntityCode, OperationType, ChangedByUserId)
            VALUES ('SystemUsers', src.EntityId, src.EntityCode, 'UPDATE', @ActorId)
        OUTPUT inserted.ChangeEventId, src.EntityId INTO @EvtMap (ChangeEventId, EntityId);

        INSERT INTO dbo.AuditChangeDetails (ChangeEventId, FieldName, OldValue, NewValue)
        SELECT m.ChangeEventId, dr.FieldName, dr.OldVal, dr.NewVal
        FROM @Diffs AS dr
        INNER JOIN @EvtMap AS m ON m.EntityId = dr.EntityId;
    END;
END;
GO

-- 2. Trigger on dbo.TowTrucks
CREATE OR ALTER TRIGGER dbo.trg_Audit_TowTrucks
ON dbo.TowTrucks
AFTER INSERT, UPDATE, DELETE
AS
BEGIN
    IF @@ROWCOUNT = 0 RETURN;
    SET NOCOUNT ON;
    DECLARE @ActorId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @ActorId IS NULL RETURN;

    DECLARE @EvtMap TABLE (ChangeEventId BIGINT, EntityId BIGINT);

    IF EXISTS (SELECT 1 FROM inserted) AND NOT EXISTS (SELECT 1 FROM deleted)
    BEGIN
        MERGE INTO dbo.AuditChangeEvents AS tgt
        USING (SELECT TruckId, TruckCode FROM inserted) AS src
        ON 1 = 0
        WHEN NOT MATCHED THEN
            INSERT (EntityType, EntityId, EntityCode, OperationType, ChangedByUserId)
            VALUES ('TowTrucks', src.TruckId, src.TruckCode, 'CREATE', @ActorId)
        OUTPUT inserted.ChangeEventId, src.TruckId INTO @EvtMap (ChangeEventId, EntityId);

        INSERT INTO dbo.AuditChangeDetails (ChangeEventId, FieldName, OldValue, NewValue)
        SELECT m.ChangeEventId, v.FieldName, NULL, v.NewVal
        FROM inserted AS i
        INNER JOIN @EvtMap AS m ON m.EntityId = i.TruckId
        CROSS APPLY (VALUES
            ('TruckCode',    CAST(i.TruckCode AS NVARCHAR(400))),
            ('LicensePlate', CAST(i.LicensePlate AS NVARCHAR(400))),
            ('TruckModel',   i.TruckModel),
            ('MaxPayloadKg', CAST(i.MaxPayloadKg AS NVARCHAR(400))),
            ('FleetStatus',  CAST(i.FleetStatus AS NVARCHAR(400)))
        ) AS v(FieldName, NewVal);
    END
    ELSE IF EXISTS (SELECT 1 FROM inserted) AND EXISTS (SELECT 1 FROM deleted)
    BEGIN
        DECLARE @Diffs TABLE (
            EntityId BIGINT, EntityCode VARCHAR(100),
            FieldName VARCHAR(64), OldVal NVARCHAR(400), NewVal NVARCHAR(400)
        );

        INSERT INTO @Diffs (EntityId, EntityCode, FieldName, OldVal, NewVal)
        SELECT i.TruckId, i.TruckCode, v.FieldName, v.OldVal, v.NewVal
        FROM inserted AS i
        INNER JOIN deleted AS d ON i.TruckId = d.TruckId
        CROSS APPLY (VALUES
            ('TruckCode',    CAST(d.TruckCode AS NVARCHAR(400)),    CAST(i.TruckCode AS NVARCHAR(400))),
            ('LicensePlate', CAST(d.LicensePlate AS NVARCHAR(400)), CAST(i.LicensePlate AS NVARCHAR(400))),
            ('TruckModel',   d.TruckModel,                          i.TruckModel),
            ('MaxPayloadKg', CAST(d.MaxPayloadKg AS NVARCHAR(400)), CAST(i.MaxPayloadKg AS NVARCHAR(400))),
            ('FleetStatus',  CAST(d.FleetStatus AS NVARCHAR(400)),  CAST(i.FleetStatus AS NVARCHAR(400))),
            ('GPSCoords',
                CONCAT(CAST(d.CurrentLat AS VARCHAR(20)), ', ', CAST(d.CurrentLng AS VARCHAR(20))),
                CONCAT(CAST(i.CurrentLat AS VARCHAR(20)), ', ', CAST(i.CurrentLng AS VARCHAR(20))))
        ) AS v(FieldName, OldVal, NewVal)
        WHERE ISNULL(v.OldVal, N'<<NULL>>') <> ISNULL(v.NewVal, N'<<NULL>>');

        IF NOT EXISTS (SELECT 1 FROM @Diffs) RETURN;

        MERGE INTO dbo.AuditChangeEvents AS tgt
        USING (SELECT DISTINCT EntityId, EntityCode FROM @Diffs) AS src
        ON 1 = 0
        WHEN NOT MATCHED THEN
            INSERT (EntityType, EntityId, EntityCode, OperationType, ChangedByUserId)
            VALUES ('TowTrucks', src.EntityId, src.EntityCode, 'UPDATE', @ActorId)
        OUTPUT inserted.ChangeEventId, src.EntityId INTO @EvtMap (ChangeEventId, EntityId);

        INSERT INTO dbo.AuditChangeDetails (ChangeEventId, FieldName, OldValue, NewValue)
        SELECT m.ChangeEventId, dr.FieldName, dr.OldVal, dr.NewVal
        FROM @Diffs AS dr
        INNER JOIN @EvtMap AS m ON m.EntityId = dr.EntityId;
    END;
END;
GO

-- 3. Trigger on dbo.Drivers
CREATE OR ALTER TRIGGER dbo.trg_Audit_Drivers
ON dbo.Drivers
AFTER INSERT, UPDATE, DELETE
AS
BEGIN
    IF @@ROWCOUNT = 0 RETURN;
    SET NOCOUNT ON;
    DECLARE @ActorId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @ActorId IS NULL RETURN;

    DECLARE @EvtMap TABLE (ChangeEventId BIGINT, EntityId BIGINT);

    IF EXISTS (SELECT 1 FROM inserted) AND NOT EXISTS (SELECT 1 FROM deleted)
    BEGIN
        MERGE INTO dbo.AuditChangeEvents AS tgt
        USING (SELECT DriverId, EmployeeCode FROM inserted) AS src
        ON 1 = 0
        WHEN NOT MATCHED THEN
            INSERT (EntityType, EntityId, EntityCode, OperationType, ChangedByUserId)
            VALUES ('Drivers', src.DriverId, src.EmployeeCode, 'CREATE', @ActorId)
        OUTPUT inserted.ChangeEventId, src.DriverId INTO @EvtMap (ChangeEventId, EntityId);

        INSERT INTO dbo.AuditChangeDetails (ChangeEventId, FieldName, OldValue, NewValue)
        SELECT m.ChangeEventId, v.FieldName, NULL, v.NewVal
        FROM inserted AS i
        INNER JOIN @EvtMap AS m ON m.EntityId = i.DriverId
        CROSS APPLY (VALUES
            ('EmployeeCode',       CAST(i.EmployeeCode AS NVARCHAR(400))),
            ('FullName',           i.FullName),
            ('Phone',              CAST(i.Phone AS NVARCHAR(400))),
            ('LicenseNumber',      CAST(i.LicenseNumber AS NVARCHAR(400))),
            ('BaseMonthlySalary',  CAST(i.BaseMonthlySalary AS NVARCHAR(400))),
            ('OvertimeRatePerTow', CAST(i.OvertimeRatePerTow AS NVARCHAR(400))),
            ('IsWorkingOffDay',    CASE WHEN i.IsWorkingOffDay = 1 THEN N'true' ELSE N'false' END),
            ('DriverStatus',       CAST(i.DriverStatus AS NVARCHAR(400)))
        ) AS v(FieldName, NewVal);
    END
    ELSE IF EXISTS (SELECT 1 FROM inserted) AND EXISTS (SELECT 1 FROM deleted)
    BEGIN
        DECLARE @Diffs TABLE (
            EntityId BIGINT, EntityCode VARCHAR(100),
            FieldName VARCHAR(64), OldVal NVARCHAR(400), NewVal NVARCHAR(400)
        );

        INSERT INTO @Diffs (EntityId, EntityCode, FieldName, OldVal, NewVal)
        SELECT i.DriverId, i.EmployeeCode, v.FieldName, v.OldVal, v.NewVal
        FROM inserted AS i
        INNER JOIN deleted AS d ON i.DriverId = d.DriverId
        CROSS APPLY (VALUES
            ('FullName',           d.FullName,                              i.FullName),
            ('Phone',              CAST(d.Phone AS NVARCHAR(400)),          CAST(i.Phone AS NVARCHAR(400))),
            ('LicenseNumber',      CAST(d.LicenseNumber AS NVARCHAR(400)),  CAST(i.LicenseNumber AS NVARCHAR(400))),
            ('BaseMonthlySalary',  CAST(d.BaseMonthlySalary AS NVARCHAR(400)),  CAST(i.BaseMonthlySalary AS NVARCHAR(400))),
            ('OvertimeRatePerTow', CAST(d.OvertimeRatePerTow AS NVARCHAR(400)), CAST(i.OvertimeRatePerTow AS NVARCHAR(400))),
            ('IsWorkingOffDay',    CASE WHEN d.IsWorkingOffDay = 1 THEN N'true' ELSE N'false' END, CASE WHEN i.IsWorkingOffDay = 1 THEN N'true' ELSE N'false' END),
            ('DriverStatus',       CAST(d.DriverStatus AS NVARCHAR(400)),   CAST(i.DriverStatus AS NVARCHAR(400)))
        ) AS v(FieldName, OldVal, NewVal)
        WHERE ISNULL(v.OldVal, N'<<NULL>>') <> ISNULL(v.NewVal, N'<<NULL>>');

        IF NOT EXISTS (SELECT 1 FROM @Diffs) RETURN;

        MERGE INTO dbo.AuditChangeEvents AS tgt
        USING (SELECT DISTINCT EntityId, EntityCode FROM @Diffs) AS src
        ON 1 = 0
        WHEN NOT MATCHED THEN
            INSERT (EntityType, EntityId, EntityCode, OperationType, ChangedByUserId)
            VALUES ('Drivers', src.EntityId, src.EntityCode, 'UPDATE', @ActorId)
        OUTPUT inserted.ChangeEventId, src.EntityId INTO @EvtMap (ChangeEventId, EntityId);

        INSERT INTO dbo.AuditChangeDetails (ChangeEventId, FieldName, OldValue, NewValue)
        SELECT m.ChangeEventId, dr.FieldName, dr.OldVal, dr.NewVal
        FROM @Diffs AS dr
        INNER JOIN @EvtMap AS m ON m.EntityId = dr.EntityId;
    END;
END;
GO

-- 4. Trigger on dbo.DriverTruckAssignments
CREATE OR ALTER TRIGGER dbo.trg_Audit_DriverTruckAssignments
ON dbo.DriverTruckAssignments
AFTER INSERT, UPDATE
AS
BEGIN
    IF @@ROWCOUNT = 0 RETURN;
    SET NOCOUNT ON;
    DECLARE @ActorId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @ActorId IS NULL RETURN;

    DECLARE @EvtMap TABLE (ChangeEventId BIGINT, EntityId BIGINT);

    IF EXISTS (SELECT 1 FROM inserted) AND NOT EXISTS (SELECT 1 FROM deleted)
    BEGIN
        MERGE INTO dbo.AuditChangeEvents AS tgt
        USING (
            SELECT i.AssignmentId, CONCAT(drv.EmployeeCode, ' -> ', trk.TruckCode) AS AssignCode
            FROM inserted AS i
            INNER JOIN dbo.Drivers AS drv ON i.DriverId = drv.DriverId
            INNER JOIN dbo.TowTrucks AS trk ON i.TruckId = trk.TruckId
        ) AS src
        ON 1 = 0
        WHEN NOT MATCHED THEN
            INSERT (EntityType, EntityId, EntityCode, OperationType, ChangedByUserId)
            VALUES ('DriverTruckAssignments', src.AssignmentId, src.AssignCode, 'CREATE', @ActorId)
        OUTPUT inserted.ChangeEventId, src.AssignmentId INTO @EvtMap (ChangeEventId, EntityId);

        INSERT INTO dbo.AuditChangeDetails (ChangeEventId, FieldName, OldValue, NewValue)
        SELECT m.ChangeEventId, v.FieldName, NULL, v.NewVal
        FROM inserted AS i
        INNER JOIN dbo.Drivers AS drv ON i.DriverId = drv.DriverId
        INNER JOIN dbo.TowTrucks AS trk ON i.TruckId = trk.TruckId
        INNER JOIN @EvtMap AS m ON m.EntityId = i.AssignmentId
        CROSS APPLY (VALUES
            ('Driver',          CONCAT(drv.FullName, N' (', drv.EmployeeCode, N')')),
            ('TowTruck',        CONCAT(trk.TruckCode, N' (', trk.LicensePlate, N')')),
            ('StartDate',       CONVERT(NVARCHAR(30), i.StartDate, 120)),
            ('AssignmentNotes', i.AssignmentNotes)
        ) AS v(FieldName, NewVal)
        WHERE v.NewVal IS NOT NULL;
    END
    ELSE IF EXISTS (SELECT 1 FROM inserted) AND EXISTS (SELECT 1 FROM deleted)
    BEGIN
        DECLARE @Diffs TABLE (
            EntityId BIGINT, EntityCode VARCHAR(100),
            FieldName VARCHAR(64), OldVal NVARCHAR(400), NewVal NVARCHAR(400)
        );

        INSERT INTO @Diffs (EntityId, EntityCode, FieldName, OldVal, NewVal)
        SELECT
            i.AssignmentId,
            CONCAT(drv.EmployeeCode, ' -> ', trk.TruckCode),
            v.FieldName, v.OldVal, v.NewVal
        FROM inserted AS i
        INNER JOIN deleted AS d ON i.AssignmentId = d.AssignmentId
        INNER JOIN dbo.Drivers AS drv ON i.DriverId = drv.DriverId
        INNER JOIN dbo.TowTrucks AS trk ON i.TruckId = trk.TruckId
        CROSS APPLY (VALUES
            ('EndDate',
                ISNULL(CONVERT(NVARCHAR(30), d.EndDate, 120), N'Active (NULL)'),
                ISNULL(CONVERT(NVARCHAR(30), i.EndDate, 120), N'Active (NULL)')),
            ('AssignmentNotes', d.AssignmentNotes, i.AssignmentNotes)
        ) AS v(FieldName, OldVal, NewVal)
        WHERE ISNULL(v.OldVal, N'<<NULL>>') <> ISNULL(v.NewVal, N'<<NULL>>');

        IF NOT EXISTS (SELECT 1 FROM @Diffs) RETURN;

        MERGE INTO dbo.AuditChangeEvents AS tgt
        USING (SELECT DISTINCT EntityId, EntityCode FROM @Diffs) AS src
        ON 1 = 0
        WHEN NOT MATCHED THEN
            INSERT (EntityType, EntityId, EntityCode, OperationType, ChangedByUserId)
            VALUES ('DriverTruckAssignments', src.EntityId, src.EntityCode, 'UPDATE', @ActorId)
        OUTPUT inserted.ChangeEventId, src.EntityId INTO @EvtMap (ChangeEventId, EntityId);

        INSERT INTO dbo.AuditChangeDetails (ChangeEventId, FieldName, OldValue, NewValue)
        SELECT m.ChangeEventId, dr.FieldName, dr.OldVal, dr.NewVal
        FROM @Diffs AS dr
        INNER JOIN @EvtMap AS m ON m.EntityId = dr.EntityId;
    END;
END;
GO

-- 5. Trigger on dbo.Customers
CREATE OR ALTER TRIGGER dbo.trg_Audit_Customers
ON dbo.Customers
AFTER INSERT, UPDATE
AS
BEGIN
    IF @@ROWCOUNT = 0 RETURN;
    SET NOCOUNT ON;
    DECLARE @ActorId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @ActorId IS NULL RETURN;

    DECLARE @EvtMap TABLE (ChangeEventId BIGINT, EntityId BIGINT);

    IF EXISTS (SELECT 1 FROM inserted) AND NOT EXISTS (SELECT 1 FROM deleted)
    BEGIN
        MERGE INTO dbo.AuditChangeEvents AS tgt
        USING (SELECT CustomerId, Phone FROM inserted) AS src
        ON 1 = 0
        WHEN NOT MATCHED THEN
            INSERT (EntityType, EntityId, EntityCode, OperationType, ChangedByUserId)
            VALUES ('Customers', src.CustomerId, src.Phone, 'CREATE', @ActorId)
        OUTPUT inserted.ChangeEventId, src.CustomerId INTO @EvtMap (ChangeEventId, EntityId);

        INSERT INTO dbo.AuditChangeDetails (ChangeEventId, FieldName, OldValue, NewValue)
        SELECT m.ChangeEventId, v.FieldName, NULL, v.NewVal
        FROM inserted AS i
        INNER JOIN @EvtMap AS m ON m.EntityId = i.CustomerId
        CROSS APPLY (VALUES
            ('FullName', i.FullName),
            ('Phone',    CAST(i.Phone AS NVARCHAR(400))),
            ('Email',    CAST(i.Email AS NVARCHAR(400)))
        ) AS v(FieldName, NewVal)
        WHERE v.NewVal IS NOT NULL;
    END
    ELSE IF EXISTS (SELECT 1 FROM inserted) AND EXISTS (SELECT 1 FROM deleted)
    BEGIN
        DECLARE @Diffs TABLE (
            EntityId BIGINT, EntityCode VARCHAR(100),
            FieldName VARCHAR(64), OldVal NVARCHAR(400), NewVal NVARCHAR(400)
        );

        INSERT INTO @Diffs (EntityId, EntityCode, FieldName, OldVal, NewVal)
        SELECT i.CustomerId, i.Phone, v.FieldName, v.OldVal, v.NewVal
        FROM inserted AS i
        INNER JOIN deleted AS d ON i.CustomerId = d.CustomerId
        CROSS APPLY (VALUES
            ('FullName', d.FullName,                      i.FullName),
            ('Phone',    CAST(d.Phone AS NVARCHAR(400)),  CAST(i.Phone AS NVARCHAR(400))),
            ('Email',    CAST(d.Email AS NVARCHAR(400)),  CAST(i.Email AS NVARCHAR(400)))
        ) AS v(FieldName, OldVal, NewVal)
        WHERE ISNULL(v.OldVal, N'<<NULL>>') <> ISNULL(v.NewVal, N'<<NULL>>');

        IF NOT EXISTS (SELECT 1 FROM @Diffs) RETURN;

        MERGE INTO dbo.AuditChangeEvents AS tgt
        USING (SELECT DISTINCT EntityId, EntityCode FROM @Diffs) AS src
        ON 1 = 0
        WHEN NOT MATCHED THEN
            INSERT (EntityType, EntityId, EntityCode, OperationType, ChangedByUserId)
            VALUES ('Customers', src.EntityId, src.EntityCode, 'UPDATE', @ActorId)
        OUTPUT inserted.ChangeEventId, src.EntityId INTO @EvtMap (ChangeEventId, EntityId);

        INSERT INTO dbo.AuditChangeDetails (ChangeEventId, FieldName, OldValue, NewValue)
        SELECT m.ChangeEventId, dr.FieldName, dr.OldVal, dr.NewVal
        FROM @Diffs AS dr
        INNER JOIN @EvtMap AS m ON m.EntityId = dr.EntityId;
    END;
END;
GO

-- 6. Trigger on dbo.InsurancePolicies & PolicyQuotaTiers
CREATE OR ALTER TRIGGER dbo.trg_Audit_InsurancePolicies
ON dbo.InsurancePolicies
AFTER INSERT, UPDATE
AS
BEGIN
    IF @@ROWCOUNT = 0 RETURN;
    SET NOCOUNT ON;
    DECLARE @ActorId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @ActorId IS NULL RETURN;

    DECLARE @EvtMap TABLE (ChangeEventId BIGINT, EntityId BIGINT);

    IF EXISTS (SELECT 1 FROM inserted) AND NOT EXISTS (SELECT 1 FROM deleted)
    BEGIN
        MERGE INTO dbo.AuditChangeEvents AS tgt
        USING (SELECT PolicyId, PolicyNumber FROM inserted) AS src
        ON 1 = 0
        WHEN NOT MATCHED THEN
            INSERT (EntityType, EntityId, EntityCode, OperationType, ChangedByUserId)
            VALUES ('InsurancePolicies', src.PolicyId, src.PolicyNumber, 'CREATE', @ActorId)
        OUTPUT inserted.ChangeEventId, src.PolicyId INTO @EvtMap (ChangeEventId, EntityId);

        INSERT INTO dbo.AuditChangeDetails (ChangeEventId, FieldName, OldValue, NewValue)
        SELECT m.ChangeEventId, v.FieldName, NULL, v.NewVal
        FROM inserted AS i
        INNER JOIN @EvtMap AS m ON m.EntityId = i.PolicyId
        CROSS APPLY (VALUES
            ('PolicyNumber',     CAST(i.PolicyNumber AS NVARCHAR(400))),
            ('DefaultAllowedKm', CAST(i.DefaultAllowedKm AS NVARCHAR(400))),
            ('ExpirationDate',   CONVERT(NVARCHAR(20), i.ExpirationDate, 23)),
            ('PolicyStatus',     CAST(i.PolicyStatus AS NVARCHAR(400)))
        ) AS v(FieldName, NewVal);
    END
    ELSE IF EXISTS (SELECT 1 FROM inserted) AND EXISTS (SELECT 1 FROM deleted)
    BEGIN
        DECLARE @Diffs TABLE (
            EntityId BIGINT, EntityCode VARCHAR(100),
            FieldName VARCHAR(64), OldVal NVARCHAR(400), NewVal NVARCHAR(400)
        );

        INSERT INTO @Diffs (EntityId, EntityCode, FieldName, OldVal, NewVal)
        SELECT i.PolicyId, i.PolicyNumber, v.FieldName, v.OldVal, v.NewVal
        FROM inserted AS i
        INNER JOIN deleted AS d ON i.PolicyId = d.PolicyId
        CROSS APPLY (VALUES
            ('PolicyStatus',     CAST(d.PolicyStatus AS NVARCHAR(400)),     CAST(i.PolicyStatus AS NVARCHAR(400))),
            ('DefaultAllowedKm', CAST(d.DefaultAllowedKm AS NVARCHAR(400)), CAST(i.DefaultAllowedKm AS NVARCHAR(400))),
            ('ExpirationDate',   CONVERT(NVARCHAR(20), d.ExpirationDate, 23), CONVERT(NVARCHAR(20), i.ExpirationDate, 23))
        ) AS v(FieldName, OldVal, NewVal)
        WHERE ISNULL(v.OldVal, N'<<NULL>>') <> ISNULL(v.NewVal, N'<<NULL>>');

        IF NOT EXISTS (SELECT 1 FROM @Diffs) RETURN;

        MERGE INTO dbo.AuditChangeEvents AS tgt
        USING (SELECT DISTINCT EntityId, EntityCode FROM @Diffs) AS src
        ON 1 = 0
        WHEN NOT MATCHED THEN
            INSERT (EntityType, EntityId, EntityCode, OperationType, ChangedByUserId)
            VALUES ('InsurancePolicies', src.EntityId, src.EntityCode, 'UPDATE', @ActorId)
        OUTPUT inserted.ChangeEventId, src.EntityId INTO @EvtMap (ChangeEventId, EntityId);

        INSERT INTO dbo.AuditChangeDetails (ChangeEventId, FieldName, OldValue, NewValue)
        SELECT m.ChangeEventId, dr.FieldName, dr.OldVal, dr.NewVal
        FROM @Diffs AS dr
        INNER JOIN @EvtMap AS m ON m.EntityId = dr.EntityId;
    END;
END;
GO

CREATE OR ALTER TRIGGER dbo.trg_Audit_PolicyQuotaTiers
ON dbo.PolicyQuotaTiers
AFTER INSERT, UPDATE
AS
BEGIN
    IF @@ROWCOUNT = 0 RETURN;
    SET NOCOUNT ON;
    DECLARE @ActorId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @ActorId IS NULL RETURN;

    DECLARE @EvtMap TABLE (ChangeEventId BIGINT, EntityId BIGINT);

    IF EXISTS (SELECT 1 FROM inserted) AND EXISTS (SELECT 1 FROM deleted)
    BEGIN
        DECLARE @Diffs TABLE (
            EntityId BIGINT, EntityCode VARCHAR(100),
            FieldName VARCHAR(64), OldVal NVARCHAR(400), NewVal NVARCHAR(400)
        );

        INSERT INTO @Diffs (EntityId, EntityCode, FieldName, OldVal, NewVal)
        SELECT i.QuotaTierId, CONCAT(p.PolicyNumber, ' [', i.CoverageType, ']'), v.FieldName, v.OldVal, v.NewVal
        FROM inserted AS i
        INNER JOIN deleted AS d ON i.QuotaTierId = d.QuotaTierId
        INNER JOIN dbo.InsurancePolicies AS p ON i.PolicyId = p.PolicyId
        CROSS APPLY (VALUES
            ('AllowedTows',     CAST(d.AllowedTows AS NVARCHAR(400)),     CAST(i.AllowedTows AS NVARCHAR(400))),
            ('UsedTows',        CAST(d.UsedTows AS NVARCHAR(400)),        CAST(i.UsedTows AS NVARCHAR(400))),
            ('MaxDistanceKm',   CAST(d.MaxDistanceKm AS NVARCHAR(400)),   CAST(i.MaxDistanceKm AS NVARCHAR(400))),
            ('MinIntervalDays', CAST(d.MinIntervalDays AS NVARCHAR(400)), CAST(i.MinIntervalDays AS NVARCHAR(400)))
        ) AS v(FieldName, OldVal, NewVal)
        WHERE ISNULL(v.OldVal, N'<<NULL>>') <> ISNULL(v.NewVal, N'<<NULL>>');

        IF NOT EXISTS (SELECT 1 FROM @Diffs) RETURN;

        MERGE INTO dbo.AuditChangeEvents AS tgt
        USING (SELECT DISTINCT EntityId, EntityCode FROM @Diffs) AS src
        ON 1 = 0
        WHEN NOT MATCHED THEN
            INSERT (EntityType, EntityId, EntityCode, OperationType, ChangedByUserId)
            VALUES ('PolicyQuotaTiers', src.EntityId, src.EntityCode, 'UPDATE', @ActorId)
        OUTPUT inserted.ChangeEventId, src.EntityId INTO @EvtMap (ChangeEventId, EntityId);

        INSERT INTO dbo.AuditChangeDetails (ChangeEventId, FieldName, OldValue, NewValue)
        SELECT m.ChangeEventId, dr.FieldName, dr.OldVal, dr.NewVal
        FROM @Diffs AS dr
        INNER JOIN @EvtMap AS m ON m.EntityId = dr.EntityId;
    END;
END;
GO

-- 7. Trigger on dbo.Tariffs
CREATE OR ALTER TRIGGER dbo.trg_Audit_Tariffs
ON dbo.Tariffs
AFTER INSERT, UPDATE
AS
BEGIN
    IF @@ROWCOUNT = 0 RETURN;
    SET NOCOUNT ON;
    DECLARE @ActorId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @ActorId IS NULL RETURN;

    DECLARE @EvtMap TABLE (ChangeEventId BIGINT, EntityId BIGINT);

    IF EXISTS (SELECT 1 FROM inserted) AND NOT EXISTS (SELECT 1 FROM deleted)
    BEGIN
        MERGE INTO dbo.AuditChangeEvents AS tgt
        USING (SELECT TariffId, TariffCode FROM inserted) AS src
        ON 1 = 0
        WHEN NOT MATCHED THEN
            INSERT (EntityType, EntityId, EntityCode, OperationType, ChangedByUserId)
            VALUES ('Tariffs', src.TariffId, src.TariffCode, 'CREATE', @ActorId)
        OUTPUT inserted.ChangeEventId, src.TariffId INTO @EvtMap (ChangeEventId, EntityId);

        INSERT INTO dbo.AuditChangeDetails (ChangeEventId, FieldName, OldValue, NewValue)
        SELECT m.ChangeEventId, v.FieldName, NULL, v.NewVal
        FROM inserted AS i
        INNER JOIN @EvtMap AS m ON m.EntityId = i.TariffId
        CROSS APPLY (VALUES
            ('TariffCode',      CAST(i.TariffCode AS NVARCHAR(400))),
            ('ServiceCategory', CAST(i.ServiceCategory AS NVARCHAR(400))),
            ('BaseFee',         CONCAT(N'$', CAST(i.BaseFee AS NVARCHAR(50)))),
            ('PricePerKm',      CONCAT(N'$', CAST(i.PricePerKm AS NVARCHAR(50)), N'/km')),
            ('NightSurcharge',  CONCAT(N'$', CAST(i.NightSurcharge AS NVARCHAR(50)))),
            ('EffectiveFrom',   CONVERT(NVARCHAR(20), i.EffectiveFrom, 23))
        ) AS v(FieldName, NewVal);
    END
    ELSE IF EXISTS (SELECT 1 FROM inserted) AND EXISTS (SELECT 1 FROM deleted)
    BEGIN
        DECLARE @Diffs TABLE (
            EntityId BIGINT, EntityCode VARCHAR(100),
            FieldName VARCHAR(64), OldVal NVARCHAR(400), NewVal NVARCHAR(400)
        );

        INSERT INTO @Diffs (EntityId, EntityCode, FieldName, OldVal, NewVal)
        SELECT i.TariffId, i.TariffCode, v.FieldName, v.OldVal, v.NewVal
        FROM inserted AS i
        INNER JOIN deleted AS d ON i.TariffId = d.TariffId
        CROSS APPLY (VALUES
            ('EffectiveTo', ISNULL(CONVERT(NVARCHAR(20), d.EffectiveTo, 23), N'Open'), ISNULL(CONVERT(NVARCHAR(20), i.EffectiveTo, 23), N'Open')),
            ('IsActive',    CASE WHEN d.IsActive = 1 THEN N'true' ELSE N'false' END,   CASE WHEN i.IsActive = 1 THEN N'true' ELSE N'false' END)
        ) AS v(FieldName, OldVal, NewVal)
        WHERE ISNULL(v.OldVal, N'<<NULL>>') <> ISNULL(v.NewVal, N'<<NULL>>');

        IF NOT EXISTS (SELECT 1 FROM @Diffs) RETURN;

        MERGE INTO dbo.AuditChangeEvents AS tgt
        USING (SELECT DISTINCT EntityId, EntityCode FROM @Diffs) AS src
        ON 1 = 0
        WHEN NOT MATCHED THEN
            INSERT (EntityType, EntityId, EntityCode, OperationType, ChangedByUserId)
            VALUES ('Tariffs', src.EntityId, src.EntityCode, 'UPDATE', @ActorId)
        OUTPUT inserted.ChangeEventId, src.EntityId INTO @EvtMap (ChangeEventId, EntityId);

        INSERT INTO dbo.AuditChangeDetails (ChangeEventId, FieldName, OldValue, NewValue)
        SELECT m.ChangeEventId, dr.FieldName, dr.OldVal, dr.NewVal
        FROM @Diffs AS dr
        INNER JOIN @EvtMap AS m ON m.EntityId = dr.EntityId;
    END;
END;
GO

-- 8. Trigger on dbo.TowRequests (Normalized Field-Level Change Diffs)
CREATE OR ALTER TRIGGER dbo.trg_Audit_TowRequests_Fields
ON dbo.TowRequests
AFTER INSERT, UPDATE
AS
BEGIN
    IF @@ROWCOUNT = 0 RETURN;
    SET NOCOUNT ON;
    DECLARE @ActorId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @ActorId IS NULL RETURN;

    DECLARE @EvtMap TABLE (ChangeEventId BIGINT, EntityId BIGINT);

    IF EXISTS (SELECT 1 FROM inserted) AND NOT EXISTS (SELECT 1 FROM deleted)
    BEGIN
        MERGE INTO dbo.AuditChangeEvents AS tgt
        USING (SELECT TowRequestId, RequestNumber FROM inserted) AS src
        ON 1 = 0
        WHEN NOT MATCHED THEN
            INSERT (EntityType, EntityId, EntityCode, OperationType, ChangedByUserId)
            VALUES ('TowRequests', src.TowRequestId, src.RequestNumber, 'CREATE', @ActorId)
        OUTPUT inserted.ChangeEventId, src.TowRequestId INTO @EvtMap (ChangeEventId, EntityId);

        INSERT INTO dbo.AuditChangeDetails (ChangeEventId, FieldName, OldValue, NewValue)
        SELECT m.ChangeEventId, v.FieldName, NULL, v.NewVal
        FROM inserted AS i
        INNER JOIN @EvtMap AS m ON m.EntityId = i.TowRequestId
        CROSS APPLY (VALUES
            ('RequestNumber',   CAST(i.RequestNumber AS NVARCHAR(400))),
            ('Status',          CAST(i.Status AS NVARCHAR(400))),
            ('IssueType',       CAST(i.IssueType AS NVARCHAR(400))),
            ('RouteDistanceKm', CONCAT(CAST(i.RouteDistanceKm AS NVARCHAR(50)), N' km (', i.DistanceSource, N')'))
        ) AS v(FieldName, NewVal);
    END
    ELSE IF EXISTS (SELECT 1 FROM inserted) AND EXISTS (SELECT 1 FROM deleted)
    BEGIN
        DECLARE @Diffs TABLE (
            EntityId BIGINT, EntityCode VARCHAR(100),
            FieldName VARCHAR(64), OldVal NVARCHAR(400), NewVal NVARCHAR(400)
        );

        INSERT INTO @Diffs (EntityId, EntityCode, FieldName, OldVal, NewVal)
        SELECT i.TowRequestId, i.RequestNumber, v.FieldName, v.OldVal, v.NewVal
        FROM inserted AS i
        INNER JOIN deleted AS d ON i.TowRequestId = d.TowRequestId
        CROSS APPLY (VALUES
            ('Status',                CAST(d.Status AS NVARCHAR(400)),                CAST(i.Status AS NVARCHAR(400))),
            ('AssignedTruckId',       ISNULL(CAST(d.AssignedTruckId AS NVARCHAR(40)), N'Unassigned'), ISNULL(CAST(i.AssignedTruckId AS NVARCHAR(40)), N'Unassigned')),
            ('AssignedDriverId',      ISNULL(CAST(d.AssignedDriverId AS NVARCHAR(40)), N'Unassigned'), ISNULL(CAST(i.AssignedDriverId AS NVARCHAR(40)), N'Unassigned')),
            ('TruckPrioritySequence', CAST(d.TruckPrioritySequence AS NVARCHAR(40)),  CAST(i.TruckPrioritySequence AS NVARCHAR(40))),
            ('IssueNotes',            d.IssueNotes,                                   i.IssueNotes)
        ) AS v(FieldName, OldVal, NewVal)
        WHERE ISNULL(v.OldVal, N'<<NULL>>') <> ISNULL(v.NewVal, N'<<NULL>>');

        IF NOT EXISTS (SELECT 1 FROM @Diffs) RETURN;

        MERGE INTO dbo.AuditChangeEvents AS tgt
        USING (SELECT DISTINCT EntityId, EntityCode FROM @Diffs) AS src
        ON 1 = 0
        WHEN NOT MATCHED THEN
            INSERT (EntityType, EntityId, EntityCode, OperationType, ChangedByUserId)
            VALUES ('TowRequests', src.EntityId, src.EntityCode, 'UPDATE', @ActorId)
        OUTPUT inserted.ChangeEventId, src.EntityId INTO @EvtMap (ChangeEventId, EntityId);

        INSERT INTO dbo.AuditChangeDetails (ChangeEventId, FieldName, OldValue, NewValue)
        SELECT m.ChangeEventId, dr.FieldName, dr.OldVal, dr.NewVal
        FROM @Diffs AS dr
        INNER JOIN @EvtMap AS m ON m.EntityId = dr.EntityId;
    END;
END;
GO

-- 9. Trigger on dbo.InvoicePayments & TowInvoices Paid Balances
CREATE OR ALTER TRIGGER dbo.trg_Audit_InvoicePayments
ON dbo.InvoicePayments
AFTER INSERT
AS
BEGIN
    IF @@ROWCOUNT = 0 RETURN;
    SET NOCOUNT ON;
    DECLARE @ActorId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @ActorId IS NULL RETURN;

    DECLARE @EvtMap TABLE (ChangeEventId BIGINT, EntityId BIGINT);

    MERGE INTO dbo.AuditChangeEvents AS tgt
    USING (
        SELECT ip.PaymentId, inv.InvoiceNumber
        FROM inserted AS ip
        INNER JOIN dbo.TowInvoices AS inv ON ip.InvoiceId = inv.InvoiceId
    ) AS src
    ON 1 = 0
    WHEN NOT MATCHED THEN
        INSERT (EntityType, EntityId, EntityCode, OperationType, ChangedByUserId)
        VALUES ('InvoicePayments', src.PaymentId, src.InvoiceNumber, 'CREATE', @ActorId)
    OUTPUT inserted.ChangeEventId, src.PaymentId INTO @EvtMap (ChangeEventId, EntityId);

    INSERT INTO dbo.AuditChangeDetails (ChangeEventId, FieldName, OldValue, NewValue)
    SELECT m.ChangeEventId, v.FieldName, NULL, v.NewVal
    FROM inserted AS ip
    INNER JOIN dbo.TowInvoices AS inv ON ip.InvoiceId = inv.InvoiceId
    INNER JOIN @EvtMap AS m ON m.EntityId = ip.PaymentId
    CROSS APPLY (VALUES
        ('InvoiceNumber',   CAST(inv.InvoiceNumber AS NVARCHAR(400))),
        ('PayerType',       CAST(ip.PayerType AS NVARCHAR(400))),
        ('AmountPaid',      CONCAT(N'$', CAST(ip.AmountPaid AS NVARCHAR(50)))),
        ('PaymentMethod',   CAST(ip.PaymentMethod AS NVARCHAR(400))),
        ('ReferenceNumber', CAST(ip.ReferenceNumber AS NVARCHAR(400)))
    ) AS v(FieldName, NewVal)
    WHERE v.NewVal IS NOT NULL;
END;
GO

-- 10. Parameterized Stored Procedure: dbo.usp_GetEntityChangeLogs
CREATE OR ALTER PROCEDURE dbo.usp_GetEntityChangeLogs
    @EntityType     VARCHAR(40) = NULL,
    @EntityId       BIGINT      = NULL,
    @SectionScope   VARCHAR(40) = NULL,
    @TopN           INT         = 80
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @CurrentUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @CurrentUserId IS NULL
        THROW 50031, 'Security Context Violation: Authenticated dispatcher SESSION_CONTEXT(AppUserId) is required.', 1;

    IF @TopN IS NULL OR @TopN < 1 OR @TopN > 250
        SET @TopN = 80;

    DECLARE @SelectedEvents TABLE (ChangeEventId BIGINT PRIMARY KEY);

    IF @EntityType IS NOT NULL AND @EntityId IS NOT NULL
    BEGIN
        DECLARE @LookupCode VARCHAR(100) = NULL;
        IF @EntityType = 'TowInvoices'
            SELECT @LookupCode = InvoiceNumber FROM dbo.TowInvoices WHERE InvoiceId = @EntityId;
        ELSE IF @EntityType = 'InsurancePolicies'
            SELECT @LookupCode = PolicyNumber FROM dbo.InsurancePolicies WHERE PolicyId = @EntityId;

        INSERT INTO @SelectedEvents (ChangeEventId)
        SELECT TOP (@TopN) e.ChangeEventId
        FROM dbo.AuditChangeEvents AS e
        WHERE (e.EntityType = @EntityType AND e.EntityId = @EntityId)
           OR (@EntityType = 'TowInvoices' AND @LookupCode IS NOT NULL AND e.EntityType = 'InvoicePayments' AND e.EntityCode = @LookupCode)
           OR (@EntityType = 'InsurancePolicies' AND @LookupCode IS NOT NULL AND e.EntityType = 'PolicyQuotaTiers' AND e.EntityCode LIKE @LookupCode + '%')
        ORDER BY e.ChangeEventId DESC;
    END
    ELSE
    BEGIN
        INSERT INTO @SelectedEvents (ChangeEventId)
        SELECT TOP (@TopN) e.ChangeEventId
        FROM dbo.AuditChangeEvents AS e
        WHERE (@SectionScope = 'users'       AND e.EntityType = 'SystemUsers')
           OR (@SectionScope = 'groups'      AND e.EntityType = 'UserGroups')
           OR (@SectionScope = 'trucks'      AND e.EntityType = 'TowTrucks')
           OR (@SectionScope = 'drivers'     AND e.EntityType = 'Drivers')
           OR (@SectionScope = 'customers'   AND e.EntityType = 'Customers')
           OR (@SectionScope = 'policies'    AND e.EntityType IN ('InsurancePolicies', 'PolicyQuotaTiers'))
           OR (@SectionScope = 'tariffs'     AND e.EntityType = 'Tariffs')
           OR (@SectionScope = 'billing'     AND e.EntityType IN ('TowInvoices', 'InvoicePayments'))
           OR (@SectionScope = 'queue'       AND e.EntityType IN ('TowRequests', 'DriverTruckAssignments'))
           OR (@SectionScope = 'performance' AND e.EntityType IN ('TowRequests', 'TowInvoices', 'InvoicePayments'))
           OR (@SectionScope = 'concurrency' AND e.EntityType IN ('TowRequests', 'PolicyQuotaTiers'))
        ORDER BY e.ChangeEventId DESC;
    END;

    -- Result Set 1: Normalized Event Headers joined with dbo.SystemUsers & dbo.UserGroups (3NF)
    SELECT
        e.ChangeEventId,
        e.EntityType,
        e.EntityId,
        ISNULL(e.EntityCode, CONCAT('#', CAST(e.EntityId AS VARCHAR(20)))) AS EntityCode,
        e.OperationType,
        e.ChangedByUserId,
        ISNULL(u.Username, 'system') AS ChangedByUsername,
        ISNULL(u.FullName, N'System Process') AS ChangedByFullName,
        ISNULL(ug.GroupName, N'System') AS ChangedByRole,
        e.SqlLoginName,
        e.ChangedAt
    FROM dbo.AuditChangeEvents AS e
    INNER JOIN @SelectedEvents AS se ON e.ChangeEventId = se.ChangeEventId
    LEFT JOIN dbo.SystemUsers AS u ON e.ChangedByUserId = u.UserId
    LEFT JOIN dbo.UserGroups AS ug ON u.GroupId = ug.GroupId
    ORDER BY e.ChangeEventId DESC;

    -- Result Set 2: Atomic Field-Level OldData -> NewData Diffs
    SELECT
        d.ChangeDetailId,
        d.ChangeEventId,
        d.FieldName,
        d.OldValue,
        d.NewValue
    FROM dbo.AuditChangeDetails AS d
    INNER JOIN @SelectedEvents AS se ON d.ChangeEventId = se.ChangeEventId
    ORDER BY d.ChangeEventId DESC, d.ChangeDetailId ASC;
END;
GO

/*==============================================================================
  STORED PROCEDURE: dbo.usp_GetTowRequestDetailById
  Fetches complete normalized 3NF Tow Request Info (for any of the 120,000+ rows
  in National Dispatch Archive or Dispatch Queue), linked Split Invoice & Payment
  Ledger rows, and unified Odoo-style Change Log events & field diffs.
==============================================================================*/
CREATE OR ALTER PROCEDURE dbo.usp_GetTowRequestDetailById
    @TowRequestId INT
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @CurrentUserId INT = TRY_CAST(SESSION_CONTEXT(N'AppUserId') AS INT);
    IF @CurrentUserId IS NULL
        THROW 50031, 'Security Context Violation: Authenticated dispatcher SESSION_CONTEXT(AppUserId) is required.', 1;

    DECLARE @InvoiceId     INT         = NULL,
            @InvoiceNumber VARCHAR(30) = NULL,
            @RequestNumber VARCHAR(30) = NULL;

    SELECT
        @RequestNumber = tr.RequestNumber,
        @InvoiceId     = inv.InvoiceId,
        @InvoiceNumber = inv.InvoiceNumber
    FROM dbo.TowRequests AS tr
    LEFT JOIN dbo.TowInvoices AS inv ON tr.TowRequestId = inv.TowRequestId
    WHERE tr.TowRequestId = @TowRequestId;

    -- Result Set 1: Normalized 3NF Master Record + Related Entities
    SELECT
        tr.TowRequestId,
        tr.RequestNumber,
        tr.Status,
        tr.IssueType,
        ISNULL(tr.IssueNotes, N'') AS IssueNotes,
        tr.CallerPhone,
        tr.PickupAddress,
        tr.PickupLat,
        tr.PickupLng,
        tr.DestinationAddress,
        tr.DestinationLat,
        tr.DestinationLng,
        tr.StraightLineDistanceKm,
        tr.RouteDistanceKm,
        tr.DistanceSource,
        tr.RouteDurationMinutes,
        tr.TruckPrioritySequence,
        tr.IsNightShift,
        ISNULL(tr.RejectionReason, N'') AS RejectionReason,
        tr.CreatedAt,
        tr.CompletedAt,
        c.CustomerId,
        c.FullName AS CustomerName,
        c.Phone AS CustomerPhone,
        ISNULL(c.Email, '') AS CustomerEmail,
        v.VehicleId,
        v.VehiclePlate,
        v.VehicleModel,
        v.NoPlate,
        ISNULL(pc.Code, '') AS PlateRegionCode,
        ISNULL(pc.RegionDescription, N'') AS PlateRegionDescription,
        tr.PolicyId,
        ISNULL(pol.PolicyNumber, '') AS PolicyNumber,
        ISNULL(pol.PolicyStatus, '') AS PolicyStatus,
        prov.ProviderId,
        ISNULL(prov.ProviderName, N'') AS ProviderName,
        tr.QuotaTierId,
        qt.TierSequence,
        ISNULL(qt.CoverageType, '') AS TierCoverageType,
        qt.AllowedTows AS TierAllowedTows,
        qt.UsedTows AS TierUsedTows,
        qt.MaxDistanceKm AS TierMaxDistanceKm,
        tr.AssignedTruckId,
        ISNULL(t.TruckCode, '') AS TruckCode,
        ISNULL(t.LicensePlate, '') AS TruckPlate,
        ISNULL(t.TruckModel, N'') AS TruckModel,
        tr.AssignedDriverId,
        ISNULL(drv.EmployeeCode, '') AS DriverCode,
        ISNULL(drv.FullName, N'') AS DriverName,
        ISNULL(drv.Phone, '') AS DriverPhone,
        tr.SubcontractorId,
        ISNULL(sub.CompanyName, N'') AS SubcontractorName,
        ISNULL(sub.Phone, '') AS SubcontractorPhone,
        ISNULL(inv.InvoiceId, 0) AS InvoiceId,
        ISNULL(inv.InvoiceNumber, '') AS InvoiceNumber,
        inv.TariffId,
        ISNULL(tf.TariffCode, '') AS TariffCode,
        ISNULL(tf.TariffName, N'') AS TariffName,
        ISNULL(inv.AppliedBaseFee, 0.00) AS AppliedBaseFee,
        ISNULL(inv.AppliedPricePerKm, 0.00) AS AppliedPricePerKm,
        ISNULL(inv.AppliedNightSurcharge, 0.00) AS AppliedNightSurcharge,
        ISNULL(inv.CoveredDistanceKm, 0.00) AS CoveredDistanceKm,
        ISNULL(inv.OverageDistanceKm, 0.00) AS OverageDistanceKm,
        ISNULL(inv.SubcontractorCost, 0.00) AS SubcontractorCost,
        ISNULL(inv.InsurerBilledAmount, 0.00) AS InsurerBilledAmount,
        ISNULL(inv.InsurerPaidAmount, 0.00) AS InsurerPaidAmount,
        ISNULL(inv.InsurerBilledAmount - inv.InsurerPaidAmount, 0.00) AS InsurerBalanceDue,
        ISNULL(inv.CustomerBilledAmount, 0.00) AS CustomerBilledAmount,
        ISNULL(inv.CustomerPaidAmount, 0.00) AS CustomerPaidAmount,
        ISNULL(inv.CustomerBilledAmount - inv.CustomerPaidAmount, 0.00) AS CustomerBalanceDue,
        ISNULL(inv.TotalAmount, 0.00) AS TotalAmount,
        ISNULL(inv.InvoiceStatus, 'Draft') AS InvoiceStatus,
        inv.IssuedAt
    FROM dbo.TowRequests AS tr
    INNER JOIN dbo.Customers AS c ON tr.CustomerId = c.CustomerId
    INNER JOIN dbo.Vehicles AS v ON tr.VehicleId = v.VehicleId
    LEFT JOIN dbo.PlateCodes AS pc ON v.PlateCodeId = pc.PlateCodeId
    LEFT JOIN dbo.InsurancePolicies AS pol ON tr.PolicyId = pol.PolicyId
    LEFT JOIN dbo.InsuranceProviders AS prov ON pol.ProviderId = prov.ProviderId
    LEFT JOIN dbo.PolicyQuotaTiers AS qt ON tr.QuotaTierId = qt.QuotaTierId
    LEFT JOIN dbo.TowTrucks AS t ON tr.AssignedTruckId = t.TruckId
    LEFT JOIN dbo.Drivers AS drv ON tr.AssignedDriverId = drv.DriverId
    LEFT JOIN dbo.Subcontractors AS sub ON tr.SubcontractorId = sub.SubcontractorId
    LEFT JOIN dbo.TowInvoices AS inv ON tr.TowRequestId = inv.TowRequestId
    LEFT JOIN dbo.Tariffs AS tf ON inv.TariffId = tf.TariffId
    WHERE tr.TowRequestId = @TowRequestId;

    -- Result Set 2: Individual Payment Settlements (dbo.InvoicePayments)
    SELECT
        p.PaymentId,
        p.PayerType,
        CASE
            WHEN p.PayerType = 'InsuranceProvider' THEN ISNULL(iprov.ProviderName, N'Insurance Provider')
            ELSE ISNULL(cust.FullName, N'Customer')
        END AS PayerName,
        p.AmountPaid,
        p.PaymentMethod,
        ISNULL(p.ReferenceNumber, '') AS ReferenceNumber,
        ISNULL(cdrv.FullName, N'') AS CollectedByDriverName,
        ISNULL(ru.Username, 'system') AS RecordedByUsername,
        ISNULL(ru.FullName, N'System Settlement') AS RecordedByFullName,
        ISNULL(p.Notes, N'') AS Notes,
        p.PaidAt
    FROM dbo.InvoicePayments AS p
    LEFT JOIN dbo.InsuranceProviders AS iprov ON p.InsuranceProviderId = iprov.ProviderId
    LEFT JOIN dbo.Customers AS cust ON p.CustomerId = cust.CustomerId
    LEFT JOIN dbo.Drivers AS cdrv ON p.CollectedByDriverId = cdrv.DriverId
    LEFT JOIN dbo.SystemUsers AS ru ON p.RecordedByUserId = ru.UserId
    WHERE @InvoiceId IS NOT NULL AND p.InvoiceId = @InvoiceId
    ORDER BY p.PaidAt DESC, p.PaymentId DESC;

    -- Result Sets 3 & 4: Unified Chronological Change Log for this Tow Request
    DECLARE @LogEvents TABLE
    (
        LogEventId        BIGINT        NOT NULL PRIMARY KEY,
        EntityCode        VARCHAR(100)  NOT NULL,
        OperationType     VARCHAR(20)   NOT NULL,
        ChangedByUsername VARCHAR(60)   NOT NULL,
        ChangedByFullName NVARCHAR(120) NOT NULL,
        ChangedAt         DATETIME2(3)  NOT NULL
    );

    DECLARE @LogDetails TABLE
    (
        LogDetailId INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        LogEventId  BIGINT            NOT NULL,
        FieldName   VARCHAR(80)       NOT NULL,
        OldValue    NVARCHAR(400)     NULL,
        NewValue    NVARCHAR(400)     NULL
    );

    -- A) Field-level 3NF change events on TowRequests & linked Invoice/Payments
    INSERT INTO @LogEvents (LogEventId, EntityCode, OperationType, ChangedByUsername, ChangedByFullName, ChangedAt)
    SELECT
        e.ChangeEventId,
        ISNULL(e.EntityCode, ISNULL(@RequestNumber, CONCAT('#', @TowRequestId))),
        e.OperationType,
        ISNULL(u.Username, 'system'),
        ISNULL(u.FullName, N'System Process'),
        e.ChangedAt
    FROM dbo.AuditChangeEvents AS e
    LEFT JOIN dbo.SystemUsers AS u ON e.ChangedByUserId = u.UserId
    WHERE (e.EntityType = 'TowRequests' AND e.EntityId = @TowRequestId)
       OR (@InvoiceId IS NOT NULL AND e.EntityType = 'TowInvoices' AND e.EntityId = @InvoiceId)
       OR (@InvoiceNumber IS NOT NULL AND e.EntityType = 'InvoicePayments' AND e.EntityCode = @InvoiceNumber);

    INSERT INTO @LogDetails (LogEventId, FieldName, OldValue, NewValue)
    SELECT
        d.ChangeEventId,
        d.FieldName,
        d.OldValue,
        d.NewValue
    FROM dbo.AuditChangeDetails AS d
    INNER JOIN @LogEvents AS le ON d.ChangeEventId = le.LogEventId;

    -- B) Status lifecycle transitions from dbo.TowAuditLogs (mapped as negative synthetic IDs)
    INSERT INTO @LogEvents (LogEventId, EntityCode, OperationType, ChangedByUsername, ChangedByFullName, ChangedAt)
    SELECT
        -CAST(al.AuditId AS BIGINT),
        al.RequestNumber,
        CASE WHEN al.OldStatus IS NULL THEN 'CREATE' ELSE 'UPDATE' END,
        al.DispatcherUsername,
        ISNULL(al.DispatcherFullName, al.DispatcherUsername),
        al.ChangedAt
    FROM dbo.TowAuditLogs AS al
    WHERE al.TowRequestId = @TowRequestId;

    INSERT INTO @LogDetails (LogEventId, FieldName, OldValue, NewValue)
    SELECT
        -CAST(al.AuditId AS BIGINT),
        'Status',
        al.OldStatus,
        al.NewStatus
    FROM dbo.TowAuditLogs AS al
    WHERE al.TowRequestId = @TowRequestId;

    INSERT INTO @LogDetails (LogEventId, FieldName, OldValue, NewValue)
    SELECT
        -CAST(al.AuditId AS BIGINT),
        'Note',
        NULL,
        al.ActionNote
    FROM dbo.TowAuditLogs AS al
    WHERE al.TowRequestId = @TowRequestId
      AND al.ActionNote IS NOT NULL
      AND LEN(LTRIM(RTRIM(al.ActionNote))) > 0;

    -- C) Invoice payment rows not already captured in AuditChangeEvents (e.g. seeded settlements)
    IF @InvoiceId IS NOT NULL
    BEGIN
        INSERT INTO @LogEvents (LogEventId, EntityCode, OperationType, ChangedByUsername, ChangedByFullName, ChangedAt)
        SELECT
            -1000000 - p.PaymentId,
            ISNULL(@InvoiceNumber, CONCAT('INV#', @InvoiceId)),
            'CREATE',
            ISNULL(ru.Username, 'billing.ledger'),
            ISNULL(ru.FullName, N'Billing Settlement'),
            p.PaidAt
        FROM dbo.InvoicePayments AS p
        LEFT JOIN dbo.SystemUsers AS ru ON p.RecordedByUserId = ru.UserId
        WHERE p.InvoiceId = @InvoiceId
          AND NOT EXISTS (
              SELECT 1
              FROM dbo.AuditChangeEvents AS e
              WHERE e.EntityType = 'InvoicePayments'
                AND e.EntityId = p.PaymentId
          );

        INSERT INTO @LogDetails (LogEventId, FieldName, OldValue, NewValue)
        SELECT
            -1000000 - p.PaymentId,
            'PaymentPaid',
            NULL,
            CONCAT('$', CAST(p.AmountPaid AS VARCHAR(20)), ' by ', p.PayerType, ' (', p.PaymentMethod, ')')
        FROM dbo.InvoicePayments AS p
        WHERE p.InvoiceId = @InvoiceId
          AND (-1000000 - p.PaymentId) IN (SELECT LogEventId FROM @LogEvents);
    END;

    -- D) Baseline creation entry if historical seeded archive record has no CREATE event yet
    IF @RequestNumber IS NOT NULL AND NOT EXISTS (SELECT 1 FROM @LogEvents WHERE OperationType = 'CREATE' AND EntityCode = @RequestNumber)
    BEGIN
        INSERT INTO @LogEvents (LogEventId, EntityCode, OperationType, ChangedByUsername, ChangedByFullName, ChangedAt)
        SELECT
            -9000000000 - CAST(tr.TowRequestId AS BIGINT),
            tr.RequestNumber,
            'CREATE',
            ISNULL(cu.Username, 'dispatch.beirut'),
            ISNULL(cu.FullName, N'CAD Intake Desk'),
            tr.CreatedAt
        FROM dbo.TowRequests AS tr
        LEFT JOIN dbo.SystemUsers AS cu ON tr.CreatedByUserId = cu.UserId
        WHERE tr.TowRequestId = @TowRequestId;

        INSERT INTO @LogDetails (LogEventId, FieldName, OldValue, NewValue)
        SELECT -9000000000 - CAST(tr.TowRequestId AS BIGINT), 'Vehicle', NULL, CONCAT(v.VehiclePlate, ' — ', v.VehicleModel)
        FROM dbo.TowRequests AS tr INNER JOIN dbo.Vehicles AS v ON tr.VehicleId = v.VehicleId
        WHERE tr.TowRequestId = @TowRequestId
        UNION ALL
        SELECT -9000000000 - CAST(tr.TowRequestId AS BIGINT), 'IssueType', NULL, tr.IssueType
        FROM dbo.TowRequests AS tr WHERE tr.TowRequestId = @TowRequestId
        UNION ALL
        SELECT -9000000000 - CAST(tr.TowRequestId AS BIGINT), 'RouteDistanceKm', NULL, CONCAT(CAST(tr.RouteDistanceKm AS VARCHAR(20)), ' km (', tr.DistanceSource, ')')
        FROM dbo.TowRequests AS tr WHERE tr.TowRequestId = @TowRequestId
        UNION ALL
        SELECT -9000000000 - CAST(tr.TowRequestId AS BIGINT), 'Status', NULL, tr.Status
        FROM dbo.TowRequests AS tr WHERE tr.TowRequestId = @TowRequestId;
    END;

    SELECT
        LogEventId AS ChangeEventId,
        EntityCode,
        OperationType,
        ChangedByUsername,
        ChangedByFullName,
        ChangedAt
    FROM @LogEvents
    ORDER BY ChangedAt DESC, LogEventId DESC;

    SELECT
        LogDetailId AS ChangeDetailId,
        LogEventId AS ChangeEventId,
        FieldName,
        OldValue,
        NewValue
    FROM @LogDetails
    ORDER BY LogDetailId ASC;
END;
GO

PRINT '02_programmability_logic.sql completed successfully.';
GO
