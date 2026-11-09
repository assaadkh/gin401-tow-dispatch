/*==============================================================================
  GIN401 - LAB PROJECT: ROADSIDE ASSISTANCE & TOWING CAD DISPATCH SYSTEM
  Script 02: T-SQL Programmability (Functions, Triggers, Window Views &
             Transactional Stored Procedures with Concurrency Control)
  DBMS: Microsoft SQL Server
==============================================================================*/
USE GIN401_TowDispatch;
GO
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

/*==============================================================================
  1. SCALAR FUNCTION: dbo.fn_CalculateRoadDistanceKm
  Calculates estimated driving distance in KM between Pickup and Destination
  coordinates using the Haversine great-circle formula + 1.45x road winding factor.
==============================================================================*/
CREATE OR ALTER FUNCTION dbo.fn_CalculateRoadDistanceKm
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
        RETURN 5.00;

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
    DECLARE @RoadKm FLOAT = @EarthRadiusKm * @c * 1.45; -- 1.45x Lebanese mountain road factor

    IF @RoadKm < 3.0 SET @RoadKm = 3.0;
    RETURN CAST(ROUND(@RoadKm, 2) AS DECIMAL(8,2));
END;
GO

/*==============================================================================
  2. TABLE-VALUED FUNCTION: dbo.tvf_CheckPolicyEligibility
  Evaluates a customer's Insurance Policy for a given Breakdown IssueType:
  - Maps IssueType ('Accident','Winch' -> 'Accident', others -> 'Mechanical')
  - Finds the first sequential Quota Tier with remaining tows > 0
  - Checks if Accident or Mechanical quota is exhausted (0 remaining)
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
            @ExpirationDate DATE,
            @PolicyStatus VARCHAR(20),
            @DefaultAllowedKm DECIMAL(8,2),
            @DefaultCooldown INT;

    SELECT
        @PolicyNumber = p.PolicyNumber,
        @ExpirationDate = p.ExpirationDate,
        @PolicyStatus = p.PolicyStatus,
        @DefaultAllowedKm = p.DefaultAllowedKm,
        @DefaultCooldown = p.DefaultMinIntervalDays
    FROM dbo.InsurancePolicies AS p
    WHERE p.PolicyId = @PolicyId;

    IF @PolicyNumber IS NULL
    BEGIN
        INSERT INTO @Result VALUES (@PolicyId, 'UNKNOWN', @TargetCategory, 0, NULL, NULL, 0, 0, 0, NULL, NULL, NULL,
            N'Insurance Policy not found. Direct customer invoicing required.');
        RETURN;
    END;

    -- 1. Check Policy Expiration
    IF @ExpirationDate < CAST(SYSDATETIME() AS DATE) OR @PolicyStatus = 'Expired'
    BEGIN
        INSERT INTO @Result VALUES (@PolicyId, @PolicyNumber, @TargetCategory, 0, NULL, NULL, 0, 0, 0, NULL, NULL, NULL,
            CONCAT(N'POLICY EXPIRED: Policy ', @PolicyNumber, N' expired on ', CONVERT(VARCHAR(10), @ExpirationDate, 23), N'. Direct billing required.'));
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
        @MatchedTierId = qt.QuotaTierId,
        @TierAllowedKm = qt.MaxDistanceKm,
        @TierCooldown = qt.MinIntervalDays,
        @TierSeq = qt.TierSequence,
        @TierAllowedTows = qt.AllowedTows,
        @TierRemaining = (qt.AllowedTows - qt.UsedTows),
        @TierCovType = qt.CoverageType
    FROM dbo.PolicyQuotaTiers AS qt
    WHERE qt.PolicyId = @PolicyId
      AND qt.CoverageType IN (@TargetCategory, 'All')
      AND qt.UsedTows < qt.AllowedTows
    ORDER BY qt.TierSequence ASC, qt.QuotaTierId ASC;

    -- 3. Check Quota Exhaustion (Accident or Mechanical)
    IF @RemainingCategoryTows <= 0 OR @MatchedTierId IS NULL
    BEGIN
        DECLARE @ExhaustMsg NVARCHAR(400) =
            CASE WHEN @TargetCategory = 'Accident'
                THEN CONCAT(N'ACCIDENT TOW NOT ALLOWED: Policy ', @PolicyNumber, N' does not allow any accidental tows anymore (0 remaining). Direct customer billing required.')
                ELSE CONCAT(N'MECHANICAL QUOTA EXHAUSTED: Policy ', @PolicyNumber, N' has 0 remaining mechanical breakdown tows. Direct customer billing required.')
            END;

        INSERT INTO @Result VALUES (@PolicyId, @PolicyNumber, @TargetCategory, 0, NULL, NULL, 0, 0, 0, NULL, NULL, NULL, @ExhaustMsg);
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
            @LastTowDate = tr.CreatedAt,
            @DaysElapsed = CAST(DATEDIFF(MINUTE, tr.CreatedAt, SYSDATETIME()) / 1440.0 AS DECIMAL(8,2))
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
                @PolicyId, @PolicyNumber, @TargetCategory, 0,
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
        @PolicyId, @PolicyNumber, @TargetCategory, 1,
        @MatchedTierId, @TierDesc, @TierAllowedKm, @RemainingCategoryTows,
        @EffectiveCooldown, @DaysElapsed, @LastTowNumber, @LastTowDate,
        CONCAT(N'ELIGIBLE: Applied ', @TierDesc, N' — ', @TierRemaining, N' left in tier (Total ', @RemainingCategoryTows, N' ', @TargetCategory, N' left).')
    );
    RETURN;
END;
GO

/*==============================================================================
  3. TRIGGER: dbo.trg_TowRequests_ImmutabilityAndAudit
  - Blocks DELETE operations on TowRequests (audit trail protection)
  - Blocks any modification or reopening of finalized requests where Status WAS
    already in ('Done', 'UnableToLoad', 'Rejected')
  - Automatically logs every status creation/change into dbo.TowAuditLogs
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

    -- 3. Insert Audit Log entries for newly created or status-changed TowRequests
    INSERT INTO dbo.TowAuditLogs (TowRequestId, RequestNumber, OldStatus, NewStatus, ActionNote)
    SELECT
        i.TowRequestId,
        i.RequestNumber,
        d.Status AS OldStatus,
        i.Status AS NewStatus,
        CASE
            WHEN d.TowRequestId IS NULL THEN CONCAT(N'Ticket created with status ', i.Status, N' for vehicle ', i.VehiclePlate)
            WHEN d.Status <> i.Status THEN CONCAT(N'Status transitioned from ', d.Status, N' to ', i.Status,
                CASE WHEN i.OverageAmount > 0 THEN CONCAT(N' | Overage billed: $', i.OverageAmount) ELSE N'' END)
            ELSE CONCAT(N'Ticket details updated while in ', i.Status, N' state')
        END
    FROM inserted AS i
    LEFT JOIN deleted AS d ON i.TowRequestId = d.TowRequestId
    WHERE d.TowRequestId IS NULL
       OR d.Status <> i.Status
       OR ISNULL(d.AssignedTruckId, 0) <> ISNULL(i.AssignedTruckId, 0);
END;
GO

/*==============================================================================
  4. VIEW WITH WINDOW FUNCTIONS: dbo.vw_FleetPriorityQueueAndRankings
  Uses ROW_NUMBER(), DENSE_RANK(), and SUM() OVER() window functions to compute
  each truck's active job stop order, cumulative route distance, and fleet rank.
==============================================================================*/
CREATE OR ALTER VIEW dbo.vw_FleetPriorityQueueAndRankings
AS
SELECT
    tr.TowRequestId,
    tr.RequestNumber,
    tr.AssignedTruckId,
    t.TruckCode,
    t.LicensePlate AS TruckPlate,
    t.DriverName,
    t.FleetStatus,
    tr.VehiclePlate,
    tr.VehicleModel,
    tr.IssueType,
    tr.Status,
    tr.TruckPrioritySequence,
    tr.PickupAddress,
    tr.PickupLat,
    tr.PickupLng,
    tr.DestinationAddress,
    tr.DestinationLat,
    tr.DestinationLng,
    tr.ActualDistanceKm,
    tr.OverageAmount,
    -- Window Function 1: Stop order number (1, 2, 3...) within each truck's active queue
    ROW_NUMBER() OVER (
        PARTITION BY tr.AssignedTruckId
        ORDER BY tr.TruckPrioritySequence ASC, tr.TowRequestId ASC
    ) AS StopNumberInTruckQueue,
    -- Window Function 2: Running cumulative distance KM for the truck's active queue
    SUM(tr.ActualDistanceKm) OVER (
        PARTITION BY tr.AssignedTruckId
        ORDER BY tr.TruckPrioritySequence ASC, tr.TowRequestId ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS CumulativeQueueDistanceKm,
    -- Window Function 3: Total active jobs assigned to this truck
    COUNT(*) OVER (
        PARTITION BY tr.AssignedTruckId
    ) AS TotalActiveJobsForTruck
FROM dbo.TowRequests AS tr
INNER JOIN dbo.TowTrucks AS t ON tr.AssignedTruckId = t.TruckId
WHERE tr.Status IN ('Approved', 'InProgress');
GO

/*==============================================================================
  5. STORED PROCEDURE: dbo.usp_ApproveAndDispatchTow
  Demonstrates multi-step TRANSACTION with TRY...CATCH, ROLLBACK, and
  PESSIMISTIC CONCURRENCY LOCKING (WITH (UPDLOCK, ROWLOCK)) so two dispatchers
  cannot simultaneously consume the last remaining tow quota or double-approve
  the same ticket.
==============================================================================*/
CREATE OR ALTER PROCEDURE dbo.usp_ApproveAndDispatchTow
    @TowRequestId       INT,
    @AssignedTruckId    INT,
    @SimulatedHoldMs    INT = 0  -- Used in Live Demo to hold UPDLOCK for 2-user race test
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    BEGIN TRY
        BEGIN TRANSACTION;

        -- Step 1: Lock the TowRequest row with UPDLOCK so two users cannot approve the same ticket twice
        DECLARE @CurrentStatus      VARCHAR(25),
                @HasInsurance       BIT,
                @PolicyId           INT,
                @IssueType          VARCHAR(20),
                @ActualDistanceKm   DECIMAL(8,2),
                @ExtraKmRate        DECIMAL(8,2),
                @RequestNumber      VARCHAR(30);

        SELECT
            @CurrentStatus    = tr.Status,
            @HasInsurance     = tr.HasInsurance,
            @PolicyId         = tr.PolicyId,
            @IssueType        = tr.IssueType,
            @ActualDistanceKm = tr.ActualDistanceKm,
            @ExtraKmRate      = tr.ExtraKmRate,
            @RequestNumber    = tr.RequestNumber
        FROM dbo.TowRequests AS tr WITH (UPDLOCK, ROWLOCK)
        WHERE tr.TowRequestId = @TowRequestId;

        IF @CurrentStatus IS NULL
            THROW 50001, 'Tow Request does not exist.', 1;

        IF @CurrentStatus NOT IN ('Draft', 'PendingInsurance')
        BEGIN
            DECLARE @StateErr NVARCHAR(200) = CONCAT(N'Dispatch Blocked: Request ', @RequestNumber, N' is already in status "', @CurrentStatus, N'".');
            THROW 50002, @StateErr, 1;
        END;

        -- Step 2: Lock the target TowTruck row and verify it is not OffDuty
        DECLARE @TruckStatus VARCHAR(20);
        SELECT @TruckStatus = t.FleetStatus
        FROM dbo.TowTrucks AS t WITH (UPDLOCK, ROWLOCK)
        WHERE t.TruckId = @AssignedTruckId;

        IF @TruckStatus IS NULL
            THROW 50003, 'Assigned Tow Truck does not exist.', 1;
        IF @TruckStatus = 'OffDuty'
            THROW 50004, 'Assigned Tow Truck is currently Off-Duty and cannot be dispatched.', 1;

        DECLARE @MatchedQuotaTierId INT = NULL,
                @AllowedDistanceKm  DECIMAL(8,2) = 0.00;

        -- Step 3: If covered by Insurance, lock the Policy & Quota Tiers with UPDLOCK, HOLDLOCK
        IF @HasInsurance = 1 AND @PolicyId IS NOT NULL
        BEGIN
            -- Acquire row-level update lock on the parent Policy and its Quota Tiers
            -- Any concurrent transaction for the same PolicyId will wait right here!
            DECLARE @LockedPolicyId INT;
            SELECT @LockedPolicyId = p.PolicyId
            FROM dbo.InsurancePolicies AS p WITH (UPDLOCK, ROWLOCK)
            WHERE p.PolicyId = @PolicyId;

            -- Optional hold for demonstrating two simultaneous users in browser tabs
            IF @SimulatedHoldMs > 0 AND @SimulatedHoldMs <= 5000
            BEGIN
                DECLARE @DelayStr CHAR(12) = CONVERT(CHAR(12), DATEADD(MILLISECOND, @SimulatedHoldMs, 0), 114);
                WAITFOR DELAY @DelayStr;
            END;

            -- Evaluate Policy Eligibility (Quota remaining + Cooldown interval) inside the lock
            DECLARE @IsEligible BIT,
                    @StatusBanner NVARCHAR(400);

            SELECT
                @IsEligible         = elig.IsEligible,
                @MatchedQuotaTierId = elig.MatchedQuotaTierId,
                @AllowedDistanceKm  = elig.AllowedDistanceKm,
                @StatusBanner       = elig.StatusBanner
            FROM dbo.tvf_CheckPolicyEligibility(@PolicyId, @IssueType) AS elig;

            IF @IsEligible = 0 OR @MatchedQuotaTierId IS NULL
            BEGIN
                THROW 50005, @StatusBanner, 1;
            END;

            -- Step 4: Increment UsedTows on the matched Quota Tier (enforced by CK_PolicyQuotaTiers_Usage)
            UPDATE dbo.PolicyQuotaTiers WITH (ROWLOCK)
            SET UsedTows = UsedTows + 1
            WHERE QuotaTierId = @MatchedQuotaTierId;

            -- Step 5: If all tiers on this policy are now exhausted, update PolicyStatus to 'QuotaExceeded'
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

        -- Step 6: Calculate Overage KM and Overage Amount
        DECLARE @OverageKm DECIMAL(8,2) =
            CASE WHEN @ActualDistanceKm > @AllowedDistanceKm THEN (@ActualDistanceKm - @AllowedDistanceKm) ELSE 0.00 END;
        DECLARE @OverageAmount DECIMAL(10,2) = ROUND(@OverageKm * @ExtraKmRate, 2);

        -- Step 7: Calculate next TruckPrioritySequence (10, 20, 30...) for this truck's active queue
        DECLARE @NextPrioritySeq INT;
        SELECT @NextPrioritySeq = ISNULL(MAX(tr.TruckPrioritySequence), 0) + 10
        FROM dbo.TowRequests AS tr WITH (UPDLOCK)
        WHERE tr.AssignedTruckId = @AssignedTruckId
          AND tr.Status IN ('Approved', 'InProgress');

        -- Step 8: Update TowRequest to 'Approved'
        UPDATE dbo.TowRequests
        SET AssignedTruckId       = @AssignedTruckId,
            QuotaTierId           = @MatchedQuotaTierId,
            AllowedDistanceKm     = @AllowedDistanceKm,
            OverageKm             = @OverageKm,
            OverageAmount         = @OverageAmount,
            TruckPrioritySequence = @NextPrioritySeq,
            Status                = 'Approved'
        WHERE TowRequestId = @TowRequestId;

        -- Step 9: Update TowTruck FleetStatus to 'EnRoute' if it was 'Available'
        UPDATE dbo.TowTrucks
        SET FleetStatus     = CASE WHEN FleetStatus = 'Available' THEN 'EnRoute' ELSE FleetStatus END,
            LastTelemetryAt = SYSDATETIME()
        WHERE TruckId = @AssignedTruckId;

        COMMIT TRANSACTION;

        -- Return updated dispatch summary
        SELECT
            tr.TowRequestId,
            tr.RequestNumber,
            tr.Status,
            tr.AssignedTruckId,
            tr.TruckPrioritySequence,
            tr.QuotaTierId,
            tr.ActualDistanceKm,
            tr.AllowedDistanceKm,
            tr.OverageKm,
            tr.OverageAmount
        FROM dbo.TowRequests AS tr
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
  6. STORED PROCEDURE: dbo.usp_CreateTowRequest
  Creates a new roadside assistance request (calculates road distance via
  fn_CalculateRoadDistanceKm) and optionally dispatches it atomically.
==============================================================================*/
CREATE OR ALTER PROCEDURE dbo.usp_CreateTowRequest
    @CustomerId         INT,
    @CallerPhone        VARCHAR(30),
    @PlateCodeId        INT = NULL,
    @PlateDigits        VARCHAR(20) = NULL,
    @NoPlate            BIT = 0,
    @VehicleModel       NVARCHAR(80),
    @IssueType          VARCHAR(20),
    @IssueNotes         NVARCHAR(400) = NULL,
    @PickupAddress      NVARCHAR(200),
    @PickupLat          DECIMAL(9,6),
    @PickupLng          DECIMAL(9,6),
    @DestinationAddress NVARCHAR(200),
    @DestinationLat     DECIMAL(9,6),
    @DestinationLng     DECIMAL(9,6),
    @HasInsurance       BIT = 0,
    @PolicyId           INT = NULL,
    @IsOutsourced       BIT = 0,
    @SubcontractorName  NVARCHAR(120) = NULL,
    @SubcontractorFee   DECIMAL(10,2) = 0.00,
    @AssignedTruckId    INT = NULL,
    @AutoApprove        BIT = 0,
    @ActualDistanceOverrideKm DECIMAL(8,2) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    BEGIN TRY
        BEGIN TRANSACTION;

        -- Build standardized Lebanese VehiclePlate string
        DECLARE @VehiclePlate VARCHAR(30);
        IF @NoPlate = 1
            SET @VehiclePlate = 'NO-PLATE';
        ELSE
        BEGIN
            DECLARE @CodeLetter VARCHAR(10) = '';
            IF @PlateCodeId IS NOT NULL
                SELECT @CodeLetter = Code FROM dbo.PlateCodes WHERE PlateCodeId = @PlateCodeId;

            SET @VehiclePlate = LTRIM(RTRIM(CONCAT(@CodeLetter, ' ', LTRIM(RTRIM(ISNULL(@PlateDigits, ''))))));
        END;

        -- Compute road distance using OSRM override if provided, else our scalar function
        DECLARE @ActualDistanceKm DECIMAL(8,2) =
            CASE WHEN @ActualDistanceOverrideKm IS NOT NULL AND @ActualDistanceOverrideKm > 0
                 THEN @ActualDistanceOverrideKm
                 ELSE dbo.fn_CalculateRoadDistanceKm(@PickupLat, @PickupLng, @DestinationLat, @DestinationLng)
            END;

        -- Check if night shift (19:00 to 07:00)
        DECLARE @CurrentHour INT = DATEPART(HOUR, SYSDATETIME());
        DECLARE @IsNightShift BIT = CASE WHEN @CurrentHour >= 19 OR @CurrentHour < 7 THEN 1 ELSE 0 END;

        -- Preview insurance allowance for draft display
        DECLARE @AllowedKm DECIMAL(8,2) = 0.00,
                @PreviewTierId INT = NULL;

        IF @HasInsurance = 1 AND @PolicyId IS NOT NULL
        BEGIN
            SELECT
                @AllowedKm     = elig.AllowedDistanceKm,
                @PreviewTierId = elig.MatchedQuotaTierId
            FROM dbo.tvf_CheckPolicyEligibility(@PolicyId, @IssueType) AS elig;
        END;

        DECLARE @OverageKm DECIMAL(8,2) =
            CASE WHEN @ActualDistanceKm > @AllowedKm THEN (@ActualDistanceKm - @AllowedKm) ELSE 0.00 END;
        DECLARE @OverageAmt DECIMAL(10,2) = ROUND(@OverageKm * 2.50, 2);

        -- Generate unique RequestNumber
        DECLARE @TempReqNum VARCHAR(30) = CONCAT('TOW-', FORMAT(SYSDATETIME(), 'yyyyMMdd-HHmmss-'), RIGHT(CAST(ABS(CHECKSUM(NEWID())) AS VARCHAR(10)), 4));

        INSERT INTO dbo.TowRequests
        (
            RequestNumber, CustomerId, CallerPhone, PlateCodeId, PlateDigits, NoPlate,
            VehiclePlate, VehicleModel, IssueType, IssueNotes,
            PickupAddress, PickupLat, PickupLng, DestinationAddress, DestinationLat, DestinationLng,
            HasInsurance, PolicyId, QuotaTierId,
            IsOutsourced, SubcontractorName, SubcontractorFee, AssignedTruckId,
            ActualDistanceKm, AllowedDistanceKm, OverageKm, ExtraKmRate, OverageAmount,
            IsNightShift, Status
        )
        VALUES
        (
            @TempReqNum, @CustomerId, @CallerPhone, @PlateCodeId, @PlateDigits, @NoPlate,
            @VehiclePlate, @VehicleModel, @IssueType, @IssueNotes,
            @PickupAddress, @PickupLat, @PickupLng, @DestinationAddress, @DestinationLat, @DestinationLng,
            @HasInsurance, @PolicyId, @PreviewTierId,
            @IsOutsourced, @SubcontractorName, ISNULL(@SubcontractorFee, 0.00),
            CASE WHEN @IsOutsourced = 1 THEN NULL ELSE @AssignedTruckId END,
            @ActualDistanceKm, @AllowedKm, @OverageKm, 2.50, @OverageAmt,
            @IsNightShift, 'Draft'
        );

        DECLARE @NewTowRequestId INT = SCOPE_IDENTITY();

        -- Standardize RequestNumber with identity ID
        DECLARE @FinalReqNum VARCHAR(30) = CONCAT('TOW/', FORMAT(SYSDATETIME(), 'yyyy'), '/', FORMAT(@NewTowRequestId, '000000'));
        UPDATE dbo.TowRequests
        SET RequestNumber = @FinalReqNum
        WHERE TowRequestId = @NewTowRequestId;

        -- If AutoApprove = 1 and a truck is assigned, run transactional approval & quota deduction
        IF @AutoApprove = 1 AND @AssignedTruckId IS NOT NULL
        BEGIN
            EXEC dbo.usp_ApproveAndDispatchTow
                @TowRequestId    = @NewTowRequestId,
                @AssignedTruckId = @AssignedTruckId,
                @SimulatedHoldMs = 0;
        END;

        COMMIT TRANSACTION;

        SELECT
            tr.TowRequestId,
            tr.RequestNumber,
            tr.VehiclePlate,
            tr.Status,
            tr.ActualDistanceKm,
            tr.AllowedDistanceKm,
            tr.OverageKm,
            tr.OverageAmount
        FROM dbo.TowRequests AS tr
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
  7. STORED PROCEDURE: dbo.usp_UpdateTowLifecycleStatus
  Transitions a tow ticket to 'InProgress', 'Done', 'UnableToLoad', or 'Rejected'
  inside a transaction and automatically recalculates the TowTruck's FleetStatus.
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

    BEGIN TRY
        BEGIN TRANSACTION;

        DECLARE @AssignedTruckId INT;
        SELECT @AssignedTruckId = tr.AssignedTruckId
        FROM dbo.TowRequests AS tr WITH (UPDLOCK, ROWLOCK)
        WHERE tr.TowRequestId = @TowRequestId;

        -- Note: If the ticket is already finalized ('Done','UnableToLoad','Rejected'),
        -- the trigger dbo.trg_TowRequests_ImmutabilityAndAudit will automatically THROW 50010!
        UPDATE dbo.TowRequests
        SET Status          = @NewStatus,
            CashCollected   = CASE WHEN @NewStatus = 'Done' THEN @CashCollected ELSE CashCollected END,
            RejectionReason = CASE WHEN @NewStatus = 'Rejected' THEN @RejectionReason ELSE RejectionReason END,
            CompletedAt     = CASE WHEN @NewStatus IN ('Done', 'UnableToLoad', 'Rejected') THEN SYSDATETIME() ELSE CompletedAt END
        WHERE TowRequestId = @TowRequestId;

        -- Synchronize the assigned TowTruck's live FleetStatus
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
                -- Check if the truck still has other active jobs in its priority queue
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
  8. STORED PROCEDURE: dbo.usp_UpdateDraftTowOptimistic
  Demonstrates OPTIMISTIC CONCURRENCY CONTROL using ROWVERSION (Session 06).
  If another user modified the row since @ExpectedRowVer was read, @@ROWCOUNT = 0
  and the transaction rolls back with a concurrency conflict error.
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
  9. STORED PROCEDURE: dbo.usp_ReorderTruckJobQueue
  Reorders a truck's active job priority queue (Up / Down) inside a transaction
  so dispatchers can change Stop #1, Stop #2, Stop #3 directly from the CAD Map.
==============================================================================*/
CREATE OR ALTER PROCEDURE dbo.usp_ReorderTruckJobQueue
    @TruckId        INT,
    @TowRequestId   INT,
    @Direction      VARCHAR(10) -- 'up' or 'down'
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

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
            BEGIN
                UPDATE @Ordered SET NewOrderKey = NewOrderKey - 15 WHERE RowNum = @TargetRow;
            END
            ELSE IF @Direction = 'down' AND @TargetRow < (SELECT MAX(RowNum) FROM @Ordered)
            BEGIN
                UPDATE @Ordered SET NewOrderKey = NewOrderKey + 15 WHERE RowNum = @TargetRow;
            END;

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
  10. VIEW: dbo.vw_DriverPayrollAndCashReport
  Computes Driver Payroll, Night-Shift (19:00-07:00) & Off-Day Overtime bonuses,
  Cash Collected on scene (e.g. $200 cash), and Net Settlement per Driver.
==============================================================================*/
CREATE OR ALTER VIEW dbo.vw_DriverPayrollAndCashReport
AS
SELECT
    t.TruckId,
    t.TruckCode,
    t.LicensePlate,
    t.DriverName,
    t.DriverPhone,
    t.FleetStatus,
    t.BaseMonthlySalary,
    t.OvertimeRatePerTow,
    t.IsWorkingOffDay,
    COUNT(tr.TowRequestId) AS CompletedTowsThisMonth,
    COUNT(CASE WHEN (tr.IsNightShift = 1 OR t.IsWorkingOffDay = 1) THEN 1 END) AS OvertimeTowsCount,
    ISNULL(SUM(CASE WHEN (tr.IsNightShift = 1 OR t.IsWorkingOffDay = 1) THEN t.OvertimeRatePerTow ELSE 0.00 END), 0.00) AS OvertimePayEarned,
    ISNULL(SUM(tr.CashCollected), 0.00) AS TotalCashCollectedByDriver,
    ISNULL(SUM(tr.OverageAmount), 0.00) AS TotalOverageBilled,
    (
        t.BaseMonthlySalary
        + ISNULL(SUM(CASE WHEN (tr.IsNightShift = 1 OR t.IsWorkingOffDay = 1) THEN t.OvertimeRatePerTow ELSE 0.00 END), 0.00)
        - ISNULL(SUM(tr.CashCollected), 0.00)
    ) AS NetSalaryPayoutAfterCashDeduction
FROM dbo.TowTrucks AS t
LEFT JOIN dbo.TowRequests AS tr
    ON t.TruckId = tr.AssignedTruckId
   AND tr.Status = 'Done'
   AND tr.CreatedAt >= '2026-11-01'
GROUP BY
    t.TruckId, t.TruckCode, t.LicensePlate, t.DriverName, t.DriverPhone,
    t.FleetStatus, t.BaseMonthlySalary, t.OvertimeRatePerTow, t.IsWorkingOffDay;
GO

PRINT '02_programmability_logic.sql completed successfully.';
GO
