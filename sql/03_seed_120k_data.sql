/*==============================================================================
  GIN401 - LAB PROJECT: ROADSIDE ASSISTANCE & TOWING CAD DISPATCH SYSTEM
  Script 03: Seed Normalized Reference Data + > 120,000 Rows in TowRequests,
             Historical Tariffs, TowInvoices, and Partial InvoicePayments
  DBMS: Microsoft SQL Server
==============================================================================*/
SET NOCOUNT ON;
USE GIN401_TowDispatch;
GO
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

/*------------------------------------------------------------------------------
  1A. SEED NORMALIZED 3NF USER GROUPS (dbo.UserGroups — Owns RBAC Permissions)
------------------------------------------------------------------------------*/
INSERT INTO dbo.UserGroups (
    GroupCode, GroupName, Description,
    CanDispatch, CanManageFleet, CanManagePolicies, CanManageBilling, CanManageUsers, IsSystemBuiltIn
)
VALUES
    ('ADMIN',         N'System Administrators',                  N'Full command, configuration, user/group RBAC, fleet, policy, and financial control.', 1, 1, 1, 1, 1, 1),
    ('DISPATCHER',    N'Emergency Roadside Dispatchers',         N'24/7 call intake, live GPS dispatch, policy eligibility checks, and customer/insurer billing.', 1, 0, 1, 1, 0, 1),
    ('FLEET_MANAGER', N'Fleet & Recovery Supervisors',           N'Tow truck hardware configuration, driver profiles, shift assignment rotations, and CAD dispatch.', 1, 1, 0, 0, 0, 1),
    ('UNDERWRITER',   N'Insurance Policy & Claims Underwriters', N'Partner policy underwriting, sequential quota tiers, tariffs, and insurer invoice settlements.', 0, 0, 1, 1, 0, 1);
GO

/*------------------------------------------------------------------------------
  1B. SEED AUTHENTICATED OPERATORS ASSIGNED TO USER GROUPS (BCRYPT COST=12)
------------------------------------------------------------------------------*/
INSERT INTO dbo.SystemUsers (
    Username, PasswordHash, FullName, RoleTitle, Department, StationCode, GroupId, IsActive
)
VALUES
    ('assaad.khalife',     '$2a$12$q5aU6OypJoB.VjNr1LF54.s.TTIdXhAaQA5iEpI5a/nVbE5G/npui', N'Assaad Khalife', N'Chief Operations & CAD Director',      N'National Command Center', 'BEY-CMD-01', 1, 1),
    ('dispatch.beirut',    '$2a$12$Do87WAuls76CFkLe4AyTB.RXRz9FugLCyJcfpQcnFN1l6dxV97zki', N'Rami Nassar',    N'Senior Emergency Dispatcher',          N'24/7 Roadside Desk',      'BEY-DSK-04', 2, 1),
    ('fleet.manager',      '$2a$12$3X4NKqZvZQUmYDcGVZRRHOnrx/piiTtBaUU5Ne41GcgFJX8xKr/bC', N'Karim Haddad',   N'Fleet & Recovery Supervisor',          N'FleetLogic Operations',   'BEY-FLT-02', 3, 1),
    ('claims.underwriter', '$2a$12$Dv0DcII12.7pTKp/voolIeufDnIkDvrJ7FlLjfSbihdcUapmlLuO2', N'Maya Khoury',    N'Insurance Policy & Claims Specialist', N'Partner Underwriting',    'BEY-INS-01', 4, 1);
GO

/*------------------------------------------------------------------------------
  2. SEED INSURANCE PROVIDERS
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
  3. SEED LEBANESE PLATE CODES
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
  4. SEED NORMALIZED EXTERNAL SUBCONTRACTORS
------------------------------------------------------------------------------*/
INSERT INTO dbo.Subcontractors (CompanyName, ContactPerson, Phone, CoverageRegion, DefaultDispatchFee)
VALUES
    (N'Cedar Heavy Recovery SAL',    N'Maroun Khoury',  '+961-03-710200', N'Bekaa / Dahr El Baidar', 65.00),
    (N'Phoenicia South Winch Co.',   N'Ali Hammoud',    '+961-70-820300', N'Sidon / Tyre Coastal',   50.00),
    (N'Tripoli Rapid Tow Partners',  N'Omar Mikati',    '+961-71-930400', N'North Lebanon / Akkar',  55.00),
    (N'Chouf Mountain Assist SARL',  N'Walid Jumaa',    '+961-03-640500', N'Chouf / Aley Highlands', 60.00),
    (N'Byblos 24/7 Flatbed Service', N'Ziad Hawat',     '+961-76-550600', N'Jbeil / Batroun',        45.00);
GO

/*------------------------------------------------------------------------------
  5. SEED HISTORICAL & ACTIVE TARIFFS (2024, 2025, AND ACTIVE 2026 TARIFFS)
------------------------------------------------------------------------------*/
INSERT INTO dbo.Tariffs (TariffCode, TariffName, ServiceCategory, BaseFee, PricePerKm, NightSurcharge, EffectiveFrom, EffectiveTo, IsActive)
VALUES
    ('TRF-2024-STD',  N'2024 Legacy Roadside Tariff',           'All',        25.00, 1.75, 10.00, '2024-01-01', '2024-12-31', 0),
    ('TRF-2025-STD',  N'2025 Standard Roadside Tariff',         'All',        30.00, 2.00, 12.00, '2025-01-01', '2025-12-31', 0),
    ('TRF-2026-MECH', N'2026 Mechanical Roadside Tariff',       'Mechanical', 35.00, 2.50, 15.00, '2026-01-01', NULL,         1),
    ('TRF-2026-ACC',  N'2026 Accident & Heavy Winch Tariff',    'Accident',   50.00, 3.00, 20.00, '2026-01-01', NULL,         1);
GO

/*------------------------------------------------------------------------------
  6. SEED CUSTOMERS (2,000 REGISTERED CALLERS / VEHICLE OWNERS)
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

;WITH
L0 AS (SELECT 1 AS c FROM (VALUES(1),(1),(1),(1),(1),(1),(1),(1),(1),(1)) AS T(c)),
L1 AS (SELECT 1 AS c FROM L0 AS A CROSS JOIN L0 AS B),
L2 AS (SELECT 1 AS c FROM L1 AS A CROSS JOIN L1 AS B),
Nums AS (
    SELECT TOP (1992) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) + 8 AS n
    FROM L2
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
  7. SEED NORMALIZED VEHICLES (4,000 VEHICLES OWNED BY CUSTOMERS)
------------------------------------------------------------------------------*/
INSERT INTO dbo.Vehicles (CustomerId, PlateCodeId, PlateDigits, NoPlate, VehiclePlate, VehicleModel)
VALUES
    (3,  2, '334910', 0, 'M 334910', N'Mercedes C300'),
    (1,  1, '184220', 0, 'B 184220', N'BMW 530e M-Sport'),
    (6,  3, '772109', 0, 'G 772109', N'Porsche Cayenne'),
    (7,  4, '509112', 0, 'J 509112', N'Range Rover Velar'),
    (8,  2, '619004', 0, 'M 619004', N'Audi Q5 Quattro'),
    (2,  2, '998111', 0, 'M 998111', N'Toyota Land Cruiser Prado'),
    (2,  2, '998222', 0, 'M 998222', N'Lexus RX350 (2nd Family Car)'),
    (10, 2, '100001', 0, 'M 100001', N'BMW 520i'),
    (1,  NULL, NULL,  1, 'NO-PLATE', N'Showroom Unregistered BYD Seal');

;WITH
L0 AS (SELECT 1 AS c FROM (VALUES(1),(1),(1),(1),(1),(1),(1),(1),(1),(1)) AS T(c)),
L1 AS (SELECT 1 AS c FROM L0 AS A CROSS JOIN L0 AS B),
L2 AS (SELECT 1 AS c FROM L1 AS A CROSS JOIN L1 AS B),
VNums AS (
    SELECT TOP (3991) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) + 9 AS v
    FROM L2
)
INSERT INTO dbo.Vehicles (CustomerId, PlateCodeId, PlateDigits, NoPlate, VehiclePlate, VehicleModel)
SELECT
    ((v % 1990) + 10) AS CustomerId,
    ((v % 9) + 1) AS PlateCodeId,
    CAST(200000 + v AS VARCHAR(20)) AS PlateDigits,
    0 AS NoPlate,
    CONCAT(
        CHOOSE((v % 9) + 1, 'B', 'M', 'G', 'J', 'N', 'S', 'Z', 'R', 'T'),
        ' ',
        CAST(200000 + v AS VARCHAR(20))
    ) AS VehiclePlate,
    CHOOSE((v % 8) + 1,
        N'BMW 520i', N'Mercedes C300', N'Kia Sportage', N'Toyota RAV4',
        N'Hyundai Tucson', N'Honda CR-V', N'Nissan Sunny', N'Range Rover Sport'
    ) AS VehicleModel
FROM VNums;
GO

/*------------------------------------------------------------------------------
  8. SEED INSURANCE POLICIES & SEQUENTIAL QUOTA TIERS (1,500 POLICIES)
------------------------------------------------------------------------------*/
-- Policy 1: VIP Policy with Multi-Tier Sequential Coverage
INSERT INTO dbo.InsurancePolicies (PolicyNumber, CustomerId, ProviderId, StartDate, ExpirationDate, DefaultAllowedKm, DefaultMinIntervalDays, PolicyStatus)
VALUES ('POL-2026-VIP001', 1, 1, '2026-01-01', '2027-06-30', 50.00, 0, 'Active');

INSERT INTO dbo.PolicyQuotaTiers (PolicyId, TierSequence, CoverageType, AllowedTows, UsedTows, MaxDistanceKm, MinIntervalDays)
VALUES
    (1, 10, 'Mechanical', 2, 1, 50.00, 0),
    (1, 20, 'Mechanical', 2, 0, 100.00, 0),
    (1, 30, 'Accident',   2, 0, 80.00, 0);

-- Policy 2: CONCURRENCY RACE TEST POLICY (Exactly 1 Accident Tow Remaining!)
INSERT INTO dbo.InsurancePolicies (PolicyNumber, CustomerId, ProviderId, StartDate, ExpirationDate, DefaultAllowedKm, DefaultMinIntervalDays, PolicyStatus)
VALUES ('POL-2026-ACC-LAST1', 2, 2, '2026-01-01', '2027-06-30', 60.00, 0, 'Active');

INSERT INTO dbo.PolicyQuotaTiers (PolicyId, TierSequence, CoverageType, AllowedTows, UsedTows, MaxDistanceKm, MinIntervalDays)
VALUES
    (2, 10, 'Mechanical', 3, 1, 60.00, 0),
    (2, 20, 'Accident',   2, 1, 75.00, 0);

-- Policy 3: COOLDOWN INTERVAL RESTRICTION POLICY (Requires 7 Days Between Mechanical Tows)
INSERT INTO dbo.InsurancePolicies (PolicyNumber, CustomerId, ProviderId, StartDate, ExpirationDate, DefaultAllowedKm, DefaultMinIntervalDays, PolicyStatus)
VALUES ('POL-2026-COOLDOWN7', 3, 3, '2026-01-01', '2027-06-30', 50.00, 7, 'Active');

INSERT INTO dbo.PolicyQuotaTiers (PolicyId, TierSequence, CoverageType, AllowedTows, UsedTows, MaxDistanceKm, MinIntervalDays)
VALUES
    (3, 10, 'Mechanical', 4, 1, 50.00, 7),
    (3, 20, 'Accident',   1, 0, 60.00, 14);

-- Policy 4: ACCIDENT QUOTA EXHAUSTED POLICY (0 Accident Tows Left)
INSERT INTO dbo.InsurancePolicies (PolicyNumber, CustomerId, ProviderId, StartDate, ExpirationDate, DefaultAllowedKm, DefaultMinIntervalDays, PolicyStatus)
VALUES ('POL-2026-NO-ACCIDENT', 4, 4, '2026-01-01', '2027-06-30', 40.00, 0, 'Active');

INSERT INTO dbo.PolicyQuotaTiers (PolicyId, TierSequence, CoverageType, AllowedTows, UsedTows, MaxDistanceKm, MinIntervalDays)
VALUES
    (4, 10, 'Mechanical', 3, 1, 40.00, 0),
    (4, 20, 'Accident',   1, 1, 50.00, 0);

-- Policy 5: EXPIRED POLICY
INSERT INTO dbo.InsurancePolicies (PolicyNumber, CustomerId, ProviderId, StartDate, ExpirationDate, DefaultAllowedKm, DefaultMinIntervalDays, PolicyStatus)
VALUES ('POL-2025-EXPIRED', 5, 1, '2025-01-01', '2025-12-31', 50.00, 0, 'Expired');

INSERT INTO dbo.PolicyQuotaTiers (PolicyId, TierSequence, CoverageType, AllowedTows, UsedTows, MaxDistanceKm, MinIntervalDays)
VALUES
    (5, 10, 'All', 3, 0, 50.00, 0);

-- Multi-Policies for Customers 1, 2, 3 (PolicyId 6..9)
INSERT INTO dbo.InsurancePolicies (PolicyNumber, CustomerId, ProviderId, StartDate, ExpirationDate, DefaultAllowedKm, DefaultMinIntervalDays, PolicyStatus)
VALUES
    ('POL-2026-ALZ101', 1, 5, '2026-01-01', '2026-12-31', 100.00, 3, 'Active'),
    ('POL-2026-AXA102', 1, 3, '2026-02-01', '2026-12-31', 40.00,  7, 'Active'),
    ('POL-2026-MED202', 2, 6, '2026-01-15', '2026-12-31', 50.00, 10, 'Active'),
    ('POL-2026-BNK303', 3, 1, '2026-03-01', '2026-12-31', 75.00,  5, 'Active');

INSERT INTO dbo.PolicyQuotaTiers (PolicyId, TierSequence, CoverageType, AllowedTows, UsedTows, MaxDistanceKm, MinIntervalDays)
VALUES
    (6, 10, 'Mechanical', 4, 0, 100.00, 3),
    (6, 20, 'Accident',   3, 0, 100.00, 0),
    (7, 10, 'Mechanical', 2, 0,  40.00, 7),
    (7, 20, 'Accident',   2, 0,  40.00, 2),
    (8, 10, 'Mechanical', 3, 0,  50.00, 10),
    (8, 20, 'Accident',   2, 0,  50.00, 3),
    (9, 10, 'Mechanical', 3, 0,  75.00, 5),
    (9, 20, 'Accident',   3, 0,  75.00, 0);

-- Generate 1,491 additional active policies (PolicyId 10..1500)
;WITH
L0 AS (SELECT 1 AS c FROM (VALUES(1),(1),(1),(1),(1),(1),(1),(1),(1),(1)) AS T(c)),
L1 AS (SELECT 1 AS c FROM L0 AS A CROSS JOIN L0 AS B),
L2 AS (SELECT 1 AS c FROM L1 AS A CROSS JOIN L1 AS B),
PolNums AS (
    SELECT TOP (1491) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) + 9 AS p
    FROM L2
)
INSERT INTO dbo.InsurancePolicies (PolicyNumber, CustomerId, ProviderId, StartDate, ExpirationDate, DefaultAllowedKm, DefaultMinIntervalDays, PolicyStatus)
SELECT
    CONCAT('POL-2026-', FORMAT(p, '00000')),
    ((p % 1990) + 10),
    ((p % 6) + 1),
    '2026-01-01',
    '2027-05-31',
    CAST(40 + ((p % 4) * 15) AS DECIMAL(8,2)),
    (p % 3) * 3,
    'Active'
FROM PolNums;

INSERT INTO dbo.PolicyQuotaTiers (PolicyId, TierSequence, CoverageType, AllowedTows, UsedTows, MaxDistanceKm, MinIntervalDays)
SELECT p.PolicyId, 10, 'Mechanical', 10, 2, p.DefaultAllowedKm, p.DefaultMinIntervalDays
FROM dbo.InsurancePolicies AS p
WHERE p.PolicyId >= 10;

INSERT INTO dbo.PolicyQuotaTiers (PolicyId, TierSequence, CoverageType, AllowedTows, UsedTows, MaxDistanceKm, MinIntervalDays)
SELECT p.PolicyId, 20, 'Accident', 5, 1, p.DefaultAllowedKm + 20.00, p.DefaultMinIntervalDays
FROM dbo.InsurancePolicies AS p
WHERE p.PolicyId >= 10;
GO

/*------------------------------------------------------------------------------
  9. SEED NORMALIZED DRIVERS, TOW TRUCKS & DRIVER-TRUCK ASSIGNMENT HISTORY
------------------------------------------------------------------------------*/
INSERT INTO dbo.Drivers (EmployeeCode, FullName, Phone, LicenseNumber, BaseMonthlySalary, OvertimeRatePerTow, IsWorkingOffDay, DriverStatus, HiredAt)
VALUES
    ('DRV-01', N'Antoine Geagea',   '+961-03-901120', 'LB-HVY-2019-011', 900.00, 15.00, 0, 'Active',  '2022-03-15'),
    ('DRV-02', N'Fadi Abi Khalil',  '+961-70-402310', 'LB-HVY-2020-042', 950.00, 18.00, 0, 'Active',  '2021-07-01'),
    ('DRV-03', N'Wissam Wakim',     '+961-71-718290', 'LB-HVY-2021-108', 850.00, 15.00, 0, 'Active',  '2023-01-10'),
    ('DRV-04', N'Rabih Daoud',      '+961-03-551902', 'LB-HVY-2018-077', 880.00, 16.00, 1, 'Active',  '2020-11-20'),
    ('DRV-05', N'Marc Jbeily',      '+961-76-339104', 'LB-HVY-2022-215', 850.00, 15.00, 0, 'Active',  '2023-06-05'),
    ('DRV-06', N'Elias Skaff',      '+961-03-612099', 'LB-HVY-2019-309', 980.00, 20.00, 0, 'Active',  '2021-02-14'),
    ('DRV-07', N'Bilal Kabbara',    '+961-70-882100', 'LB-HVY-2021-412', 850.00, 15.00, 0, 'Active',  '2022-09-01'),
    ('DRV-08', N'Hassan Zein',      '+961-71-219400', 'LB-HVY-2020-518', 850.00, 15.00, 0, 'OnLeave', '2022-05-19'),
    ('DRV-09', N'Nabil Frem',       '+961-03-774123', 'LB-HVY-2023-601', 820.00, 15.00, 0, 'Active',  '2024-04-01'),
    ('DRV-10', N'Chadi Hayek',      '+961-76-881234', 'LB-HVY-2023-655', 820.00, 15.00, 1, 'Active',  '2024-08-12');
GO

INSERT INTO dbo.TowTrucks (TruckCode, LicensePlate, TruckModel, MaxPayloadKg, CurrentLat, CurrentLng, SpeedKmh, FleetStatus)
VALUES
    ('TRK-01', 'B 901120', N'Isuzu NPR 75 Hydraulic Flatbed', 6500, 33.893800, 35.501800, 38.5, 'EnRoute'),
    ('TRK-02', 'M 402310', N'Hino 300 Heavy Underlift',       8000, 33.898300, 35.552400, 52.0, 'Towing'),
    ('TRK-03', 'J 718290', N'Mitsubishi Fuso Canter Tilt',    5500, 33.980800, 35.617800,  0.0, 'Available'),
    ('TRK-04', 'G 551902', N'Mercedes-Benz Atego 1218',       7000, 33.856900, 35.541100,  0.0, 'Available'),
    ('TRK-05', 'J 339104', N'Isuzu NQR Coastal Recovery',     6000, 34.123000, 35.651900, 44.0, 'EnRoute'),
    ('TRK-06', 'Z 612099', N'MAN TGL 12.220 Mountain Winch',  9500, 33.846300, 35.902000,  0.0, 'Available'),
    ('TRK-07', 'N 882100', N'Hino Dutro Wheel-Lift',          6500, 34.255400, 35.658100,  0.0, 'Available'),
    ('TRK-08', 'S 219400', N'Hyundai Mighty EX8 Flatbed',     5000, 33.732200, 35.453900,  0.0, 'OffDuty');
GO

-- Historical closed driver-truck assignments (preserving truck rotation history!)
INSERT INTO dbo.DriverTruckAssignments (DriverId, TruckId, StartDate, EndDate, AssignmentNotes)
VALUES
    (1, 3, '2026-01-01T08:00:00', '2026-06-30T18:00:00', N'H1 coastal rotation on TRK-03 before moving to Beirut Central'),
    (3, 1, '2026-01-01T08:00:00', '2026-06-30T18:00:00', N'H1 Beirut rotation on TRK-01 before Jounieh assignment'),
    (9, 4, '2026-05-01T08:00:00', '2026-08-31T18:00:00', N'Summer relief coverage for Rabih Daoud on TRK-04'),
    (10, 2, '2026-07-01T08:00:00', '2026-09-15T18:00:00', N'Night-shift relief rotation on TRK-02');

-- Current active driver-truck assignments (EndDate IS NULL)
INSERT INTO dbo.DriverTruckAssignments (DriverId, TruckId, StartDate, EndDate, AssignmentNotes)
VALUES
    (1, 1, '2026-07-01T08:00:00', NULL, N'Primary Beirut Central CAD shift'),
    (2, 2, '2026-09-16T08:00:00', NULL, N'Primary Dora / Metn heavy recovery shift'),
    (3, 3, '2026-07-01T08:00:00', NULL, N'Primary Jounieh / Keserwan shift'),
    (4, 4, '2026-09-01T08:00:00', NULL, N'Hazmieh / Baabda shift (Off-day overtime active)'),
    (5, 5, '2026-01-01T08:00:00', NULL, N'Byblos coastal highway shift'),
    (6, 6, '2026-01-01T08:00:00', NULL, N'Zahle / Dahr El Baidar mountain shift'),
    (7, 7, '2026-01-01T08:00:00', NULL, N'Batroun / Tripoli northern corridor'),
    (8, 8, '2026-01-01T08:00:00', NULL, N'Damour / Sidon unit (currently OffDuty)');
GO

/*==============================================================================
  10. BULK GENERATE 120,000 HISTORICAL ROWS IN dbo.TowRequests,
      dbo.TowInvoices (WITH HISTORICAL 2024/2025/2026 TARIFFS),
      AND dbo.InvoicePayments (SEPARATE INSURER & CUSTOMER PAYMENTS)
==============================================================================*/
DISABLE TRIGGER dbo.trg_TowRequests_ImmutabilityAndAudit ON dbo.TowRequests;
DISABLE TRIGGER dbo.trg_TowInvoices_ProtectHistoricalPricing ON dbo.TowInvoices;
GO

;WITH
L0 AS (SELECT 1 AS c FROM (VALUES(1),(1),(1),(1),(1),(1),(1),(1),(1),(1)) AS T(c)),
L1 AS (SELECT 1 AS c FROM L0 AS A CROSS JOIN L0 AS B),
L2 AS (SELECT 1 AS c FROM L1 AS A CROSS JOIN L1 AS B),
L3 AS (SELECT 1 AS c FROM L2 AS A CROSS JOIN L1 AS B),
Nums AS (
    SELECT TOP (120000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS rn
    FROM L3
)
INSERT INTO dbo.TowRequests WITH (TABLOCK)
(
    RequestNumber, CustomerId, VehicleId, CallerPhone, IssueType, IssueNotes,
    PickupAddress, PickupLat, PickupLng, DestinationAddress, DestinationLat, DestinationLng,
    StraightLineDistanceKm, RouteDistanceKm, DistanceSource, RouteDurationMinutes,
    PolicyId, QuotaTierId, AssignedTruckId, AssignedDriverId, SubcontractorId,
    TruckPrioritySequence, IsNightShift, Status, RejectionReason, CreatedByUserId, CreatedAt, CompletedAt
)
SELECT
    CONCAT('TOW/HIST/', FORMAT(rn, '0000000')) AS RequestNumber,
    v.CustomerId,
    v.VehicleId,
    CONCAT('+961-70-', FORMAT(100000 + (rn % 899999), '000000')) AS CallerPhone,
    CHOOSE((rn % 6) + 1, 'Mechanical', 'Accident', 'Battery', 'Tire', 'Winch', 'Mechanical') AS IssueType,
    N'Historical normalized roadside dispatch record' AS IssueNotes,
    CHOOSE((rn % 6) + 1,
        N'Hamra Main Street, Beirut',
        N'Dora Highway Bridge, Metn',
        N'Jounieh Coastal Road, Keserwan',
        N'Hazmieh Damascus Road, Baabda',
        N'Nahr El Kalb Tunnel, Dbayeh',
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
    CAST(10.00 + (rn % 55) AS DECIMAL(8,2)) AS StraightLineDistanceKm,
    CAST(ROUND((10.00 + (rn % 55)) * 1.38, 2) AS DECIMAL(8,2)) AS RouteDistanceKm,
    CASE WHEN (rn % 5) = 0 THEN 'DispatcherVerifiedEstimate' ELSE 'OSRM_DrivingRoute' END AS DistanceSource,
    CAST(ROUND(((10.00 + (rn % 55)) * 1.38) * 1.4, 1) AS DECIMAL(6,1)) AS RouteDurationMinutes,
    CASE WHEN (rn % 10) = 9 THEN NULL ELSE ((rn % 1490) + 10) END AS PolicyId,
    NULL AS QuotaTierId,
    CASE WHEN (rn % 20) = 0 THEN NULL ELSE ((rn % 7) + 1) END AS AssignedTruckId,
    CASE WHEN (rn % 20) = 0 THEN NULL ELSE ((rn % 7) + 1) END AS AssignedDriverId,
    CASE WHEN (rn % 20) = 0 THEN ((rn % 5) + 1) ELSE NULL END AS SubcontractorId,
    10 AS TruckPrioritySequence,
    CASE WHEN (rn % 4) = 0 THEN 1 ELSE 0 END AS IsNightShift,
    CHOOSE((rn % 10) + 1, 'Done', 'Done', 'Done', 'Done', 'Done', 'Done', 'Done', 'UnableToLoad', 'Rejected', 'Done') AS Status,
    CASE WHEN (rn % 10) = 8 THEN N'Policy coverage declined by adjuster' ELSE NULL END AS RejectionReason,
    ((rn % 4) + 1) AS CreatedByUserId,
    DATEADD(MINUTE, -(rn * 9), '2026-11-01T12:00:00') AS CreatedAt,
    DATEADD(MINUTE, -(rn * 9) + 52, '2026-11-01T12:00:00') AS CompletedAt
FROM Nums
INNER JOIN dbo.Vehicles AS v
    ON v.VehicleId = (((rn - 1) % 3992) + 8);
GO

-- Bulk generate matching 120,000 normalized TowInvoices using year-accurate historical Tariffs!
;WITH InvoiceCalc AS
(
    SELECT
        tr.TowRequestId,
        tr.CustomerId,
        tr.PolicyId,
        p.ProviderId AS InsuranceProviderId,
        tr.RouteDistanceKm,
        tr.IsNightShift,
        tr.SubcontractorId,
        tr.Status,
        tr.CreatedAt,
        tf.TariffId,
        tf.BaseFee,
        tf.PricePerKm,
        CASE WHEN tr.IsNightShift = 1 THEN tf.NightSurcharge ELSE 0.00 END AS NightFee,
        CAST(CASE
            WHEN tr.PolicyId IS NOT NULL THEN (CASE WHEN tr.RouteDistanceKm <= 50.00 THEN tr.RouteDistanceKm ELSE 50.00 END)
            ELSE 0.00
        END AS DECIMAL(8,2)) AS CoveredKm,
        CAST(CASE
            WHEN tr.PolicyId IS NOT NULL THEN (CASE WHEN tr.RouteDistanceKm > 50.00 THEN tr.RouteDistanceKm - 50.00 ELSE 0.00 END)
            ELSE tr.RouteDistanceKm
        END AS DECIMAL(8,2)) AS OverageKm
    FROM dbo.TowRequests AS tr
    LEFT JOIN dbo.InsurancePolicies AS p ON tr.PolicyId = p.PolicyId
    INNER JOIN dbo.Tariffs AS tf ON tf.TariffId = (
        CASE
            WHEN tr.CreatedAt < '2025-01-01' THEN 1
            WHEN tr.CreatedAt < '2026-01-01' THEN 2
            WHEN tr.IssueType IN ('Accident', 'Winch') THEN 4
            ELSE 3
        END
    )
),
BilledCalc AS
(
    SELECT
        ic.*,
        CAST(CASE
            WHEN ic.Status = 'Rejected' THEN 0.00
            WHEN ic.PolicyId IS NOT NULL THEN ROUND(ic.BaseFee + (ic.CoveredKm * ic.PricePerKm) + ic.NightFee, 2)
            ELSE 0.00
        END AS DECIMAL(10,2)) AS InsBilled,
        CAST(CASE
            WHEN ic.Status = 'Rejected' THEN 0.00
            WHEN ic.PolicyId IS NOT NULL THEN ROUND(ic.OverageKm * ic.PricePerKm, 2)
            ELSE ROUND(ic.BaseFee + (ic.RouteDistanceKm * ic.PricePerKm) + ic.NightFee, 2)
        END AS DECIMAL(10,2)) AS CustBilled
    FROM InvoiceCalc AS ic
)
INSERT INTO dbo.TowInvoices WITH (TABLOCK)
(
    InvoiceNumber, TowRequestId, TariffId, InsuranceProviderId, CustomerId,
    AppliedBaseFee, AppliedPricePerKm, AppliedNightSurcharge,
    CoveredDistanceKm, OverageDistanceKm, SubcontractorCost,
    InsurerBilledAmount, CustomerBilledAmount, TotalAmount,
    InsurerPaidAmount, CustomerPaidAmount, InvoiceStatus, IssuedAt
)
SELECT
    CONCAT('INV/HIST/', FORMAT(bc.TowRequestId, '0000000')) AS InvoiceNumber,
    bc.TowRequestId,
    bc.TariffId,
    CASE WHEN bc.InsBilled > 0 THEN bc.InsuranceProviderId ELSE NULL END,
    bc.CustomerId,
    bc.BaseFee,
    bc.PricePerKm,
    bc.NightFee,
    bc.CoveredKm,
    bc.OverageKm,
    CASE WHEN bc.SubcontractorId IS NOT NULL THEN 55.00 ELSE 0.00 END,
    bc.InsBilled,
    bc.CustBilled,
    (bc.InsBilled + bc.CustBilled) AS TotalAmount,
    -- Historical settlement pattern: most paid in full, recent ~5% partially paid or unpaid
    CASE
        WHEN bc.Status = 'Rejected' THEN 0.00
        WHEN (bc.TowRequestId % 20) = 1 THEN ROUND(bc.InsBilled * 0.50, 2)
        WHEN (bc.TowRequestId % 20) = 2 THEN 0.00
        ELSE bc.InsBilled
    END AS InsurerPaidAmount,
    CASE
        WHEN bc.Status = 'Rejected' THEN 0.00
        WHEN (bc.TowRequestId % 20) = 2 THEN 0.00
        ELSE bc.CustBilled
    END AS CustomerPaidAmount,
    CASE
        WHEN bc.Status = 'Rejected' THEN 'Void'
        WHEN (bc.TowRequestId % 20) = 1 AND bc.InsBilled > 0 THEN 'PartiallyPaid'
        WHEN (bc.TowRequestId % 20) = 2 AND (bc.InsBilled + bc.CustBilled) > 0 THEN 'Unpaid'
        ELSE 'Paid'
    END AS InvoiceStatus,
    bc.CreatedAt
FROM BilledCalc AS bc;
GO

-- Populate corresponding individual payment rows in dbo.InvoicePayments for historical paid/partial invoices
INSERT INTO dbo.InvoicePayments WITH (TABLOCK)
(
    InvoiceId, PayerType, InsuranceProviderId, CustomerId, CollectedByDriverId,
    AmountPaid, PaymentMethod, ReferenceNumber, PaidAt, RecordedByUserId, Notes
)
SELECT
    inv.InvoiceId,
    'InsuranceProvider',
    inv.InsuranceProviderId,
    NULL,
    NULL,
    inv.InsurerPaidAmount,
    'InsurerBatchSettlement',
    CONCAT('BATCH-INS-', FORMAT(inv.IssuedAt, 'yyyyMM')),
    DATEADD(DAY, 15, inv.IssuedAt),
    4,
    CASE WHEN inv.InsurerPaidAmount < inv.InsurerBilledAmount
         THEN N'Partial 50% insurer tranche settlement'
         ELSE N'Full monthly insurer bordereau settlement'
    END
FROM dbo.TowInvoices AS inv
WHERE inv.InsurerPaidAmount > 0;
GO

INSERT INTO dbo.InvoicePayments WITH (TABLOCK)
(
    InvoiceId, PayerType, InsuranceProviderId, CustomerId, CollectedByDriverId,
    AmountPaid, PaymentMethod, ReferenceNumber, PaidAt, RecordedByUserId, Notes
)
SELECT
    inv.InvoiceId,
    'Customer',
    NULL,
    inv.CustomerId,
    tr.AssignedDriverId,
    inv.CustomerPaidAmount,
    CASE WHEN tr.AssignedDriverId IS NOT NULL THEN 'OnSceneCash' ELSE 'Card' END,
    CONCAT('RCPT-', inv.InvoiceId),
    DATEADD(MINUTE, 50, inv.IssuedAt),
    2,
    N'Customer excess/direct obligation payment'
FROM dbo.TowInvoices AS inv
INNER JOIN dbo.TowRequests AS tr ON inv.TowRequestId = tr.TowRequestId
WHERE inv.CustomerPaidAmount > 0;
GO

ENABLE TRIGGER dbo.trg_TowRequests_ImmutabilityAndAudit ON dbo.TowRequests;
ENABLE TRIGGER dbo.trg_TowInvoices_ProtectHistoricalPricing ON dbo.TowInvoices;
GO

/*==============================================================================
  11. SEED ACTIVE & DEMO OPERATIONAL TICKETS (WITH SESSION_CONTEXT & TRIGGERS!)
==============================================================================*/
-- Authenticate session context as Senior Dispatcher Rami Nassar (UserId = 2)
EXEC dbo.usp_SetDispatcherSessionContext @UserId = 2, @ExpectedUsername = 'dispatch.beirut', @UpdateLastLogin = 0;
GO

-- 1. Recent completed Mechanical tow 2 days ago on Policy 3 (triggers 7-day cooldown!)
INSERT INTO dbo.TowRequests
(
    RequestNumber, CustomerId, VehicleId, CallerPhone, IssueType, IssueNotes,
    PickupAddress, PickupLat, PickupLng, DestinationAddress, DestinationLat, DestinationLng,
    StraightLineDistanceKm, RouteDistanceKm, DistanceSource, RouteDurationMinutes,
    PolicyId, QuotaTierId, AssignedTruckId, AssignedDriverId, TruckPrioritySequence,
    IsNightShift, Status, CreatedByUserId, CreatedAt, CompletedAt
)
VALUES
(
    'TOW/2026/900001', 3, 1, '+961-71-333444', 'Mechanical', N'Alternator failure on Antelias highway (Completed 2 days ago)',
    N'Antelias Highway, Metn', 33.914400, 35.586800, N'Zalka Mercedes Service', 33.898900, 35.569800,
    2.33, 18.50, 'OSRM_DrivingRoute', 24.0,
    3, 6, 3, 3, 10,
    1, 'Done', 2, DATEADD(DAY, -2, SYSDATETIME()), DATEADD(HOUR, -47, SYSDATETIME())
);

DECLARE @Req900001 INT = SCOPE_IDENTITY();
INSERT INTO dbo.TowInvoices
(
    InvoiceNumber, TowRequestId, TariffId, InsuranceProviderId, CustomerId,
    AppliedBaseFee, AppliedPricePerKm, AppliedNightSurcharge,
    CoveredDistanceKm, OverageDistanceKm, SubcontractorCost,
    InsurerBilledAmount, CustomerBilledAmount, TotalAmount,
    InsurerPaidAmount, CustomerPaidAmount, InvoiceStatus, IssuedAt
)
VALUES
(
    'INV/2026/900001', @Req900001, 3, 3, 3,
    35.00, 2.50, 15.00,
    18.50, 0.00, 0.00,
    96.25, 0.00, 96.25,
    50.00, 0.00, 'PartiallyPaid', DATEADD(DAY, -2, SYSDATETIME())
);
DECLARE @Inv900001 INT = SCOPE_IDENTITY();
INSERT INTO dbo.InvoicePayments (InvoiceId, PayerType, InsuranceProviderId, AmountPaid, PaymentMethod, ReferenceNumber, RecordedByUserId, Notes)
VALUES (@Inv900001, 'InsuranceProvider', 3, 50.00, 'BankTransfer', 'WIRE-AXA-900001-P1', 4, N'First partial insurer advance ($46.25 balance remaining)');
GO

-- Authenticate session context as Chief Director Assaad Khalife (UserId = 1)
EXEC dbo.usp_SetDispatcherSessionContext @UserId = 1, @ExpectedUsername = 'assaad.khalife', @UpdateLastLogin = 0;
GO

-- 2. Active Queue on TRK-01 (Stop 10 = InProgress, Stop 20 = Approved)
INSERT INTO dbo.TowRequests
(
    RequestNumber, CustomerId, VehicleId, CallerPhone, IssueType, IssueNotes,
    PickupAddress, PickupLat, PickupLng, DestinationAddress, DestinationLat, DestinationLng,
    StraightLineDistanceKm, RouteDistanceKm, DistanceSource, RouteDurationMinutes,
    PolicyId, QuotaTierId, AssignedTruckId, AssignedDriverId, TruckPrioritySequence,
    IsNightShift, Status, CreatedByUserId, CreatedAt
)
VALUES
(
    'TOW/2026/900002', 1, 2, '+961-03-111222', 'Mechanical', N'Engine overheating near Downtown Beirut tunnel',
    N'Martyrs Square / Ring Bridge, Beirut', 33.895800, 35.507200, N'Bouchrieh BMW Specialist Garage', 33.892100, 35.554200,
    4.36, 12.40, 'OSRM_DrivingRoute', 19.5,
    1, 1, 1, 1, 10,
    0, 'InProgress', 1, DATEADD(MINUTE, -35, SYSDATETIME())
),
(
    'TOW/2026/900003', 6, 3, '+961-03-666777', 'Tire', N'Double tire blowout on Hazmieh incline (Queued Stop #2)',
    N'Hazmieh Mar Takla Roundabout', 33.854200, 35.535100, N'Mkalles Tire & Alignment Center', 33.876100, 35.545000,
    2.60, 9.80, 'OSRM_DrivingRoute', 16.0,
    NULL, NULL, 1, 1, 20,
    0, 'Approved', 1, DATEADD(MINUTE, -20, SYSDATETIME())
);

INSERT INTO dbo.TowInvoices
(
    InvoiceNumber, TowRequestId, TariffId, InsuranceProviderId, CustomerId,
    AppliedBaseFee, AppliedPricePerKm, AppliedNightSurcharge,
    CoveredDistanceKm, OverageDistanceKm, SubcontractorCost,
    InsurerBilledAmount, CustomerBilledAmount, TotalAmount,
    InsurerPaidAmount, CustomerPaidAmount, InvoiceStatus
)
SELECT 'INV/2026/900002', TowRequestId, 3, 1, 1, 35.00, 2.50, 0.00, 12.40, 0.00, 0.00, 66.00, 0.00, 66.00, 0.00, 0.00, 'Unpaid'
FROM dbo.TowRequests WHERE RequestNumber = 'TOW/2026/900002'
UNION ALL
SELECT 'INV/2026/900003', TowRequestId, 3, NULL, 6, 35.00, 2.50, 0.00, 0.00, 9.80, 0.00, 0.00, 59.50, 59.50, 0.00, 25.00, 'PartiallyPaid'
FROM dbo.TowRequests WHERE RequestNumber = 'TOW/2026/900003';

INSERT INTO dbo.InvoicePayments (InvoiceId, PayerType, CustomerId, CollectedByDriverId, AmountPaid, PaymentMethod, ReferenceNumber, RecordedByUserId, Notes)
SELECT InvoiceId, 'Customer', 6, 1, 25.00, 'OnSceneCash', 'CASH-900003-P1', 1, N'Partial cash deposit collected by Antoine Geagea ($34.50 due at garage)'
FROM dbo.TowInvoices WHERE InvoiceNumber = 'INV/2026/900003';

-- 3. Active Queue on TRK-02 (Stop 10 = InProgress, Stop 20 = Approved)
INSERT INTO dbo.TowRequests
(
    RequestNumber, CustomerId, VehicleId, CallerPhone, IssueType, IssueNotes,
    PickupAddress, PickupLat, PickupLng, DestinationAddress, DestinationLat, DestinationLng,
    StraightLineDistanceKm, RouteDistanceKm, DistanceSource, RouteDurationMinutes,
    PolicyId, QuotaTierId, AssignedTruckId, AssignedDriverId, TruckPrioritySequence,
    IsNightShift, Status, CreatedByUserId, CreatedAt
)
VALUES
(
    'TOW/2026/900004', 7, 4, '+961-70-777888', 'Accident', N'Front bumper collision on Dbayeh seaside road',
    N'Dbayeh Waterfront Highway', 33.931000, 35.589000, N'Zouk Mosbeh Land Rover Bodyshop', 33.961000, 35.611000,
    3.90, 68.00, 'OSRM_DrivingRoute', 58.0,
    10, NULL, 2, 2, 10,
    0, 'InProgress', 1, DATEADD(MINUTE, -40, SYSDATETIME())
),
(
    'TOW/2026/900005', 8, 5, '+961-71-888999', 'Battery', N'Dead 12V battery at CityMall underground parking',
    N'Dora CityMall Entrance, Metn', 33.896200, 35.557100, N'Dekwaneh Audi Workshop', 33.884100, 35.548200,
    1.58, 7.20, 'OSRM_DrivingRoute', 14.0,
    NULL, NULL, 2, 2, 20,
    0, 'Approved', 1, DATEADD(MINUTE, -12, SYSDATETIME())
);

INSERT INTO dbo.TowInvoices
(
    InvoiceNumber, TowRequestId, TariffId, InsuranceProviderId, CustomerId,
    AppliedBaseFee, AppliedPricePerKm, AppliedNightSurcharge,
    CoveredDistanceKm, OverageDistanceKm, SubcontractorCost,
    InsurerBilledAmount, CustomerBilledAmount, TotalAmount,
    InsurerPaidAmount, CustomerPaidAmount, InvoiceStatus
)
SELECT 'INV/2026/900004', TowRequestId, 4, 5, 7, 50.00, 3.00, 0.00, 50.00, 18.00, 0.00, 200.00, 54.00, 254.00, 100.00, 20.00, 'PartiallyPaid'
FROM dbo.TowRequests WHERE RequestNumber = 'TOW/2026/900004'
UNION ALL
SELECT 'INV/2026/900005', TowRequestId, 3, NULL, 8, 35.00, 2.50, 0.00, 0.00, 7.20, 0.00, 0.00, 53.00, 53.00, 0.00, 0.00, 'Unpaid'
FROM dbo.TowRequests WHERE RequestNumber = 'TOW/2026/900005';

INSERT INTO dbo.InvoicePayments (InvoiceId, PayerType, InsuranceProviderId, CustomerId, CollectedByDriverId, AmountPaid, PaymentMethod, ReferenceNumber, RecordedByUserId, Notes)
SELECT InvoiceId, 'InsuranceProvider', 5, NULL, NULL, 100.00, 'BankTransfer', 'WIRE-ALZ-900004-P1', 4, N'50% Insurer partial advance ($100.00 insurer balance remaining)'
FROM dbo.TowInvoices WHERE InvoiceNumber = 'INV/2026/900004'
UNION ALL
SELECT InvoiceId, 'Customer', NULL, 7, 2, 20.00, 'OnSceneCash', 'CASH-900004-P1', 2, N'Partial excess KM cash collected by Fadi Abi Khalil ($34.00 customer balance remaining)'
FROM dbo.TowInvoices WHERE InvoiceNumber = 'INV/2026/900004';

-- 4. TWO DRAFT ACCIDENT REQUESTS FOR POLICY 2 ('POL-2026-ACC-LAST1' — ONLY 1 ACCIDENT TOW LEFT!)
INSERT INTO dbo.TowRequests
(
    RequestNumber, CustomerId, VehicleId, CallerPhone, IssueType, IssueNotes,
    PickupAddress, PickupLat, PickupLng, DestinationAddress, DestinationLat, DestinationLng,
    StraightLineDistanceKm, RouteDistanceKm, DistanceSource, RouteDurationMinutes,
    PolicyId, QuotaTierId, AssignedTruckId, AssignedDriverId, TruckPrioritySequence,
    IsNightShift, Status, CreatedByUserId, CreatedAt
)
VALUES
(
    'TOW/2026/900006', 2, 6, '+961-70-222333', 'Accident', N'[RACE TEST A] Guardrail impact on Nahr El Mot highway',
    N'Nahr El Mot Highway, Metn', 33.906100, 35.568200, N'Jdeideh Toyota Repair Center', 33.892000, 35.561000,
    1.70, 22.00, 'OSRM_DrivingRoute', 25.0,
    2, 5, NULL, NULL, 10,
    0, 'Draft', 1, DATEADD(MINUTE, -5, SYSDATETIME())
),
(
    'TOW/2026/900007', 2, 7, '+961-70-222333', 'Accident', N'[RACE TEST B] Simultaneous accident claim on same policy POL-2026-ACC-LAST1',
    N'Jal El Dib Autostrade, Metn', 33.910200, 35.575400, N'Sin El Fil Lexus Bodyshop', 33.878000, 35.539000,
    4.91, 26.00, 'OSRM_DrivingRoute', 29.0,
    2, 5, NULL, NULL, 10,
    0, 'Draft', 2, DATEADD(MINUTE, -4, SYSDATETIME())
);

INSERT INTO dbo.TowInvoices
(
    InvoiceNumber, TowRequestId, TariffId, InsuranceProviderId, CustomerId,
    AppliedBaseFee, AppliedPricePerKm, AppliedNightSurcharge,
    CoveredDistanceKm, OverageDistanceKm, SubcontractorCost,
    InsurerBilledAmount, CustomerBilledAmount, TotalAmount, InvoiceStatus
)
SELECT 'INV/2026/900006', TowRequestId, 4, 2, 2, 50.00, 3.00, 0.00, 22.00, 0.00, 0.00, 116.00, 0.00, 116.00, 'Draft'
FROM dbo.TowRequests WHERE RequestNumber = 'TOW/2026/900006'
UNION ALL
SELECT 'INV/2026/900007', TowRequestId, 4, 2, 2, 50.00, 3.00, 0.00, 26.00, 0.00, 0.00, 128.00, 0.00, 128.00, 'Draft'
FROM dbo.TowRequests WHERE RequestNumber = 'TOW/2026/900007';

EXEC dbo.usp_ClearDispatcherSessionContext;
GO

/*------------------------------------------------------------------------------
  11B. SEED BASELINE NORMALIZED 3NF ENTITY CHANGE LOGS (AuditChangeEvents & Details)
------------------------------------------------------------------------------*/
DECLARE @E1 BIGINT, @E2 BIGINT, @E3 BIGINT, @E4 BIGINT, @E5 BIGINT, @E6 BIGINT;

INSERT INTO dbo.AuditChangeEvents (EntityType, EntityId, EntityCode, OperationType, ChangedByUserId, ChangedAt)
VALUES ('SystemUsers', 2, 'dispatch.beirut', 'UPDATE', 1, DATEADD(HOUR, -18, SYSDATETIME()));
SET @E1 = SCOPE_IDENTITY();
INSERT INTO dbo.AuditChangeDetails (ChangeEventId, FieldName, OldValue, NewValue)
VALUES (@E1, 'CanManageBilling', N'false', N'true'),
       (@E1, 'StationCode',      N'BEY-DSK-02', N'BEY-DSK-04');

INSERT INTO dbo.AuditChangeEvents (EntityType, EntityId, EntityCode, OperationType, ChangedByUserId, ChangedAt)
VALUES ('TowTrucks', 1, 'TRK-BEY-01', 'UPDATE', 3, DATEADD(HOUR, -14, SYSDATETIME()));
SET @E2 = SCOPE_IDENTITY();
INSERT INTO dbo.AuditChangeDetails (ChangeEventId, FieldName, OldValue, NewValue)
VALUES (@E2, 'MaxPayloadKg', N'4500', N'5500'),
       (@E2, 'FleetStatus',  N'Maintenance', N'Available');

INSERT INTO dbo.AuditChangeEvents (EntityType, EntityId, EntityCode, OperationType, ChangedByUserId, ChangedAt)
VALUES ('Drivers', 1, 'DRV-101', 'UPDATE', 3, DATEADD(HOUR, -10, SYSDATETIME()));
SET @E3 = SCOPE_IDENTITY();
INSERT INTO dbo.AuditChangeDetails (ChangeEventId, FieldName, OldValue, NewValue)
VALUES (@E3, 'BaseMonthlySalary',  N'850.00', N'950.00'),
       (@E3, 'OvertimeRatePerTow', N'15.00',  N'18.00');

INSERT INTO dbo.AuditChangeEvents (EntityType, EntityId, EntityCode, OperationType, ChangedByUserId, ChangedAt)
VALUES ('DriverTruckAssignments', 1, 'DRV-101 -> TRK-BEY-01', 'CREATE', 3, DATEADD(HOUR, -9, SYSDATETIME()));
SET @E4 = SCOPE_IDENTITY();
INSERT INTO dbo.AuditChangeDetails (ChangeEventId, FieldName, OldValue, NewValue)
VALUES (@E4, 'Driver',   NULL, N'Fadi Karam (DRV-101)'),
       (@E4, 'TowTruck', NULL, N'TRK-BEY-01');

INSERT INTO dbo.AuditChangeEvents (EntityType, EntityId, EntityCode, OperationType, ChangedByUserId, ChangedAt)
VALUES ('Tariffs', 3, 'TRF-2026-MECH', 'CREATE', 1, DATEADD(DAY, -3, SYSDATETIME()));
SET @E5 = SCOPE_IDENTITY();
INSERT INTO dbo.AuditChangeDetails (ChangeEventId, FieldName, OldValue, NewValue)
VALUES (@E5, 'BaseFee',        NULL, N'$35.00'),
       (@E5, 'PricePerKm',     NULL, N'$2.50/km'),
       (@E5, 'NightSurcharge', NULL, N'$15.00');

INSERT INTO dbo.AuditChangeEvents (EntityType, EntityId, EntityCode, OperationType, ChangedByUserId, ChangedAt)
VALUES ('InsurancePolicies', 1, 'POL-2026-0001', 'UPDATE', 4, DATEADD(HOUR, -5, SYSDATETIME()));
SET @E6 = SCOPE_IDENTITY();
INSERT INTO dbo.AuditChangeDetails (ChangeEventId, FieldName, OldValue, NewValue)
VALUES (@E6, 'DefaultAllowedKm', N'40.00', N'50.00');
GO

/*------------------------------------------------------------------------------
  12. ADVANCE SEQUENCES & UPDATE STATISTICS WITH FULLSCAN FOR EXECUTION PLANS
------------------------------------------------------------------------------*/
ALTER SEQUENCE dbo.seq_TowRequestNumber RESTART WITH 900020;
ALTER SEQUENCE dbo.seq_TowInvoiceNumber RESTART WITH 900020;
GO

UPDATE STATISTICS dbo.Vehicles WITH FULLSCAN;
UPDATE STATISTICS dbo.TowRequests WITH FULLSCAN;
UPDATE STATISTICS dbo.TowInvoices WITH FULLSCAN;
UPDATE STATISTICS dbo.InvoicePayments WITH FULLSCAN;
UPDATE STATISTICS dbo.InsurancePolicies WITH FULLSCAN;
UPDATE STATISTICS dbo.PolicyQuotaTiers WITH FULLSCAN;
UPDATE STATISTICS dbo.Drivers WITH FULLSCAN;
UPDATE STATISTICS dbo.TowTrucks WITH FULLSCAN;
UPDATE STATISTICS dbo.DriverTruckAssignments WITH FULLSCAN;
UPDATE STATISTICS dbo.Tariffs WITH FULLSCAN;
GO

DECLARE @TotalRequests INT = (SELECT COUNT(*) FROM dbo.TowRequests);
DECLARE @TotalInvoices INT = (SELECT COUNT(*) FROM dbo.TowInvoices);
DECLARE @TotalPayments INT = (SELECT COUNT(*) FROM dbo.InvoicePayments);
PRINT CONCAT('03_seed_120k_data.sql completed. TowRequests=', @TotalRequests, ', TowInvoices=', @TotalInvoices, ', InvoicePayments=', @TotalPayments);
GO
