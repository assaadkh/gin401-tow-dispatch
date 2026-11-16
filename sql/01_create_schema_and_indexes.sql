/*==============================================================================
  GIN401 - LAB PROJECT: ROADSIDE ASSISTANCE & TOWING CAD DISPATCH SYSTEM
  Script 01: Normalized 3NF Schema (16 Tables), Keys, Constraints & Covering Indexes
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
  DROP EXISTING VIEWS, FUNCTIONS, TABLES & SEQUENCES IN DEPENDENCY ORDER
------------------------------------------------------------------------------*/
IF OBJECT_ID(N'dbo.vw_DriverPayrollAndCashReport', N'V') IS NOT NULL DROP VIEW dbo.vw_DriverPayrollAndCashReport;
IF OBJECT_ID(N'dbo.vw_FleetPriorityQueueAndRankings', N'V') IS NOT NULL DROP VIEW dbo.vw_FleetPriorityQueueAndRankings;
IF OBJECT_ID(N'dbo.tvf_CheckPolicyEligibility', N'TF') IS NOT NULL DROP FUNCTION dbo.tvf_CheckPolicyEligibility;
IF OBJECT_ID(N'dbo.fn_CalculateRoadDistanceKm', N'FN') IS NOT NULL DROP FUNCTION dbo.fn_CalculateRoadDistanceKm;
IF OBJECT_ID(N'dbo.fn_CalculateStraightLineDistanceKm', N'FN') IS NOT NULL DROP FUNCTION dbo.fn_CalculateStraightLineDistanceKm;
IF OBJECT_ID(N'dbo.fn_EstimateRoadHeuristicKm', N'FN') IS NOT NULL DROP FUNCTION dbo.fn_EstimateRoadHeuristicKm;

IF OBJECT_ID(N'dbo.AuditChangeDetails', N'U') IS NOT NULL DROP TABLE dbo.AuditChangeDetails;
IF OBJECT_ID(N'dbo.AuditChangeEvents', N'U') IS NOT NULL DROP TABLE dbo.AuditChangeEvents;
IF OBJECT_ID(N'dbo.TowAuditLogs', N'U') IS NOT NULL DROP TABLE dbo.TowAuditLogs;
IF OBJECT_ID(N'dbo.InvoicePayments', N'U') IS NOT NULL DROP TABLE dbo.InvoicePayments;
IF OBJECT_ID(N'dbo.TowInvoices', N'U') IS NOT NULL DROP TABLE dbo.TowInvoices;
IF OBJECT_ID(N'dbo.TowRequests', N'U') IS NOT NULL DROP TABLE dbo.TowRequests;
IF OBJECT_ID(N'dbo.DriverTruckAssignments', N'U') IS NOT NULL DROP TABLE dbo.DriverTruckAssignments;
IF OBJECT_ID(N'dbo.PolicyQuotaTiers', N'U') IS NOT NULL DROP TABLE dbo.PolicyQuotaTiers;
IF OBJECT_ID(N'dbo.InsurancePolicies', N'U') IS NOT NULL DROP TABLE dbo.InsurancePolicies;
IF OBJECT_ID(N'dbo.Vehicles', N'U') IS NOT NULL DROP TABLE dbo.Vehicles;
IF OBJECT_ID(N'dbo.Subcontractors', N'U') IS NOT NULL DROP TABLE dbo.Subcontractors;
IF OBJECT_ID(N'dbo.Tariffs', N'U') IS NOT NULL DROP TABLE dbo.Tariffs;
IF OBJECT_ID(N'dbo.TowTrucks', N'U') IS NOT NULL DROP TABLE dbo.TowTrucks;
IF OBJECT_ID(N'dbo.Drivers', N'U') IS NOT NULL DROP TABLE dbo.Drivers;
IF OBJECT_ID(N'dbo.Customers', N'U') IS NOT NULL DROP TABLE dbo.Customers;
IF OBJECT_ID(N'dbo.PlateCodes', N'U') IS NOT NULL DROP TABLE dbo.PlateCodes;
IF OBJECT_ID(N'dbo.InsuranceProviders', N'U') IS NOT NULL DROP TABLE dbo.InsuranceProviders;
IF OBJECT_ID(N'dbo.SystemUsers', N'U') IS NOT NULL DROP TABLE dbo.SystemUsers;
IF OBJECT_ID(N'dbo.UserGroups', N'U') IS NOT NULL DROP TABLE dbo.UserGroups;

IF OBJECT_ID(N'dbo.seq_TowRequestNumber', N'SO') IS NOT NULL DROP SEQUENCE dbo.seq_TowRequestNumber;
IF OBJECT_ID(N'dbo.seq_TowInvoiceNumber', N'SO') IS NOT NULL DROP SEQUENCE dbo.seq_TowInvoiceNumber;
GO

CREATE SEQUENCE dbo.seq_TowRequestNumber AS INT START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE dbo.seq_TowInvoiceNumber AS INT START WITH 1 INCREMENT BY 1;
GO

/*==============================================================================
  1A. TABLE: dbo.UserGroups (3NF RBAC Permission Groups)
  Stores normalized operator groups and their module-level permissions so
  dbo.SystemUsers references GroupId without transitive permission duplication.
==============================================================================*/
CREATE TABLE dbo.UserGroups
(
    GroupId             INT IDENTITY(1,1) NOT NULL,
    GroupCode           VARCHAR(30)       NOT NULL,
    GroupName           NVARCHAR(80)      NOT NULL,
    Description         NVARCHAR(250)     NULL,
    CanDispatch         BIT               NOT NULL CONSTRAINT DF_UserGroups_CanDispatch DEFAULT (1),
    CanManageFleet      BIT               NOT NULL CONSTRAINT DF_UserGroups_CanManageFleet DEFAULT (0),
    CanManagePolicies   BIT               NOT NULL CONSTRAINT DF_UserGroups_CanManagePolicies DEFAULT (0),
    CanManageBilling    BIT               NOT NULL CONSTRAINT DF_UserGroups_CanManageBilling DEFAULT (0),
    CanManageUsers      BIT               NOT NULL CONSTRAINT DF_UserGroups_CanManageUsers DEFAULT (0),
    IsSystemBuiltIn     BIT               NOT NULL CONSTRAINT DF_UserGroups_BuiltIn DEFAULT (0),
    CreatedAt           DATETIME2(0)      NOT NULL CONSTRAINT DF_UserGroups_CreatedAt DEFAULT (SYSDATETIME()),

    CONSTRAINT PK_UserGroups PRIMARY KEY CLUSTERED (GroupId),
    CONSTRAINT UQ_UserGroups_Code UNIQUE (GroupCode),
    CONSTRAINT UQ_UserGroups_Name UNIQUE (GroupName)
);
GO

/*==============================================================================
  1B. TABLE: dbo.SystemUsers
  Authenticated Command Portal operators assigned to a normalized dbo.UserGroups
  record (GroupId FK). Uses self-contained bcrypt password hashes ($2a$12$...).
==============================================================================*/
CREATE TABLE dbo.SystemUsers
(
    UserId              INT IDENTITY(1,1) NOT NULL,
    Username            VARCHAR(60)       NOT NULL,
    PasswordHash        VARCHAR(255)      NOT NULL, -- Modular bcrypt hash ($2a$12$...) with embedded salt & work factor
    FullName            NVARCHAR(120)     NOT NULL,
    RoleTitle           NVARCHAR(80)      NOT NULL,
    Department          NVARCHAR(80)      NOT NULL,
    StationCode         VARCHAR(30)       NOT NULL,
    GroupId             INT               NOT NULL,
    IsActive            BIT               NOT NULL CONSTRAINT DF_SystemUsers_IsActive DEFAULT (1),
    LastLoginAt         DATETIME2(0)      NULL,

    CONSTRAINT PK_SystemUsers PRIMARY KEY CLUSTERED (UserId),
    CONSTRAINT UQ_SystemUsers_Username UNIQUE (Username),
    CONSTRAINT FK_SystemUsers_UserGroup FOREIGN KEY (GroupId) REFERENCES dbo.UserGroups (GroupId),
    CONSTRAINT CK_SystemUsers_BcryptFormat CHECK (
        PasswordHash LIKE '$2[abxy]$[0-9][0-9]$%' AND LEN(PasswordHash) = 60
    )
);
GO

/*==============================================================================
  2. TABLE: dbo.InsuranceProviders
  Stores partner insurance companies (Bankers, Fidelity, AXA, LIA Assurex, etc.)
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
  3. TABLE: dbo.PlateCodes
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
  4. TABLE: dbo.Customers
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
  5. TABLE: dbo.Vehicles
  Normalized vehicle entity separated from TowRequests (Plate, Model, Owner)
==============================================================================*/
CREATE TABLE dbo.Vehicles
(
    VehicleId       INT IDENTITY(1,1) NOT NULL,
    CustomerId      INT               NOT NULL,
    PlateCodeId     INT               NULL,
    PlateDigits     VARCHAR(20)       NULL,
    NoPlate         BIT               NOT NULL CONSTRAINT DF_Vehicles_NoPlate DEFAULT (0),
    VehiclePlate    VARCHAR(30)       NOT NULL,
    VehicleModel    NVARCHAR(80)      NOT NULL,
    CreatedAt       DATETIME2(0)      NOT NULL CONSTRAINT DF_Vehicles_CreatedAt DEFAULT (SYSDATETIME()),

    CONSTRAINT PK_Vehicles PRIMARY KEY CLUSTERED (VehicleId),
    CONSTRAINT FK_Vehicles_Customer FOREIGN KEY (CustomerId) REFERENCES dbo.Customers (CustomerId),
    CONSTRAINT FK_Vehicles_PlateCode FOREIGN KEY (PlateCodeId) REFERENCES dbo.PlateCodes (PlateCodeId),
    CONSTRAINT CK_Vehicles_PlateRule CHECK (
        (NoPlate = 1 AND VehiclePlate = 'NO-PLATE' AND PlateCodeId IS NULL)
        OR (NoPlate = 0 AND PlateCodeId IS NOT NULL AND LEN(LTRIM(RTRIM(VehiclePlate))) >= 2)
    )
);
GO

-- Registered plates are globally unique; multiple unregistered showroom cars may carry 'NO-PLATE'
CREATE UNIQUE NONCLUSTERED INDEX UX_Vehicles_RegisteredPlate
ON dbo.Vehicles (VehiclePlate ASC)
INCLUDE (VehicleModel, CustomerId, NoPlate)
WHERE NoPlate = 0;
GO

CREATE NONCLUSTERED INDEX IX_Vehicles_CustomerId
ON dbo.Vehicles (CustomerId ASC)
INCLUDE (VehiclePlate, VehicleModel, PlateCodeId, PlateDigits, NoPlate);
GO

/*==============================================================================
  6. TABLE: dbo.InsurancePolicies
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
  7. TABLE: dbo.PolicyQuotaTiers
  Ordered tiered coverage quotas consumed sequentially (Mechanical vs Accident)
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
  8. TABLE: dbo.Drivers
  Normalized driver personnel & payroll terms (separated from TowTrucks)
==============================================================================*/
CREATE TABLE dbo.Drivers
(
    DriverId            INT IDENTITY(1,1) NOT NULL,
    EmployeeCode        VARCHAR(20)       NOT NULL,
    FullName            NVARCHAR(100)     NOT NULL,
    Phone               VARCHAR(30)       NOT NULL,
    LicenseNumber       VARCHAR(40)       NOT NULL,
    BaseMonthlySalary   DECIMAL(10,2)     NOT NULL CONSTRAINT DF_Drivers_Salary DEFAULT (850.00),
    OvertimeRatePerTow  DECIMAL(8,2)      NOT NULL CONSTRAINT DF_Drivers_OtRate DEFAULT (15.00),
    IsWorkingOffDay     BIT               NOT NULL CONSTRAINT DF_Drivers_OffDay DEFAULT (0),
    DriverStatus        VARCHAR(20)       NOT NULL CONSTRAINT DF_Drivers_Status DEFAULT ('Active'),
    HiredAt             DATE              NOT NULL CONSTRAINT DF_Drivers_HiredAt DEFAULT (CAST(SYSDATETIME() AS DATE)),
    RowVer              ROWVERSION        NOT NULL,

    CONSTRAINT PK_Drivers PRIMARY KEY CLUSTERED (DriverId),
    CONSTRAINT UQ_Drivers_Code UNIQUE (EmployeeCode),
    CONSTRAINT UQ_Drivers_Phone UNIQUE (Phone),
    CONSTRAINT UQ_Drivers_License UNIQUE (LicenseNumber),
    CONSTRAINT CK_Drivers_Payroll CHECK (BaseMonthlySalary >= 0 AND OvertimeRatePerTow >= 0),
    CONSTRAINT CK_Drivers_Status CHECK (DriverStatus IN ('Active', 'OnLeave', 'Inactive'))
);
GO

/*==============================================================================
  9. TABLE: dbo.TowTrucks
  Pure fleet vehicle & live GPS telemetry attributes (zero driver attributes)
==============================================================================*/
CREATE TABLE dbo.TowTrucks
(
    TruckId             INT IDENTITY(1,1) NOT NULL,
    TruckCode           VARCHAR(20)       NOT NULL,
    LicensePlate        VARCHAR(20)       NOT NULL,
    TruckModel          NVARCHAR(80)      NOT NULL,
    MaxPayloadKg        INT               NOT NULL CONSTRAINT DF_TowTrucks_Payload DEFAULT (5000),
    CurrentLat          DECIMAL(9,6)      NOT NULL,
    CurrentLng          DECIMAL(9,6)      NOT NULL,
    SpeedKmh            DECIMAL(5,1)      NOT NULL CONSTRAINT DF_TowTrucks_Speed DEFAULT (0.0),
    FleetStatus         VARCHAR(20)       NOT NULL CONSTRAINT DF_TowTrucks_Status DEFAULT ('Available'),
    LastTelemetryAt     DATETIME2(0)      NOT NULL CONSTRAINT DF_TowTrucks_Telemetry DEFAULT (SYSDATETIME()),
    RowVer              ROWVERSION        NOT NULL,

    CONSTRAINT PK_TowTrucks PRIMARY KEY CLUSTERED (TruckId),
    CONSTRAINT UQ_TowTrucks_Code UNIQUE (TruckCode),
    CONSTRAINT UQ_TowTrucks_Plate UNIQUE (LicensePlate),
    CONSTRAINT CK_TowTrucks_Lat CHECK (CurrentLat BETWEEN -90.0 AND 90.0),
    CONSTRAINT CK_TowTrucks_Lng CHECK (CurrentLng BETWEEN -180.0 AND 180.0),
    CONSTRAINT CK_TowTrucks_Speed CHECK (SpeedKmh >= 0.0 AND SpeedKmh <= 200.0),
    CONSTRAINT CK_TowTrucks_Status CHECK (FleetStatus IN ('Available', 'EnRoute', 'Towing', 'OffDuty', 'Maintenance')),
    CONSTRAINT CK_TowTrucks_Payload CHECK (MaxPayloadKg BETWEEN 1000 AND 30000)
);
GO

/*==============================================================================
  10. TABLE: dbo.DriverTruckAssignments
  Tracks active and historical assignments when drivers change trucks
==============================================================================*/
CREATE TABLE dbo.DriverTruckAssignments
(
    AssignmentId        INT IDENTITY(1,1) NOT NULL,
    DriverId            INT               NOT NULL,
    TruckId             INT               NOT NULL,
    StartDate           DATETIME2(0)      NOT NULL CONSTRAINT DF_DriverTruckAssignments_Start DEFAULT (SYSDATETIME()),
    EndDate             DATETIME2(0)      NULL,
    AssignmentNotes     NVARCHAR(200)     NULL,

    CONSTRAINT PK_DriverTruckAssignments PRIMARY KEY CLUSTERED (AssignmentId),
    CONSTRAINT FK_DriverTruckAssignments_Driver FOREIGN KEY (DriverId) REFERENCES dbo.Drivers (DriverId),
    CONSTRAINT FK_DriverTruckAssignments_Truck FOREIGN KEY (TruckId) REFERENCES dbo.TowTrucks (TruckId),
    CONSTRAINT CK_DriverTruckAssignments_Dates CHECK (EndDate IS NULL OR EndDate >= StartDate)
);
GO

-- Filtered unique indexes ensure at most 1 active driver per truck and 1 active truck per driver
CREATE UNIQUE NONCLUSTERED INDEX UX_DriverTruckAssignments_ActiveTruck
ON dbo.DriverTruckAssignments (TruckId ASC)
INCLUDE (DriverId, StartDate)
WHERE EndDate IS NULL;
GO

CREATE UNIQUE NONCLUSTERED INDEX UX_DriverTruckAssignments_ActiveDriver
ON dbo.DriverTruckAssignments (DriverId ASC)
INCLUDE (TruckId, StartDate)
WHERE EndDate IS NULL;
GO

CREATE NONCLUSTERED INDEX IX_DriverTruckAssignments_History
ON dbo.DriverTruckAssignments (TruckId ASC, StartDate DESC)
INCLUDE (DriverId, EndDate, AssignmentNotes);
GO

/*==============================================================================
  11. TABLE: dbo.Subcontractors
  Normalized external towing partners for outsourced recoveries
==============================================================================*/
CREATE TABLE dbo.Subcontractors
(
    SubcontractorId     INT IDENTITY(1,1) NOT NULL,
    CompanyName         NVARCHAR(120)     NOT NULL,
    ContactPerson       NVARCHAR(100)     NULL,
    Phone               VARCHAR(30)       NOT NULL,
    CoverageRegion      NVARCHAR(100)     NOT NULL,
    DefaultDispatchFee  DECIMAL(10,2)     NOT NULL CONSTRAINT DF_Subcontractors_Fee DEFAULT (45.00),
    IsActive            BIT               NOT NULL CONSTRAINT DF_Subcontractors_IsActive DEFAULT (1),
    CreatedAt           DATETIME2(0)      NOT NULL CONSTRAINT DF_Subcontractors_CreatedAt DEFAULT (SYSDATETIME()),

    CONSTRAINT PK_Subcontractors PRIMARY KEY CLUSTERED (SubcontractorId),
    CONSTRAINT UQ_Subcontractors_Name UNIQUE (CompanyName),
    CONSTRAINT CK_Subcontractors_Fee CHECK (DefaultDispatchFee >= 0)
);
GO

/*==============================================================================
  12. TABLE: dbo.Tariffs
  Historical & active pricing rules (base fee, price/km, night surcharge, dates)
==============================================================================*/
CREATE TABLE dbo.Tariffs
(
    TariffId            INT IDENTITY(1,1) NOT NULL,
    TariffCode          VARCHAR(30)       NOT NULL,
    TariffName          NVARCHAR(100)     NOT NULL,
    ServiceCategory     VARCHAR(20)       NOT NULL CONSTRAINT DF_Tariffs_Category DEFAULT ('All'),
    BaseFee             DECIMAL(10,2)     NOT NULL,
    PricePerKm          DECIMAL(8,2)      NOT NULL,
    NightSurcharge      DECIMAL(10,2)     NOT NULL,
    EffectiveFrom       DATE              NOT NULL,
    EffectiveTo         DATE              NULL,
    IsActive            BIT               NOT NULL CONSTRAINT DF_Tariffs_IsActive DEFAULT (1),
    CreatedAt           DATETIME2(0)      NOT NULL CONSTRAINT DF_Tariffs_CreatedAt DEFAULT (SYSDATETIME()),

    CONSTRAINT PK_Tariffs PRIMARY KEY CLUSTERED (TariffId),
    CONSTRAINT UQ_Tariffs_Code UNIQUE (TariffCode),
    CONSTRAINT CK_Tariffs_Category CHECK (ServiceCategory IN ('Mechanical', 'Accident', 'All')),
    CONSTRAINT CK_Tariffs_Amounts CHECK (BaseFee >= 0 AND PricePerKm >= 0 AND NightSurcharge >= 0),
    CONSTRAINT CK_Tariffs_Dates CHECK (EffectiveTo IS NULL OR EffectiveTo >= EffectiveFrom)
);
GO

CREATE NONCLUSTERED INDEX IX_Tariffs_EffectiveLookup
ON dbo.Tariffs (ServiceCategory ASC, EffectiveFrom DESC)
INCLUDE (TariffCode, TariffName, BaseFee, PricePerKm, NightSurcharge, EffectiveTo, IsActive);
GO

/*==============================================================================
  13. TABLE: dbo.TowRequests  (> 120,000 ROWS — NORMALIZED CORE DISPATCH TABLE)
  Stores purely operational dispatch lifecycle, route distance provenance, and
  foreign keys to Customers, Vehicles, InsurancePolicies, TowTrucks, Drivers,
  and Subcontractors. Pricing & billing live in dbo.TowInvoices.
==============================================================================*/
CREATE TABLE dbo.TowRequests
(
    TowRequestId            INT IDENTITY(1,1) NOT NULL,
    RequestNumber           VARCHAR(30)       NOT NULL,
    CustomerId              INT               NOT NULL,
    VehicleId               INT               NOT NULL,
    CallerPhone             VARCHAR(30)       NOT NULL,
    IssueType               VARCHAR(20)       NOT NULL,
    IssueNotes              NVARCHAR(400)     NULL,
    PickupAddress           NVARCHAR(200)     NOT NULL,
    PickupLat               DECIMAL(9,6)      NOT NULL,
    PickupLng               DECIMAL(9,6)      NOT NULL,
    DestinationAddress      NVARCHAR(200)     NOT NULL,
    DestinationLat          DECIMAL(9,6)      NOT NULL,
    DestinationLng          DECIMAL(9,6)      NOT NULL,
    StraightLineDistanceKm  DECIMAL(8,2)      NOT NULL,
    RouteDistanceKm         DECIMAL(8,2)      NOT NULL,
    DistanceSource          VARCHAR(30)       NOT NULL,
    RouteDurationMinutes    DECIMAL(6,1)      NULL,
    PolicyId                INT               NULL,
    QuotaTierId             INT               NULL,
    AssignedTruckId         INT               NULL,
    AssignedDriverId        INT               NULL,
    SubcontractorId         INT               NULL,
    TruckPrioritySequence   INT               NOT NULL CONSTRAINT DF_TowRequests_Priority DEFAULT (10),
    IsNightShift            BIT               NOT NULL CONSTRAINT DF_TowRequests_Night DEFAULT (0),
    Status                  VARCHAR(25)       NOT NULL CONSTRAINT DF_TowRequests_Status DEFAULT ('Draft'),
    RejectionReason         NVARCHAR(300)     NULL,
    CreatedByUserId         INT               NULL,
    CreatedAt               DATETIME2(0)      NOT NULL CONSTRAINT DF_TowRequests_CreatedAt DEFAULT (SYSDATETIME()),
    CompletedAt             DATETIME2(0)      NULL,
    RowVer                  ROWVERSION        NOT NULL,

    CONSTRAINT PK_TowRequests PRIMARY KEY CLUSTERED (TowRequestId),
    CONSTRAINT UQ_TowRequests_RequestNumber UNIQUE (RequestNumber),
    CONSTRAINT FK_TowRequests_Customer FOREIGN KEY (CustomerId) REFERENCES dbo.Customers (CustomerId),
    CONSTRAINT FK_TowRequests_Vehicle FOREIGN KEY (VehicleId) REFERENCES dbo.Vehicles (VehicleId),
    CONSTRAINT FK_TowRequests_Policy FOREIGN KEY (PolicyId) REFERENCES dbo.InsurancePolicies (PolicyId),
    CONSTRAINT FK_TowRequests_QuotaTier FOREIGN KEY (QuotaTierId) REFERENCES dbo.PolicyQuotaTiers (QuotaTierId),
    CONSTRAINT FK_TowRequests_Truck FOREIGN KEY (AssignedTruckId) REFERENCES dbo.TowTrucks (TruckId),
    CONSTRAINT FK_TowRequests_Driver FOREIGN KEY (AssignedDriverId) REFERENCES dbo.Drivers (DriverId),
    CONSTRAINT FK_TowRequests_Subcontractor FOREIGN KEY (SubcontractorId) REFERENCES dbo.Subcontractors (SubcontractorId),
    CONSTRAINT FK_TowRequests_CreatedByUser FOREIGN KEY (CreatedByUserId) REFERENCES dbo.SystemUsers (UserId),

    CONSTRAINT CK_TowRequests_IssueType CHECK (IssueType IN ('Mechanical', 'Accident', 'Battery', 'Tire', 'Winch', 'Other')),
    CONSTRAINT CK_TowRequests_Status CHECK (Status IN ('Draft', 'PendingInsurance', 'Approved', 'InProgress', 'UnableToLoad', 'Done', 'Rejected')),
    CONSTRAINT CK_TowRequests_Coords CHECK (
        PickupLat BETWEEN -90.0 AND 90.0 AND PickupLng BETWEEN -180.0 AND 180.0
        AND DestinationLat BETWEEN -90.0 AND 90.0 AND DestinationLng BETWEEN -180.0 AND 180.0
    ),
    CONSTRAINT CK_TowRequests_DistanceSource CHECK (
        DistanceSource IN ('OSRM_DrivingRoute', 'DispatcherVerifiedEstimate', 'HeuristicFallbackEstimate')
    ),
    CONSTRAINT CK_TowRequests_Distances CHECK (
        StraightLineDistanceKm >= 0.00
        AND RouteDistanceKm > 0.00
        AND RouteDistanceKm >= ROUND(StraightLineDistanceKm * 0.95, 2)
        AND RouteDistanceKm <= 1000.00
    ),
    CONSTRAINT CK_TowRequests_DispatchExclusivity CHECK (
        NOT (AssignedTruckId IS NOT NULL AND SubcontractorId IS NOT NULL)
    ),
    CONSTRAINT CK_TowRequests_Priority CHECK (TruckPrioritySequence > 0)
);
GO

/*==============================================================================
  14. TABLE: dbo.TowInvoices
  Stores historical tariff pricing snapshot and separates Insurer obligations
  from Customer obligations so tariff updates never alter past invoices.
==============================================================================*/
CREATE TABLE dbo.TowInvoices
(
    InvoiceId               INT IDENTITY(1,1) NOT NULL,
    InvoiceNumber           VARCHAR(30)       NOT NULL,
    TowRequestId            INT               NOT NULL,
    TariffId                INT               NOT NULL,
    InsuranceProviderId     INT               NULL,
    CustomerId              INT               NOT NULL,
    AppliedBaseFee          DECIMAL(10,2)     NOT NULL,
    AppliedPricePerKm       DECIMAL(8,2)      NOT NULL,
    AppliedNightSurcharge   DECIMAL(10,2)     NOT NULL,
    CoveredDistanceKm       DECIMAL(8,2)      NOT NULL CONSTRAINT DF_TowInvoices_CoveredKm DEFAULT (0.00),
    OverageDistanceKm       DECIMAL(8,2)      NOT NULL CONSTRAINT DF_TowInvoices_OverageKm DEFAULT (0.00),
    SubcontractorCost       DECIMAL(10,2)     NOT NULL CONSTRAINT DF_TowInvoices_SubCost DEFAULT (0.00),
    InsurerBilledAmount     DECIMAL(10,2)     NOT NULL CONSTRAINT DF_TowInvoices_InsBilled DEFAULT (0.00),
    CustomerBilledAmount    DECIMAL(10,2)     NOT NULL CONSTRAINT DF_TowInvoices_CustBilled DEFAULT (0.00),
    TotalAmount             DECIMAL(10,2)     NOT NULL,
    InsurerPaidAmount       DECIMAL(10,2)     NOT NULL CONSTRAINT DF_TowInvoices_InsPaid DEFAULT (0.00),
    CustomerPaidAmount      DECIMAL(10,2)     NOT NULL CONSTRAINT DF_TowInvoices_CustPaid DEFAULT (0.00),
    InvoiceStatus           VARCHAR(20)       NOT NULL CONSTRAINT DF_TowInvoices_Status DEFAULT ('Unpaid'),
    IssuedAt                DATETIME2(0)      NOT NULL CONSTRAINT DF_TowInvoices_IssuedAt DEFAULT (SYSDATETIME()),
    RowVer                  ROWVERSION        NOT NULL,

    CONSTRAINT PK_TowInvoices PRIMARY KEY CLUSTERED (InvoiceId),
    CONSTRAINT UQ_TowInvoices_Number UNIQUE (InvoiceNumber),
    CONSTRAINT FK_TowInvoices_TowRequest FOREIGN KEY (TowRequestId) REFERENCES dbo.TowRequests (TowRequestId),
    CONSTRAINT FK_TowInvoices_Tariff FOREIGN KEY (TariffId) REFERENCES dbo.Tariffs (TariffId),
    CONSTRAINT FK_TowInvoices_Provider FOREIGN KEY (InsuranceProviderId) REFERENCES dbo.InsuranceProviders (ProviderId),
    CONSTRAINT FK_TowInvoices_Customer FOREIGN KEY (CustomerId) REFERENCES dbo.Customers (CustomerId),

    CONSTRAINT CK_TowInvoices_NonNegative CHECK (
        AppliedBaseFee >= 0 AND AppliedPricePerKm >= 0 AND AppliedNightSurcharge >= 0
        AND CoveredDistanceKm >= 0 AND OverageDistanceKm >= 0 AND SubcontractorCost >= 0
    ),
    CONSTRAINT CK_TowInvoices_SplitTotal CHECK (
        TotalAmount = InsurerBilledAmount + CustomerBilledAmount
    ),
    CONSTRAINT CK_TowInvoices_InsurerPaid CHECK (
        InsurerPaidAmount >= 0 AND InsurerPaidAmount <= InsurerBilledAmount
    ),
    CONSTRAINT CK_TowInvoices_CustomerPaid CHECK (
        CustomerPaidAmount >= 0 AND CustomerPaidAmount <= CustomerBilledAmount
    ),
    CONSTRAINT CK_TowInvoices_Status CHECK (
        InvoiceStatus IN ('Draft', 'Unpaid', 'PartiallyPaid', 'Paid', 'Void')
    )
);
GO

CREATE UNIQUE NONCLUSTERED INDEX UX_TowInvoices_TowRequestId_Covering
ON dbo.TowInvoices (TowRequestId ASC)
INCLUDE (
    InvoiceNumber, TariffId, InsuranceProviderId, CustomerId,
    AppliedBaseFee, AppliedPricePerKm, AppliedNightSurcharge,
    CoveredDistanceKm, OverageDistanceKm, SubcontractorCost,
    InsurerBilledAmount, CustomerBilledAmount, TotalAmount,
    InsurerPaidAmount, CustomerPaidAmount, InvoiceStatus
);
GO

/*==============================================================================
  15. TABLE: dbo.InvoicePayments
  Tracks individual payment transactions linked to the relevant Invoice & Payer.
  Each partial or full payment (from Insurer or Customer) is its own row.
==============================================================================*/
CREATE TABLE dbo.InvoicePayments
(
    PaymentId               BIGINT IDENTITY(1,1) NOT NULL,
    InvoiceId               INT                  NOT NULL,
    PayerType               VARCHAR(20)          NOT NULL,
    InsuranceProviderId     INT                  NULL,
    CustomerId              INT                  NULL,
    CollectedByDriverId     INT                  NULL,
    AmountPaid              DECIMAL(10,2)        NOT NULL,
    PaymentMethod           VARCHAR(30)          NOT NULL,
    ReferenceNumber         VARCHAR(60)          NULL,
    PaidAt                  DATETIME2(0)         NOT NULL CONSTRAINT DF_InvoicePayments_PaidAt DEFAULT (SYSDATETIME()),
    RecordedByUserId        INT                  NULL,
    Notes                   NVARCHAR(200)        NULL,

    CONSTRAINT PK_InvoicePayments PRIMARY KEY CLUSTERED (PaymentId),
    CONSTRAINT FK_InvoicePayments_Invoice FOREIGN KEY (InvoiceId) REFERENCES dbo.TowInvoices (InvoiceId),
    CONSTRAINT FK_InvoicePayments_Provider FOREIGN KEY (InsuranceProviderId) REFERENCES dbo.InsuranceProviders (ProviderId),
    CONSTRAINT FK_InvoicePayments_Customer FOREIGN KEY (CustomerId) REFERENCES dbo.Customers (CustomerId),
    CONSTRAINT FK_InvoicePayments_Driver FOREIGN KEY (CollectedByDriverId) REFERENCES dbo.Drivers (DriverId),
    CONSTRAINT FK_InvoicePayments_RecordedBy FOREIGN KEY (RecordedByUserId) REFERENCES dbo.SystemUsers (UserId),

    CONSTRAINT CK_InvoicePayments_PayerType CHECK (PayerType IN ('InsuranceProvider', 'Customer')),
    CONSTRAINT CK_InvoicePayments_PayerLink CHECK (
        (PayerType = 'InsuranceProvider' AND InsuranceProviderId IS NOT NULL AND CustomerId IS NULL)
        OR (PayerType = 'Customer' AND CustomerId IS NOT NULL AND InsuranceProviderId IS NULL)
    ),
    CONSTRAINT CK_InvoicePayments_Amount CHECK (AmountPaid > 0),
    CONSTRAINT CK_InvoicePayments_Method CHECK (
        PaymentMethod IN ('OnSceneCash', 'BankTransfer', 'Card', 'Cheque', 'InsurerBatchSettlement')
    )
);
GO

CREATE NONCLUSTERED INDEX IX_InvoicePayments_InvoiceId
ON dbo.InvoicePayments (InvoiceId ASC, PaidAt DESC)
INCLUDE (PayerType, InsuranceProviderId, CustomerId, CollectedByDriverId, AmountPaid, PaymentMethod, ReferenceNumber);
GO

CREATE NONCLUSTERED INDEX IX_InvoicePayments_DriverCash
ON dbo.InvoicePayments (CollectedByDriverId ASC, PaidAt ASC)
INCLUDE (AmountPaid)
WHERE PaymentMethod = 'OnSceneCash' AND CollectedByDriverId IS NOT NULL;
GO

/*==============================================================================
  16. TABLE: dbo.TowAuditLogs
  Populated automatically by trigger dbo.trg_TowRequests_ImmutabilityAndAudit.
  Records the actual authenticated dispatcher from SQL Server SESSION_CONTEXT.
==============================================================================*/
CREATE TABLE dbo.TowAuditLogs
(
    AuditId             BIGINT IDENTITY(1,1) NOT NULL,
    TowRequestId        INT                  NOT NULL,
    RequestNumber       VARCHAR(30)          NOT NULL,
    OldStatus           VARCHAR(25)          NULL,
    NewStatus           VARCHAR(25)          NOT NULL,
    ActionNote          NVARCHAR(400)        NOT NULL,
    DispatcherUserId    INT                  NULL,
    DispatcherUsername  VARCHAR(60)          NOT NULL,
    DispatcherFullName  NVARCHAR(120)        NULL,
    SqlLoginName        NVARCHAR(128)        NOT NULL CONSTRAINT DF_TowAuditLogs_SqlLogin DEFAULT (SUSER_SNAME()),
    ChangedAt           DATETIME2(0)         NOT NULL CONSTRAINT DF_TowAuditLogs_Time DEFAULT (SYSDATETIME()),

    CONSTRAINT PK_TowAuditLogs PRIMARY KEY CLUSTERED (AuditId),
    CONSTRAINT FK_TowAuditLogs_DispatcherUser FOREIGN KEY (DispatcherUserId) REFERENCES dbo.SystemUsers (UserId)
);
GO

/*==============================================================================
  REVISED COVERING INDEXES ON THE >120,000-ROW NORMALIZED TABLE (dbo.TowRequests)
  Designed for SARGable predicates and normalized joins with Vehicles & TowInvoices
==============================================================================*/

-- 1. Key Index 1: Policy Cooldown & Quota History Lookup
CREATE NONCLUSTERED INDEX IX_TowRequests_Policy_Issue_CreatedAt
ON dbo.TowRequests (PolicyId ASC, IssueType ASC, CreatedAt DESC)
INCLUDE (RequestNumber, VehicleId, CustomerId, Status, RouteDistanceKm, DistanceSource, QuotaTierId);
GO

-- 2. Key Index 2: Date-Range & Status Dispatch/Financial Report on >120k rows
CREATE NONCLUSTERED INDEX IX_TowRequests_Status_CreatedAt_Covering
ON dbo.TowRequests (Status ASC, CreatedAt DESC)
INCLUDE (
    RequestNumber, CustomerId, VehicleId, PolicyId,
    AssignedTruckId, AssignedDriverId, SubcontractorId,
    IssueType, RouteDistanceKm, DistanceSource, IsNightShift
);
GO

-- 3. Key Index 3: Normalized Vehicle History Lookup (paired with UX_Vehicles_RegisteredPlate)
CREATE NONCLUSTERED INDEX IX_TowRequests_VehicleId_CreatedAt
ON dbo.TowRequests (VehicleId ASC, CreatedAt DESC)
INCLUDE (
    RequestNumber, CustomerId, PolicyId, IssueType, Status,
    PickupAddress, DestinationAddress, RouteDistanceKm, DistanceSource
);
GO

-- 4. Key Index 4: Live Fleet Active Priority Job Queue per Truck
CREATE NONCLUSTERED INDEX IX_TowRequests_ActiveTruckQueue
ON dbo.TowRequests (AssignedTruckId ASC, TruckPrioritySequence ASC, TowRequestId ASC)
INCLUDE (
    RequestNumber, VehicleId, CustomerId, AssignedDriverId, IssueType, Status,
    PickupAddress, PickupLat, PickupLng, DestinationAddress, DestinationLat, DestinationLng, RouteDistanceKm
)
WHERE Status IN ('Approved', 'InProgress');
GO

-- 5. Key Index 5: Driver Payroll Monthly Aggregation
CREATE NONCLUSTERED INDEX IX_TowRequests_DriverPayroll
ON dbo.TowRequests (AssignedDriverId ASC, Status ASC, CreatedAt ASC)
INCLUDE (IsNightShift);
GO

/*==============================================================================
  17 & 18. NORMALIZED 3NF SYSTEM-WIDE CHANGE LOG TABLES
  - dbo.AuditChangeEvents: Event header (EntityType, EntityId, OperationType,
    ChangedByUserId FK -> dbo.SystemUsers via SESSION_CONTEXT, ChangedAt)
  - dbo.AuditChangeDetails: Atomic 1:N field-level diffs (FieldName, OldValue,
    NewValue) with zero JSON blobs or denormalized operator text columns.
==============================================================================*/
CREATE TABLE dbo.AuditChangeEvents
(
    ChangeEventId       BIGINT IDENTITY(1,1) NOT NULL,
    EntityType          VARCHAR(40)          NOT NULL,
    EntityId            BIGINT               NOT NULL,
    EntityCode          VARCHAR(100)         NULL,
    OperationType       VARCHAR(16)          NOT NULL,
    ChangedByUserId     INT                  NULL,
    SqlLoginName        NVARCHAR(128)        NOT NULL CONSTRAINT DF_AuditChangeEvents_SqlLogin DEFAULT (SUSER_SNAME()),
    ChangedAt           DATETIME2(3)         NOT NULL CONSTRAINT DF_AuditChangeEvents_ChangedAt DEFAULT (SYSDATETIME()),

    CONSTRAINT PK_AuditChangeEvents PRIMARY KEY CLUSTERED (ChangeEventId),
    CONSTRAINT FK_AuditChangeEvents_User FOREIGN KEY (ChangedByUserId) REFERENCES dbo.SystemUsers (UserId),
    CONSTRAINT CK_AuditChangeEvents_Op CHECK (OperationType IN ('CREATE', 'UPDATE', 'DELETE'))
);
GO

CREATE NONCLUSTERED INDEX IX_AuditChangeEvents_Entity_ChangedAt
ON dbo.AuditChangeEvents (EntityType ASC, EntityId ASC, ChangedAt DESC)
INCLUDE (EntityCode, OperationType, ChangedByUserId, SqlLoginName);
GO

CREATE NONCLUSTERED INDEX IX_AuditChangeEvents_ChangedAt
ON dbo.AuditChangeEvents (ChangedAt DESC)
INCLUDE (EntityType, EntityId, EntityCode, OperationType, ChangedByUserId, SqlLoginName);
GO

CREATE TABLE dbo.AuditChangeDetails
(
    ChangeDetailId      BIGINT IDENTITY(1,1) NOT NULL,
    ChangeEventId       BIGINT               NOT NULL,
    FieldName           VARCHAR(64)          NOT NULL,
    OldValue            NVARCHAR(400)        NULL,
    NewValue            NVARCHAR(400)        NULL,

    CONSTRAINT PK_AuditChangeDetails PRIMARY KEY CLUSTERED (ChangeDetailId),
    CONSTRAINT FK_AuditChangeDetails_Event FOREIGN KEY (ChangeEventId)
        REFERENCES dbo.AuditChangeEvents (ChangeEventId) ON DELETE CASCADE
);
GO

CREATE NONCLUSTERED INDEX IX_AuditChangeDetails_EventId
ON dbo.AuditChangeDetails (ChangeEventId ASC)
INCLUDE (FieldName, OldValue, NewValue);
GO

PRINT '01_create_schema_and_indexes.sql completed successfully (18 normalized 3NF tables).';
GO
