/*==============================================================================
  GIN401 - LAB PROJECT: ROADSIDE ASSISTANCE & TOWING CAD DISPATCH SYSTEM
  Script 03: Seed Reference Data + Generate > 120,000 Rows in dbo.TowRequests
  DBMS: Microsoft SQL Server
==============================================================================*/
SET NOCOUNT ON;
USE GIN401_TowDispatch;
GO
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

/*------------------------------------------------------------------------------
  1. SEED INSURANCE PROVIDERS
------------------------------------------------------------------------------*/
INSERT INTO dbo.InsuranceProviders (ProviderName, SupportPhone, ContractEmail)
VALUES
    (N'Bankers Assurance SAL',     '+961-1-200500', 'roadside@bankers.com.lb'),
    (N'Fidelity Insurance Group',  '+961-1-399400', 'claims@fidelity.com.lb'),
    (N'AXA Middle East SAL',       '+961-4-727000', 'assistance@axa-middleeast.com'),
    (N'LIA Assurex SAL',           '+961-1-982000', 'dispatch@liaassurex.com'),
    (N'Allianz SNA Lebanon',       '+961-1-429000', 'towing@allianzsna.com'),
    (N'Medgulf Insurance SAL',     '+961-1-994400', 'support@medgulf.com.lb');
GO

/*------------------------------------------------------------------------------
  2. SEED LEBANESE PLATE CODES
------------------------------------------------------------------------------*/
INSERT INTO dbo.PlateCodes (Code, RegionDescription, DisplaySequence, IsActive)
VALUES
    ('B', N'Beirut (Capital)',              10, 1),
    ('M', N'Metn / Mount Lebanon North',    20, 1),
    ('G', N'Mount Lebanon (Baabda/Aley)',   30, 1),
    ('J', N'Jounieh / Keserwan',            40, 1),
    ('N', N'North Lebanon (Tripoli/Koura)', 50, 1),
    ('S', N'South Lebanon (Sidon/Tyre)',    60, 1),
    ('Z', N'Bekaa Valley (Zahle)',          70, 1),
    ('R', N'Rental Vehicle',                80, 1),
    ('T', N'Public Transport / Taxi',       90, 1);
GO

/*------------------------------------------------------------------------------
  3. SEED CUSTOMERS (200 REGISTERED CALLERS)
------------------------------------------------------------------------------*/
INSERT INTO dbo.Customers (FullName, Phone, Email)
VALUES
    (N'Assaad Khalife',   '+961-03-111222', 'assaad.khalife@uni.edu.lb'),
    (N'Charbel Mansour',  '+961-70-222333', 'charbel.mansour@gmail.com'),
    (N'Elie Frem',        '+961-71-333444', 'elie.frem@outlook.com'),
    (N'Nadine Khoury',    '+961-03-444555', 'nadine.khoury@gmail.com'),
    (N'Roudy Tanios',     '+961-76-555666', 'roudy.tanios@gmail.com'),
    (N'Jean Mkhaiber',    '+961-03-666777', 'jean.mkhaiber@gmail.com'),
    (N'Maya Gemayel',     '+961-70-777888', 'maya.gemayel@yahoo.com'),
    (N'Tarek Harb',       '+961-71-888999', 'tarek.harb@gmail.com');

-- Generate 192 additional customers (Total = 200 Customers)
;WITH Nums AS (
    SELECT TOP (192) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) + 8 AS n
    FROM sys.all_objects
)
INSERT INTO dbo.Customers (FullName, Phone, Email)
SELECT
    CONCAT(
        CHOOSE((n % 10) + 1, N'Karim ', N'Jad ', N'Rami ', N'Sami ', N'Ziad ', N'Lara ', N'Rita ', N'Celine ', N'Georges ', N'Marwan '),
        CHOOSE(((n / 10) % 10) + 1, N'Haddad', N'Abi Rached', N'Nassar', N'Boustany', N'Karam', N'Sarkis', N'Chahine', N'Saliba', N'Aoun', N'Rizk'),
        N' #', n
    ),
    CONCAT('+961-70-', FORMAT(100000 + n, '000000')),
    CONCAT('customer', n, '@lebanon-mail.lb')
FROM Nums;
GO

/*------------------------------------------------------------------------------
  4. SEED INSURANCE POLICIES & SEQUENTIAL QUOTA TIERS
------------------------------------------------------------------------------*/
-- Policy 1: VIP Policy with Multi-Tier Sequential Coverage (Tier 1: 2x Mechanical 50KM, Tier 2: 2x Mechanical 100KM, Tier 3: 1x Accident 80KM)
INSERT INTO dbo.InsurancePolicies (PolicyNumber, CustomerId, ProviderId, StartDate, ExpirationDate, DefaultAllowedKm, DefaultMinIntervalDays, PolicyStatus)
VALUES ('POL-2026-VIP001', 1, 1, '2026-01-01', '2027-06-30', 50.00, 0, 'Active');

INSERT INTO dbo.PolicyQuotaTiers (PolicyId, TierSequence, CoverageType, AllowedTows, UsedTows, MaxDistanceKm, MinIntervalDays)
VALUES
    (1, 10, 'Mechanical', 2, 1, 50.00, 0),   -- 1 Mechanical left in Tier 1 (50 KM)
    (1, 20, 'Mechanical', 2, 0, 100.00, 0),  -- 2 Mechanical left in Tier 2 (100 KM)
    (1, 30, 'Accident',   2, 0, 80.00, 0);   -- 2 Accident left in Tier 3 (80 KM)

-- Policy 2: CONCURRENCY RACE TEST POLICY (Exactly 1 Accident Tow Remaining!)
INSERT INTO dbo.InsurancePolicies (PolicyNumber, CustomerId, ProviderId, StartDate, ExpirationDate, DefaultAllowedKm, DefaultMinIntervalDays, PolicyStatus)
VALUES ('POL-2026-ACC-LAST1', 2, 2, '2026-01-01', '2027-06-30', 60.00, 0, 'Active');

INSERT INTO dbo.PolicyQuotaTiers (PolicyId, TierSequence, CoverageType, AllowedTows, UsedTows, MaxDistanceKm, MinIntervalDays)
VALUES
    (2, 10, 'Mechanical', 3, 1, 60.00, 0),
    (2, 20, 'Accident',   2, 1, 75.00, 0);   -- ONLY 1 ACCIDENT TOW LEFT! (2 Allowed, 1 Used)

-- Policy 3: COOLDOWN INTERVAL RESTRICTION POLICY (Requires 7 Days Between Mechanical Tows)
INSERT INTO dbo.InsurancePolicies (PolicyNumber, CustomerId, ProviderId, StartDate, ExpirationDate, DefaultAllowedKm, DefaultMinIntervalDays, PolicyStatus)
VALUES ('POL-2026-COOLDOWN7', 3, 3, '2026-01-01', '2027-06-30', 50.00, 7, 'Active');

INSERT INTO dbo.PolicyQuotaTiers (PolicyId, TierSequence, CoverageType, AllowedTows, UsedTows, MaxDistanceKm, MinIntervalDays)
VALUES
    (3, 10, 'Mechanical', 4, 1, 50.00, 7),   -- 7-day cooldown required between Mechanical tows!
    (3, 20, 'Accident',   1, 0, 60.00, 14);

-- Policy 4: ACCIDENT QUOTA EXHAUSTED POLICY (0 Accident Tows Left)
INSERT INTO dbo.InsurancePolicies (PolicyNumber, CustomerId, ProviderId, StartDate, ExpirationDate, DefaultAllowedKm, DefaultMinIntervalDays, PolicyStatus)
VALUES ('POL-2026-NO-ACCIDENT', 4, 4, '2026-01-01', '2027-06-30', 40.00, 0, 'Active');

INSERT INTO dbo.PolicyQuotaTiers (PolicyId, TierSequence, CoverageType, AllowedTows, UsedTows, MaxDistanceKm, MinIntervalDays)
VALUES
    (4, 10, 'Mechanical', 3, 1, 40.00, 0),
    (4, 20, 'Accident',   1, 1, 50.00, 0);   -- 0 Accident tows left!

-- Policy 5: EXPIRED POLICY
INSERT INTO dbo.InsurancePolicies (PolicyNumber, CustomerId, ProviderId, StartDate, ExpirationDate, DefaultAllowedKm, DefaultMinIntervalDays, PolicyStatus)
VALUES ('POL-2025-EXPIRED', 5, 1, '2025-01-01', '2025-12-31', 50.00, 0, 'Active');
UPDATE dbo.InsurancePolicies SET PolicyStatus = 'Expired' WHERE PolicyNumber = 'POL-2025-EXPIRED';

INSERT INTO dbo.PolicyQuotaTiers (PolicyId, TierSequence, CoverageType, AllowedTows, UsedTows, MaxDistanceKm, MinIntervalDays)
VALUES
    (5, 10, 'All', 3, 0, 50.00, 0);

-- Additional Multiple Policies for Customers 1, 2, and 3 (demonstrating 1:N Customer -> InsurancePolicies)
INSERT INTO dbo.InsurancePolicies (PolicyNumber, CustomerId, ProviderId, StartDate, ExpirationDate, DefaultAllowedKm, DefaultMinIntervalDays, PolicyStatus)
VALUES
    ('POL-2026-ALZ101', 1, 1, '2026-01-01', '2026-12-31', 100.00, 3, 'Active'),
    ('POL-2026-AXA102', 1, 3, '2026-02-01', '2026-12-31', 40.00,  7, 'Active'),
    ('POL-2026-MED202', 2, 4, '2026-01-15', '2026-12-31', 50.00, 10, 'Active'),
    ('POL-2026-BNK303', 3, 2, '2026-03-01', '2026-12-31', 75.00,  5, 'Active');

DECLARE @P_ALZ INT = (SELECT PolicyId FROM dbo.InsurancePolicies WHERE PolicyNumber = 'POL-2026-ALZ101');
DECLARE @P_AXA INT = (SELECT PolicyId FROM dbo.InsurancePolicies WHERE PolicyNumber = 'POL-2026-AXA102');
DECLARE @P_MED INT = (SELECT PolicyId FROM dbo.InsurancePolicies WHERE PolicyNumber = 'POL-2026-MED202');
DECLARE @P_BNK INT = (SELECT PolicyId FROM dbo.InsurancePolicies WHERE PolicyNumber = 'POL-2026-BNK303');

INSERT INTO dbo.PolicyQuotaTiers (PolicyId, TierSequence, CoverageType, AllowedTows, UsedTows, MaxDistanceKm, MinIntervalDays)
VALUES
    (@P_ALZ, 1, 'Mechanical', 4, 0, 100.00, 3),
    (@P_ALZ, 2, 'Accident',   3, 0, 100.00, 0),
    (@P_AXA, 1, 'Mechanical', 2, 0,  40.00, 7),
    (@P_AXA, 2, 'Accident',   2, 0,  40.00, 2),
    (@P_MED, 1, 'Mechanical', 3, 0,  50.00, 10),
    (@P_MED, 2, 'Accident',   2, 0,  50.00, 3),
    (@P_BNK, 1, 'Mechanical', 3, 0,  75.00, 5),
    (@P_BNK, 2, 'Accident',   3, 0,  75.00, 0);

-- Generate 145 additional active policies (Total = 150 Policies)
;WITH PolNums AS (
    SELECT TOP (145) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) + 5 AS p
    FROM sys.all_objects
)
INSERT INTO dbo.InsurancePolicies (PolicyNumber, CustomerId, ProviderId, StartDate, ExpirationDate, DefaultAllowedKm, DefaultMinIntervalDays, PolicyStatus)
SELECT
    CONCAT('POL-2026-', FORMAT(p, '00000')),
    p,
    ((p % 6) + 1),
    '2026-01-01',
    '2027-05-31',
    CAST(40 + ((p % 4) * 15) AS DECIMAL(8,2)),
    (p % 3) * 3,
    'Active'
FROM PolNums;

-- Add Quota Tiers for Policies 6..150
INSERT INTO dbo.PolicyQuotaTiers (PolicyId, TierSequence, CoverageType, AllowedTows, UsedTows, MaxDistanceKm, MinIntervalDays)
SELECT
    p.PolicyId,
    10,
    'Mechanical',
    10,
    2,
    p.DefaultAllowedKm,
    p.DefaultMinIntervalDays
FROM dbo.InsurancePolicies AS p
WHERE p.PolicyId >= 6;

INSERT INTO dbo.PolicyQuotaTiers (PolicyId, TierSequence, CoverageType, AllowedTows, UsedTows, MaxDistanceKm, MinIntervalDays)
SELECT
    p.PolicyId,
    20,
    'Accident',
    5,
    1,
    p.DefaultAllowedKm + 20.00,
    p.DefaultMinIntervalDays
FROM dbo.InsurancePolicies AS p
WHERE p.PolicyId >= 6;
GO

/*------------------------------------------------------------------------------
  5. SEED FLEET TOW TRUCKS (8 LIVE GPS TRUCKS ACROSS LEBANON)
------------------------------------------------------------------------------*/
INSERT INTO dbo.TowTrucks (TruckCode, LicensePlate, DriverName, DriverPhone, CurrentLat, CurrentLng, SpeedKmh, FleetStatus, MaxPayloadKg)
VALUES
    ('TRK-01', 'B 901120', N'Antoine Geagea (Beirut Central)',  '+961-03-901120', 33.893800, 35.501800, 38.5, 'EnRoute',   6500),
    ('TRK-02', 'M 402310', N'Fadi Abi Khalil (Dora / Metn)',    '+961-70-402310', 33.898300, 35.552400, 52.0, 'Towing',    8000),
    ('TRK-03', 'J 718290', N'Wissam Wakim (Jounieh Highway)',   '+961-71-718290', 33.980800, 35.617800,  0.0, 'Available', 5500),
    ('TRK-04', 'G 551902', N'Rabih Daoud (Hazmieh / Baabda)',   '+961-03-551902', 33.856900, 35.541100,  0.0, 'Available', 7000),
    ('TRK-05', 'J 339104', N'Marc Jbeily (Byblos Coastal)',     '+961-76-339104', 34.123000, 35.651900, 44.0, 'EnRoute',   6000),
    ('TRK-06', 'Z 612099', N'Elias Skaff (Zahle / Dahr Baidar)','+961-03-612099', 33.846300, 35.902000,  0.0, 'Available', 9500),
    ('TRK-07', 'N 882100', N'Bilal Kabbara (Batroun / Tripoli)','+961-70-882100', 34.255400, 35.658100,  0.0, 'Available', 6500),
    ('TRK-08', 'S 219400', N'Hassan Zein (Damour / Sidon)',     '+961-71-219400', 33.732200, 35.453900,  0.0, 'OffDuty',   5000);
GO

/*==============================================================================
  6. BULK GENERATE 120,000 HISTORICAL ROWS IN dbo.TowRequests
  Uses a fast set-based Cross-Join CTE to populate 120,000 rows in ~3 seconds.
==============================================================================*/
DISABLE TRIGGER dbo.trg_TowRequests_ImmutabilityAndAudit ON dbo.TowRequests;
GO

;WITH
L0 AS (SELECT 1 AS c FROM (VALUES(1),(1),(1),(1),(1),(1),(1),(1),(1),(1)) AS T(c)), -- 10
L1 AS (SELECT 1 AS c FROM L0 AS A CROSS JOIN L0 AS B),                               -- 100
L2 AS (SELECT 1 AS c FROM L1 AS A CROSS JOIN L1 AS B),                               -- 10,000
L3 AS (SELECT 1 AS c FROM L2 AS A CROSS JOIN L1 AS B),                               -- 1,000,000
Nums AS (
    SELECT TOP (120000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS rn
    FROM L3
)
INSERT INTO dbo.TowRequests WITH (TABLOCK)
(
    RequestNumber, CustomerId, CallerPhone, PlateCodeId, PlateDigits, NoPlate,
    VehiclePlate, VehicleModel, IssueType, IssueNotes,
    PickupAddress, PickupLat, PickupLng, DestinationAddress, DestinationLat, DestinationLng,
    HasInsurance, PolicyId, QuotaTierId, AssignedTruckId, TruckPrioritySequence,
    ActualDistanceKm, AllowedDistanceKm, OverageKm, ExtraKmRate, OverageAmount,
    CashCollected, IsNightShift, Status, RejectionReason, CreatedAt, CompletedAt
)
SELECT
    CONCAT('TOW/HIST/', FORMAT(rn, '0000000')) AS RequestNumber,
    ((rn % 190) + 10) AS CustomerId,
    CONCAT('+961-70-', FORMAT(100000 + (rn % 900000), '000000')) AS CallerPhone,
    ((rn % 9) + 1) AS PlateCodeId,
    CAST(100000 + (rn % 899999) AS VARCHAR(20)) AS PlateDigits,
    0 AS NoPlate,
    CONCAT(
        CHOOSE((rn % 9) + 1, 'B', 'M', 'G', 'J', 'N', 'S', 'Z', 'R', 'T'),
        ' ',
        CAST(100000 + (rn % 899999) AS VARCHAR(20))
    ) AS VehiclePlate,
    CHOOSE((rn % 8) + 1,
        N'BMW 520i', N'Mercedes C300', N'Kia Sportage', N'Toyota RAV4',
        N'Hyundai Tucson', N'Honda CR-V', N'Nissan Sunny', N'Range Rover Sport'
    ) AS VehicleModel,
    CHOOSE((rn % 6) + 1, 'Mechanical', 'Accident', 'Battery', 'Tire', 'Winch', 'Mechanical') AS IssueType,
    N'Historical roadside dispatch record' AS IssueNotes,
    CHOOSE((rn % 6) + 1,
        N'Hamra Main Street, Beirut',
        N'Dora Highway Bridge, Metn',
        N'Jounieh Coastal Road, Keserwan',
        N'Hazmieh Damascus Road, Baabda',
        N'Nahr El Kalb Tunnel, Dbaye',
        N'Dahr El Baidar Highway, Bekaa'
    ) AS PickupAddress,
    CAST(33.800000 + ((rn % 4000) * 0.000100) AS DECIMAL(9,6)) AS PickupLat,
    CAST(35.480000 + ((rn % 3000) * 0.000100) AS DECIMAL(9,6)) AS PickupLng,
    CHOOSE((rn % 5) + 1,
        N'Bouchrieh Industrial City Garage',
        N'Zalka Auto Service Center',
        N'Mkalles Certified Body Shop',
        N'Choueifat Dealership Workshop',
        N'Zouk Mosbeh Mechanical Hub'
    ) AS DestinationAddress,
    CAST(33.850000 + ((rn % 3500) * 0.000100) AS DECIMAL(9,6)) AS DestinationLat,
    CAST(35.510000 + ((rn % 2500) * 0.000100) AS DECIMAL(9,6)) AS DestinationLng,
    1 AS HasInsurance,
    ((rn % 145) + 6) AS PolicyId,
    NULL AS QuotaTierId,
    ((rn % 7) + 1) AS AssignedTruckId,
    10 AS TruckPrioritySequence,
    CAST(15.00 + (rn % 75) AS DECIMAL(8,2)) AS ActualDistanceKm,
    50.00 AS AllowedDistanceKm,
    CAST(CASE WHEN (15.00 + (rn % 75)) > 50.00 THEN (15.00 + (rn % 75)) - 50.00 ELSE 0.00 END AS DECIMAL(8,2)) AS OverageKm,
    2.50 AS ExtraKmRate,
    CAST(CASE WHEN (15.00 + (rn % 75)) > 50.00 THEN ((15.00 + (rn % 75)) - 50.00) * 2.50 ELSE 0.00 END AS DECIMAL(10,2)) AS OverageAmount,
    CAST(CASE WHEN (15.00 + (rn % 75)) > 50.00 THEN ((15.00 + (rn % 75)) - 50.00) * 2.50 ELSE 0.00 END AS DECIMAL(10,2)) AS CashCollected,
    CASE WHEN (rn % 4) = 0 THEN 1 ELSE 0 END AS IsNightShift,
    CHOOSE((rn % 10) + 1, 'Done', 'Done', 'Done', 'Done', 'Done', 'Done', 'Done', 'UnableToLoad', 'Rejected', 'Done') AS Status,
    CASE WHEN (rn % 10) = 8 THEN N'Policy coverage declined by adjuster' ELSE NULL END AS RejectionReason,
    DATEADD(MINUTE, -(rn * 6), '2026-11-01T12:00:00') AS CreatedAt,
    DATEADD(MINUTE, -(rn * 6) + 55, '2026-11-01T12:00:00') AS CompletedAt
FROM Nums;
GO

ENABLE TRIGGER dbo.trg_TowRequests_ImmutabilityAndAudit ON dbo.TowRequests;
GO

/*==============================================================================
  7. SEED ACTIVE & DEMO OPERATIONAL TICKETS (WITH TRIGGER ENABLED!)
  Includes:
  - Active Multi-Stop Priority Queues on TRK-01 (Stop 10, Stop 20) & TRK-02
  - Recent tow 2 days ago for Policy 3 ('POL-2026-COOLDOWN7') to trigger Cooldown
  - Two Draft Accident Requests on Policy 2 ('POL-2026-ACC-LAST1') ready for the
    2-User Simultaneous Concurrency Race Demo!
==============================================================================*/
-- 1. Recent completed Mechanical tow 2 days ago on Policy 3 (triggers 7-day cooldown!)
INSERT INTO dbo.TowRequests
(
    RequestNumber, CustomerId, CallerPhone, PlateCodeId, PlateDigits, NoPlate,
    VehiclePlate, VehicleModel, IssueType, IssueNotes,
    PickupAddress, PickupLat, PickupLng, DestinationAddress, DestinationLat, DestinationLng,
    HasInsurance, PolicyId, QuotaTierId, AssignedTruckId, TruckPrioritySequence,
    ActualDistanceKm, AllowedDistanceKm, OverageKm, ExtraKmRate, OverageAmount,
    CashCollected, IsNightShift, Status, CreatedAt, CompletedAt
)
VALUES
(
    'TOW/2026/900001', 3, '+961-71-333444', 2, '334910', 0,
    'M 334910', N'Mercedes C300', 'Mechanical', N'Alternator failure on highway (Completed 2 days ago)',
    N'Antelias Highway, Metn', 33.914400, 35.586800, N'Zalka Mercedes Service', 33.898900, 35.569800,
    1, 3, 6, 3, 10,
    18.50, 50.00, 0.00, 2.50, 0.00,
    0.00, 0, 'Done', DATEADD(DAY, -2, SYSDATETIME()), DATEADD(HOUR, -47, SYSDATETIME())
);

-- 2. Active Queue on TRK-01 (Stop 10 = InProgress, Stop 20 = Approved)
INSERT INTO dbo.TowRequests
(
    RequestNumber, CustomerId, CallerPhone, PlateCodeId, PlateDigits, NoPlate,
    VehiclePlate, VehicleModel, IssueType, IssueNotes,
    PickupAddress, PickupLat, PickupLng, DestinationAddress, DestinationLat, DestinationLng,
    HasInsurance, PolicyId, QuotaTierId, AssignedTruckId, TruckPrioritySequence,
    ActualDistanceKm, AllowedDistanceKm, OverageKm, ExtraKmRate, OverageAmount,
    CashCollected, IsNightShift, Status, CreatedAt
)
VALUES
(
    'TOW/2026/900002', 1, '+961-03-111222', 1, '184220', 0,
    'B 184220', N'BMW 530e M-Sport', 'Mechanical', N'Engine overheating near Downtown Beirut tunnel',
    N'Martyrs Square / Ring Bridge, Beirut', 33.895800, 35.507200, N'Bouchrieh BMW Specialist Garage', 33.892100, 35.554200,
    1, 1, 1, 1, 10,
    12.40, 50.00, 0.00, 2.50, 0.00,
    0.00, 0, 'InProgress', DATEADD(MINUTE, -35, SYSDATETIME())
),
(
    'TOW/2026/900003', 6, '+961-03-666777', 3, '772109', 0,
    'G 772109', N'Porsche Cayenne', 'Tire', N'Double tire blowout on Hazmieh incline (Queued Stop #2)',
    N'Hazmieh Mar Takla Roundabout', 33.854200, 35.535100, N'Mkalles Tire & Alignment Center', 33.876100, 35.545000,
    0, NULL, NULL, 1, 20,
    9.80, 0.00, 9.80, 2.50, 24.50,
    0.00, 0, 'Approved', DATEADD(MINUTE, -20, SYSDATETIME())
);

-- 3. Active Queue on TRK-02 (Stop 10 = InProgress, Stop 20 = Approved)
INSERT INTO dbo.TowRequests
(
    RequestNumber, CustomerId, CallerPhone, PlateCodeId, PlateDigits, NoPlate,
    VehiclePlate, VehicleModel, IssueType, IssueNotes,
    PickupAddress, PickupLat, PickupLng, DestinationAddress, DestinationLat, DestinationLng,
    HasInsurance, PolicyId, QuotaTierId, AssignedTruckId, TruckPrioritySequence,
    ActualDistanceKm, AllowedDistanceKm, OverageKm, ExtraKmRate, OverageAmount,
    CashCollected, IsNightShift, Status, CreatedAt
)
VALUES
(
    'TOW/2026/900004', 7, '+961-70-777888', 4, '509112', 0,
    'J 509112', N'Range Rover Velar', 'Accident', N'Front bumper collision on Dbayeh seaside road',
    N'Dbayeh Waterfront Highway', 33.931000, 35.589000, N'Zouk Mosbeh Land Rover Bodyshop', 33.961000, 35.611000,
    1, 6, NULL, 2, 10,
    68.00, 50.00, 18.00, 2.50, 45.00,
    0.00, 0, 'InProgress', DATEADD(MINUTE, -40, SYSDATETIME())
),
(
    'TOW/2026/900005', 8, '+961-71-888999', 2, '619004', 0,
    'M 619004', N'Audi Q5 Quattro', 'Battery', N'Dead 12V battery at CityMall underground parking',
    N'Dora CityMall Entrance, Metn', 33.896200, 35.557100, N'Dekwaneh Audi Workshop', 33.884100, 35.548200,
    0, NULL, NULL, 2, 20,
    7.20, 0.00, 7.20, 2.50, 18.00,
    0.00, 0, 'Approved', DATEADD(MINUTE, -12, SYSDATETIME())
);

-- 4. TWO DRAFT ACCIDENT REQUESTS FOR POLICY 2 ('POL-2026-ACC-LAST1' — ONLY 1 ACCIDENT TOW LEFT!)
-- Used to demonstrate 2 simultaneous dispatchers racing for the last remaining quota!
INSERT INTO dbo.TowRequests
(
    RequestNumber, CustomerId, CallerPhone, PlateCodeId, PlateDigits, NoPlate,
    VehiclePlate, VehicleModel, IssueType, IssueNotes,
    PickupAddress, PickupLat, PickupLng, DestinationAddress, DestinationLat, DestinationLng,
    HasInsurance, PolicyId, QuotaTierId, AssignedTruckId, TruckPrioritySequence,
    ActualDistanceKm, AllowedDistanceKm, OverageKm, ExtraKmRate, OverageAmount,
    CashCollected, IsNightShift, Status, CreatedAt
)
VALUES
(
    'TOW/2026/900006', 2, '+961-70-222333', 2, '998111', 0,
    'M 998111', N'Toyota Land Cruiser Prado', 'Accident', N'[RACE TEST A] Guardrail impact on Nahr El Mot highway',
    N'Nahr El Mot Highway, Metn', 33.906100, 35.568200, N'Jdeideh Toyota Repair Center', 33.892000, 35.561000,
    1, 2, 5, NULL, 10,
    22.00, 75.00, 0.00, 2.50, 0.00,
    0.00, 0, 'Draft', DATEADD(MINUTE, -5, SYSDATETIME())
),
(
    'TOW/2026/900007', 2, '+961-70-222333', 2, '998222', 0,
    'M 998222', N'Lexus RX350 (2nd Family Car)', 'Accident', N'[RACE TEST B] Simultaneous accident claim on same policy POL-2026-ACC-LAST1',
    N'Jal El Dib Autostrade, Metn', 33.910200, 35.575400, N'Sin El Fil Lexus Bodyshop', 33.878000, 35.539000,
    1, 2, 5, NULL, 10,
    26.00, 75.00, 0.00, 2.50, 0.00,
    0.00, 0, 'Draft', DATEADD(MINUTE, -4, SYSDATETIME())
);
GO

/*------------------------------------------------------------------------------
  8. UPDATE STATISTICS WITH FULLSCAN FOR OPTIMAL EXECUTION PLANS
------------------------------------------------------------------------------*/
UPDATE STATISTICS dbo.TowRequests WITH FULLSCAN;
UPDATE STATISTICS dbo.InsurancePolicies WITH FULLSCAN;
UPDATE STATISTICS dbo.PolicyQuotaTiers WITH FULLSCAN;
UPDATE STATISTICS dbo.TowTrucks WITH FULLSCAN;
GO

DECLARE @TotalRows INT = (SELECT COUNT(*) FROM dbo.TowRequests);
PRINT CONCAT('03_seed_120k_data.sql completed. Total rows in dbo.TowRequests = ', @TotalRows);
GO
