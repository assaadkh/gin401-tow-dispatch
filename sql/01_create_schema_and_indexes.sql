/*==============================================================================
  GIN401 - LAB PROJECT: ROADSIDE ASSISTANCE & TOWING CAD DISPATCH SYSTEM
  Script 01: Database Creation, Tables, Keys, Constraints & Covering Indexes
  DBMS: Microsoft SQL Server
==============================================================================*/
SET NOCOUNT ON;
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF DB_ID(N'GIN401_TowDispatch') IS NULL
BEGIN
    CREATE DATABASE GIN401_TowDispatch;
END
GO

USE GIN401_TowDispatch;
GO
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

/*------------------------------------------------------------------------------
  DROP EXISTING OBJECTS IN DEPENDENCY ORDER (FOR CLEAN RE-RUNS)
------------------------------------------------------------------------------*/
IF OBJECT_ID(N'dbo.TowAuditLogs', N'U') IS NOT NULL DROP TABLE dbo.TowAuditLogs;
IF OBJECT_ID(N'dbo.TowRequests', N'U') IS NOT NULL DROP TABLE dbo.TowRequests;
IF OBJECT_ID(N'dbo.PolicyQuotaTiers', N'U') IS NOT NULL DROP TABLE dbo.PolicyQuotaTiers;
IF OBJECT_ID(N'dbo.InsurancePolicies', N'U') IS NOT NULL DROP TABLE dbo.InsurancePolicies;
IF OBJECT_ID(N'dbo.TowTrucks', N'U') IS NOT NULL DROP TABLE dbo.TowTrucks;
IF OBJECT_ID(N'dbo.Customers', N'U') IS NOT NULL DROP TABLE dbo.Customers;
IF OBJECT_ID(N'dbo.PlateCodes', N'U') IS NOT NULL DROP TABLE dbo.PlateCodes;
IF OBJECT_ID(N'dbo.InsuranceProviders', N'U') IS NOT NULL DROP TABLE dbo.InsuranceProviders;
GO

/*==============================================================================
  1. TABLE: dbo.InsuranceProviders
  Stores partner insurance companies (e.g., Bankers, Fidelity, AXA, LIA Assurex)
==============================================================================*/
CREATE TABLE dbo.InsuranceProviders
(
    ProviderId      INT IDENTITY(1,1) NOT NULL,
    ProviderName    NVARCHAR(100)     NOT NULL,
    SupportPhone    VARCHAR(30)       NOT NULL,
    ContractEmail   VARCHAR(120)      NOT NULL,
    IsActive        BIT               NOT NULL CONSTRAINT DF_InsuranceProviders_IsActive DEFAULT (1),
    CreatedAt       DATETIME2(0)      NOT NULL CONSTRAINT DF_InsuranceProviders_CreatedAt DEFAULT (SYSDATETIME()),

    CONSTRAINT PK_InsuranceProviders PRIMARY KEY CLUSTERED (ProviderId),
    CONSTRAINT UQ_InsuranceProviders_Name UNIQUE (ProviderName),
    CONSTRAINT CK_InsuranceProviders_Phone CHECK (LEN(LTRIM(RTRIM(SupportPhone))) >= 6)
);
GO

/*==============================================================================
  2. TABLE: dbo.PlateCodes
  Stores dynamic Lebanese license plate letter codes (B, M, G, N, S, Z, R, T, J)
==============================================================================*/
CREATE TABLE dbo.PlateCodes
(
    PlateCodeId         INT IDENTITY(1,1) NOT NULL,
    Code                VARCHAR(10)       NOT NULL,
    RegionDescription   NVARCHAR(100)     NOT NULL,
    DisplaySequence     INT               NOT NULL CONSTRAINT DF_PlateCodes_Seq DEFAULT (10),
    IsActive            BIT               NOT NULL CONSTRAINT DF_PlateCodes_IsActive DEFAULT (1),

    CONSTRAINT PK_PlateCodes PRIMARY KEY CLUSTERED (PlateCodeId),
    CONSTRAINT UQ_PlateCodes_Code UNIQUE (Code),
    CONSTRAINT CK_PlateCodes_CodeUpper CHECK (Code = UPPER(LTRIM(RTRIM(Code))) AND LEN(Code) BETWEEN 1 AND 5),
    CONSTRAINT CK_PlateCodes_Sequence CHECK (DisplaySequence > 0)
);
GO

/*==============================================================================
  3. TABLE: dbo.Customers
  Stores registered callers / insured vehicle owners
==============================================================================*/
CREATE TABLE dbo.Customers
(
    CustomerId      INT IDENTITY(1,1) NOT NULL,
    FullName        NVARCHAR(120)     NOT NULL,
    Phone           VARCHAR(30)       NOT NULL,
    Email           VARCHAR(120)      NULL,
    CreatedAt       DATETIME2(0)      NOT NULL CONSTRAINT DF_Customers_CreatedAt DEFAULT (SYSDATETIME()),

    CONSTRAINT PK_Customers PRIMARY KEY CLUSTERED (CustomerId),
    CONSTRAINT UQ_Customers_Phone UNIQUE (Phone),
    CONSTRAINT CK_Customers_PhoneLen CHECK (LEN(LTRIM(RTRIM(Phone))) >= 7)
);
GO

/*==============================================================================
  4. TABLE: dbo.InsurancePolicies
  Stores customer roadside assistance policies, validity dates & default rules
==============================================================================*/
CREATE TABLE dbo.InsurancePolicies
(
    PolicyId                INT IDENTITY(1,1) NOT NULL,
    PolicyNumber            VARCHAR(40)       NOT NULL,
    CustomerId              INT               NOT NULL,
    ProviderId              INT               NOT NULL,
    StartDate               DATE              NOT NULL,
    ExpirationDate          DATE              NOT NULL,
    DefaultAllowedKm        DECIMAL(8,2)      NOT NULL CONSTRAINT DF_Policies_DefaultKm DEFAULT (50.00),
    DefaultMinIntervalDays  INT               NOT NULL CONSTRAINT DF_Policies_DefaultCooldown DEFAULT (0),
    PolicyStatus            VARCHAR(20)       NOT NULL CONSTRAINT DF_Policies_Status DEFAULT ('Active'),
    RowVer                  ROWVERSION        NOT NULL,

    CONSTRAINT PK_InsurancePolicies PRIMARY KEY CLUSTERED (PolicyId),
    CONSTRAINT UQ_InsurancePolicies_Number UNIQUE (PolicyNumber),
    CONSTRAINT FK_InsurancePolicies_Customer FOREIGN KEY (CustomerId) REFERENCES dbo.Customers (CustomerId),
    CONSTRAINT FK_InsurancePolicies_Provider FOREIGN KEY (ProviderId) REFERENCES dbo.InsuranceProviders (ProviderId),
    CONSTRAINT CK_InsurancePolicies_Dates CHECK (ExpirationDate > StartDate),
    CONSTRAINT CK_InsurancePolicies_AllowedKm CHECK (DefaultAllowedKm > 0 AND DefaultAllowedKm <= 1000),
    CONSTRAINT CK_InsurancePolicies_Cooldown CHECK (DefaultMinIntervalDays >= 0 AND DefaultMinIntervalDays <= 365),
    CONSTRAINT CK_InsurancePolicies_Status CHECK (PolicyStatus IN ('Active', 'Expired', 'QuotaExceeded'))
);
GO

/*==============================================================================
  5. TABLE: dbo.PolicyQuotaTiers
  Ordered tiered coverage quotas consumed sequentially (Mechanical vs Accident,
  Max covered KM per tier, and Cooldown days required between tows of same type)
==============================================================================*/
CREATE TABLE dbo.PolicyQuotaTiers
(
    QuotaTierId         INT IDENTITY(1,1) NOT NULL,
    PolicyId            INT               NOT NULL,
    TierSequence        INT               NOT NULL CONSTRAINT DF_QuotaTiers_Seq DEFAULT (10),
    CoverageType        VARCHAR(20)       NOT NULL,
    AllowedTows         INT               NOT NULL,
    UsedTows            INT               NOT NULL CONSTRAINT DF_QuotaTiers_Used DEFAULT (0),
    MaxDistanceKm       DECIMAL(8,2)      NOT NULL,
    MinIntervalDays     INT               NOT NULL CONSTRAINT DF_QuotaTiers_Cooldown DEFAULT (0),
    RowVer              ROWVERSION        NOT NULL,

    CONSTRAINT PK_PolicyQuotaTiers PRIMARY KEY CLUSTERED (QuotaTierId),
    CONSTRAINT FK_PolicyQuotaTiers_Policy FOREIGN KEY (PolicyId) REFERENCES dbo.InsurancePolicies (PolicyId) ON DELETE CASCADE,
    CONSTRAINT UQ_PolicyQuotaTiers_Seq UNIQUE (PolicyId, TierSequence, CoverageType),
    CONSTRAINT CK_PolicyQuotaTiers_Seq CHECK (TierSequence > 0),
    CONSTRAINT CK_PolicyQuotaTiers_Type CHECK (CoverageType IN ('Mechanical', 'Accident', 'All')),
    CONSTRAINT CK_PolicyQuotaTiers_Allowed CHECK (AllowedTows > 0 AND AllowedTows <= 50),
    CONSTRAINT CK_PolicyQuotaTiers_Usage CHECK (UsedTows >= 0 AND UsedTows <= AllowedTows),
    CONSTRAINT CK_PolicyQuotaTiers_Distance CHECK (MaxDistanceKm > 0 AND MaxDistanceKm <= 1000),
    CONSTRAINT CK_PolicyQuotaTiers_Cooldown CHECK (MinIntervalDays >= 0 AND MinIntervalDays <= 365)
);
GO

/*==============================================================================
  6. TABLE: dbo.TowTrucks
  Stores live GPS telemetry, driver details, and fleet dispatch status
==============================================================================*/
CREATE TABLE dbo.TowTrucks
(
    TruckId             INT IDENTITY(1,1) NOT NULL,
    TruckCode           VARCHAR(20)       NOT NULL,
    LicensePlate        VARCHAR(20)       NOT NULL,
    DriverName          NVARCHAR(100)     NOT NULL,
    DriverPhone         VARCHAR(30)       NOT NULL,
    CurrentLat          DECIMAL(9,6)      NOT NULL,
    CurrentLng          DECIMAL(9,6)      NOT NULL,
    SpeedKmh            DECIMAL(5,1)      NOT NULL CONSTRAINT DF_TowTrucks_Speed DEFAULT (0.0),
    FleetStatus         VARCHAR(20)       NOT NULL CONSTRAINT DF_TowTrucks_Status DEFAULT ('Available'),
    MaxPayloadKg        INT               NOT NULL CONSTRAINT DF_TowTrucks_Payload DEFAULT (5000),
    BaseMonthlySalary   DECIMAL(10,2)     NOT NULL CONSTRAINT DF_TowTrucks_Salary DEFAULT (850.00),
    OvertimeRatePerTow  DECIMAL(8,2)      NOT NULL CONSTRAINT DF_TowTrucks_OtRate DEFAULT (15.00),
    IsWorkingOffDay     BIT               NOT NULL CONSTRAINT DF_TowTrucks_OffDay DEFAULT (0),
    LastTelemetryAt     DATETIME2(0)      NOT NULL CONSTRAINT DF_TowTrucks_Telemetry DEFAULT (SYSDATETIME()),
    RowVer              ROWVERSION        NOT NULL,

    CONSTRAINT PK_TowTrucks PRIMARY KEY CLUSTERED (TruckId),
    CONSTRAINT UQ_TowTrucks_Code UNIQUE (TruckCode),
    CONSTRAINT UQ_TowTrucks_Plate UNIQUE (LicensePlate),
    CONSTRAINT CK_TowTrucks_Lat CHECK (CurrentLat BETWEEN -90.0 AND 90.0),
    CONSTRAINT CK_TowTrucks_Lng CHECK (CurrentLng BETWEEN -180.0 AND 180.0),
    CONSTRAINT CK_TowTrucks_Speed CHECK (SpeedKmh >= 0.0 AND SpeedKmh <= 200.0),
    CONSTRAINT CK_TowTrucks_Status CHECK (FleetStatus IN ('Available', 'EnRoute', 'Towing', 'OffDuty')),
    CONSTRAINT CK_TowTrucks_Payload CHECK (MaxPayloadKg BETWEEN 1000 AND 30000),
    CONSTRAINT CK_TowTrucks_Payroll CHECK (BaseMonthlySalary >= 0 AND OvertimeRatePerTow >= 0)
);
GO

/*==============================================================================
  7. TABLE: dbo.TowRequests  (> 120,000 ROWS — FREQUENTLY QUERIED CORE TABLE)
  Stores roadside breakdown tickets, vehicle plate rules, insurance tier match,
  truck queue sequence, distance overage billing, and lifecycle status.
==============================================================================*/
CREATE TABLE dbo.TowRequests
(
    TowRequestId            INT IDENTITY(1,1) NOT NULL,
    RequestNumber           VARCHAR(30)       NOT NULL,
    CustomerId              INT               NOT NULL,
    CallerPhone             VARCHAR(30)       NOT NULL,
    PlateCodeId             INT               NULL,
    PlateDigits             VARCHAR(20)       NULL,
    NoPlate                 BIT               NOT NULL CONSTRAINT DF_TowRequests_NoPlate DEFAULT (0),
    VehiclePlate            VARCHAR(30)       NOT NULL,
    VehicleModel            NVARCHAR(80)      NOT NULL,
    IssueType               VARCHAR(20)       NOT NULL,
    IssueNotes              NVARCHAR(400)     NULL,
    PickupAddress           NVARCHAR(200)     NOT NULL,
    PickupLat               DECIMAL(9,6)      NOT NULL,
    PickupLng               DECIMAL(9,6)      NOT NULL,
    DestinationAddress      NVARCHAR(200)     NOT NULL,
    DestinationLat          DECIMAL(9,6)      NOT NULL,
    DestinationLng          DECIMAL(9,6)      NOT NULL,
    HasInsurance            BIT               NOT NULL CONSTRAINT DF_TowRequests_HasIns DEFAULT (0),
    PolicyId                INT               NULL,
    QuotaTierId             INT               NULL,
    IsOutsourced            BIT               NOT NULL CONSTRAINT DF_TowRequests_Outsourced DEFAULT (0),
    SubcontractorName       NVARCHAR(120)     NULL,
    SubcontractorFee        DECIMAL(10,2)     NOT NULL CONSTRAINT DF_TowRequests_SubFee DEFAULT (0.00),
    AssignedTruckId         INT               NULL,
    TruckPrioritySequence   INT               NOT NULL CONSTRAINT DF_TowRequests_Priority DEFAULT (10),
    ActualDistanceKm        DECIMAL(8,2)      NOT NULL,
    AllowedDistanceKm       DECIMAL(8,2)      NOT NULL CONSTRAINT DF_TowRequests_AllowedKm DEFAULT (0.00),
    OverageKm               DECIMAL(8,2)      NOT NULL CONSTRAINT DF_TowRequests_OverageKm DEFAULT (0.00),
    ExtraKmRate             DECIMAL(8,2)      NOT NULL CONSTRAINT DF_TowRequests_Rate DEFAULT (2.50),
    OverageAmount           DECIMAL(10,2)     NOT NULL CONSTRAINT DF_TowRequests_OverageAmt DEFAULT (0.00),
    CashCollected           DECIMAL(10,2)     NOT NULL CONSTRAINT DF_TowRequests_Cash DEFAULT (0.00),
    IsNightShift            BIT               NOT NULL CONSTRAINT DF_TowRequests_Night DEFAULT (0),
    Status                  VARCHAR(25)       NOT NULL CONSTRAINT DF_TowRequests_Status DEFAULT ('Draft'),
    RejectionReason         NVARCHAR(300)     NULL,
    CreatedAt               DATETIME2(0)      NOT NULL CONSTRAINT DF_TowRequests_CreatedAt DEFAULT (SYSDATETIME()),
    CompletedAt             DATETIME2(0)      NULL,
    RowVer                  ROWVERSION        NOT NULL,

    CONSTRAINT PK_TowRequests PRIMARY KEY CLUSTERED (TowRequestId),
    CONSTRAINT UQ_TowRequests_RequestNumber UNIQUE (RequestNumber),
    CONSTRAINT FK_TowRequests_Customer FOREIGN KEY (CustomerId) REFERENCES dbo.Customers (CustomerId),
    CONSTRAINT FK_TowRequests_PlateCode FOREIGN KEY (PlateCodeId) REFERENCES dbo.PlateCodes (PlateCodeId),
    CONSTRAINT FK_TowRequests_Policy FOREIGN KEY (PolicyId) REFERENCES dbo.InsurancePolicies (PolicyId),
    CONSTRAINT FK_TowRequests_QuotaTier FOREIGN KEY (QuotaTierId) REFERENCES dbo.PolicyQuotaTiers (QuotaTierId),
    CONSTRAINT FK_TowRequests_Truck FOREIGN KEY (AssignedTruckId) REFERENCES dbo.TowTrucks (TruckId),

    -- Business Rule CHECK Constraints
    CONSTRAINT CK_TowRequests_IssueType CHECK (IssueType IN ('Mechanical', 'Accident', 'Battery', 'Tire', 'Winch', 'Other')),
    CONSTRAINT CK_TowRequests_Status CHECK (Status IN ('Draft', 'PendingInsurance', 'Approved', 'InProgress', 'UnableToLoad', 'Done', 'Rejected')),
    CONSTRAINT CK_TowRequests_PlateRule CHECK (
        (NoPlate = 1 AND VehiclePlate = 'NO-PLATE')
        OR (NoPlate = 0 AND LEN(LTRIM(RTRIM(VehiclePlate))) >= 2)
    ),
    CONSTRAINT CK_TowRequests_Coords CHECK (
        PickupLat BETWEEN -90.0 AND 90.0 AND PickupLng BETWEEN -180.0 AND 180.0
        AND DestinationLat BETWEEN -90.0 AND 90.0 AND DestinationLng BETWEEN -180.0 AND 180.0
    ),
    CONSTRAINT CK_TowRequests_Priority CHECK (TruckPrioritySequence > 0),
    CONSTRAINT CK_TowRequests_Distances CHECK (
        ActualDistanceKm > 0 AND AllowedDistanceKm >= 0 AND OverageKm >= 0
    ),
    CONSTRAINT CK_TowRequests_Financials CHECK (
        ExtraKmRate >= 0 AND OverageAmount >= 0 AND CashCollected >= 0 AND SubcontractorFee >= 0
    )
);
GO

/*==============================================================================
  8. TABLE: dbo.TowAuditLogs
  Populated automatically by trigger dbo.trg_TowRequests_ImmutabilityAndAudit
==============================================================================*/
CREATE TABLE dbo.TowAuditLogs
(
    AuditId         BIGINT IDENTITY(1,1) NOT NULL,
    TowRequestId    INT                  NOT NULL,
    RequestNumber   VARCHAR(30)          NOT NULL,
    OldStatus       VARCHAR(25)          NULL,
    NewStatus       VARCHAR(25)          NOT NULL,
    ActionNote      NVARCHAR(400)        NOT NULL,
    ChangedBy       NVARCHAR(100)        NOT NULL CONSTRAINT DF_TowAuditLogs_User DEFAULT (SUSER_SNAME()),
    ChangedAt       DATETIME2(0)         NOT NULL CONSTRAINT DF_TowAuditLogs_Time DEFAULT (SYSDATETIME()),

    CONSTRAINT PK_TowAuditLogs PRIMARY KEY CLUSTERED (AuditId)
);
GO

/*==============================================================================
  PERFORMANCE INDEXES ON THE >120,000-ROW TABLE (dbo.TowRequests)
  Designed for SARGable filters with INCLUDE columns to achieve:
  - Index Seek
  - 0 Key Lookups
  - 0 Sort Operators
==============================================================================*/

-- 1. Key Index 1: Policy Cooldown & Quota History Lookup
-- Supports checking last tow date & history for a Policy + IssueType ordered by CreatedAt DESC
CREATE NONCLUSTERED INDEX IX_TowRequests_Policy_Issue_CreatedAt
ON dbo.TowRequests (PolicyId ASC, IssueType ASC, CreatedAt DESC)
INCLUDE (RequestNumber, Status, ActualDistanceKm, AllowedDistanceKm, OverageAmount, QuotaTierId, VehiclePlate);
GO

-- 2. Key Index 2: Date-Range & Status Financial/Dispatch Search on >120k rows
-- Equality on Status first, then range/sort on CreatedAt DESC, covering all report columns
CREATE NONCLUSTERED INDEX IX_TowRequests_Status_CreatedAt_Covering
ON dbo.TowRequests (Status ASC, CreatedAt DESC)
INCLUDE (
    RequestNumber, CustomerId, CallerPhone, VehiclePlate, VehicleModel,
    IssueType, PickupAddress, DestinationAddress, AssignedTruckId,
    TruckPrioritySequence, ActualDistanceKm, AllowedDistanceKm,
    OverageKm, OverageAmount, CashCollected, IsNightShift, PolicyId
);
GO

-- 3. Key Index 3: Fast Vehicle License Plate History Lookup
-- Equality on VehiclePlate, pre-sorted by CreatedAt DESC, covering ticket details
CREATE NONCLUSTERED INDEX IX_TowRequests_VehiclePlate_CreatedAt
ON dbo.TowRequests (VehiclePlate ASC, CreatedAt DESC)
INCLUDE (RequestNumber, CustomerId, CallerPhone, VehicleModel, IssueType, Status, PickupAddress, DestinationAddress, ActualDistanceKm, OverageAmount);
GO

-- 4. Key Index 4: Live Fleet Active Priority Job Queue per Truck
-- Filtered covering index specifically for active jobs ('Approved', 'InProgress') ordered by priority
CREATE NONCLUSTERED INDEX IX_TowRequests_ActiveTruckQueue
ON dbo.TowRequests (AssignedTruckId ASC, TruckPrioritySequence ASC, TowRequestId ASC)
INCLUDE (RequestNumber, VehiclePlate, VehicleModel, IssueType, Status, PickupAddress, PickupLat, PickupLng, DestinationAddress, DestinationLat, DestinationLng)
WHERE Status IN ('Approved', 'InProgress');
GO

PRINT '01_create_schema_and_indexes.sql completed successfully.';
GO
