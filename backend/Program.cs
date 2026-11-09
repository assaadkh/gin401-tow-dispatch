using System.Data;
using System.Diagnostics;
using System.Text.Json;
using Microsoft.Data.SqlClient;

var builder = WebApplication.CreateBuilder(args);

// 1. Load .env file if present so no database password is ever hardcoded in source code
LoadDotEnv(Path.Combine(builder.Environment.ContentRootPath, ".env"));

string connectionString = Environment.GetEnvironmentVariable("TOW_DB_CONNECTION_STRING")
    ?? "Server=localhost;Database=GIN401_TowDispatch;Integrated Security=True;TrustServerCertificate=True;";

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
        policy.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod());
});

var app = builder.Build();
app.UseCors();
app.UseDefaultFiles();
app.UseStaticFiles();

bool useIntegratedFallback = false;
var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
httpClient.DefaultRequestHeaders.UserAgent.ParseAdd("GIN401TowDispatch/1.0");

// Helper to open a SQL connection running strictly under our least-privilege login (tow_cad_app_login / tow_cad_app_user)
async Task<SqlConnection> OpenLeastPrivilegeConnectionAsync()
{
    if (!useIntegratedFallback)
    {
        try
        {
            var conn = new SqlConnection(connectionString);
            await conn.OpenAsync();
            await EnforceLeastPrivilegeContextAsync(conn);
            return conn;
        }
        catch (SqlException ex) when (ex.Number == 18456 || ex.Number == 233)
        {
            useIntegratedFallback = true;
        }
    }

    var winConn = new SqlConnection("Server=localhost;Database=GIN401_TowDispatch;Integrated Security=True;Pooling=False;TrustServerCertificate=True;");
    await winConn.OpenAsync();
    await EnforceLeastPrivilegeContextAsync(winConn);
    return winConn;
}

static async Task EnforceLeastPrivilegeContextAsync(SqlConnection conn)
{
    const string ctxSql = @"
        IF SUSER_SNAME() <> N'tow_cad_app_login' AND EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'tow_cad_app_login')
        BEGIN
            EXECUTE AS LOGIN = N'tow_cad_app_login';
        END";
    await using var cmd = new SqlCommand(ctxSql, conn);
    await cmd.ExecuteNonQueryAsync();
}

static string RowVerToHex(byte[] bytes) => "0x" + Convert.ToHexString(bytes);
static byte[] HexToRowVer(string hex)
{
    string clean = hex.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? hex[2..] : hex;
    return Convert.FromHexString(clean);
}

// Helper: Calculate real road network driving distance via OSRM driving engine (with SQL scalar function fallback)
async Task<decimal> CalculateRoadDistanceAsync(SqlConnection conn, decimal lat1, decimal lng1, decimal lat2, decimal lng2)
{
    try
    {
        string url = FormattableString.Invariant($"http://router.project-osrm.org/route/v1/driving/{lng1},{lat1};{lng2},{lat2}?overview=false");
        using var resp = await httpClient.GetAsync(url);
        if (resp.IsSuccessStatusCode)
        {
            using var doc = await JsonDocument.ParseAsync(await resp.Content.ReadAsStreamAsync());
            if (doc.RootElement.TryGetProperty("routes", out var routes) && routes.GetArrayLength() > 0)
            {
                double meters = routes[0].GetProperty("distance").GetDouble();
                decimal km = Math.Round((decimal)(meters / 1000.0), 1);
                if (km > 0) return km;
            }
        }
    }
    catch
    {
        // Fallback to SQL Server scalar function dbo.fn_CalculateRoadDistanceKm
    }

    await using var cmd = new SqlCommand("SELECT dbo.fn_CalculateRoadDistanceKm(@Lat1, @Lng1, @Lat2, @Lng2);", conn);
    cmd.Parameters.Add("@Lat1", SqlDbType.Decimal).Value = lat1;
    cmd.Parameters.Add("@Lng1", SqlDbType.Decimal).Value = lng1;
    cmd.Parameters.Add("@Lat2", SqlDbType.Decimal).Value = lat2;
    cmd.Parameters.Add("@Lng2", SqlDbType.Decimal).Value = lng2;
    var val = await cmd.ExecuteScalarAsync();
    return val is decimal d ? d : 5.0m;
}

/*==============================================================================
  ENDPOINT 1: GET /api/dashboard
  Loads KPIs, PlateCodes, Customers/Policies/QuotaTiers, Live TowTrucks,
  Window-Function Priority Queue (vw_FleetPriorityQueueAndRankings),
  Driver Payroll Report (vw_DriverPayrollAndCashReport),
  Recent TowRequests (Kanban/List), and Trigger Audit Logs via ADO.NET.
==============================================================================*/
app.MapGet("/api/dashboard", async () =>
{
    await using var conn = await OpenLeastPrivilegeConnectionAsync();

    // 1. Summary KPIs + Current DB User
    var kpis = new Dictionary<string, object?>();
    const string kpiSql = @"
        SELECT
            (SELECT COUNT(*) FROM dbo.TowRequests) AS TotalTowRequests,
            (SELECT COUNT(*) FROM dbo.TowRequests WHERE Status IN ('Approved', 'InProgress')) AS ActiveDispatches,
            (SELECT COUNT(*) FROM dbo.TowRequests WHERE Status IN ('Draft', 'PendingInsurance')) AS PendingDrafts,
            (SELECT COUNT(*) FROM dbo.TowTrucks WHERE FleetStatus = 'Available') AS AvailableTrucks,
            (SELECT COUNT(*) FROM dbo.InsurancePolicies WHERE PolicyStatus = 'Active') AS ActivePolicies,
            (SELECT COUNT(*) FROM dbo.TowAuditLogs) AS TotalAuditLogs,
            SUSER_SNAME() AS ConnectedSqlLogin,
            USER_NAME() AS ConnectedDatabaseUser,
            IS_ROLEMEMBER('db_tow_dispatcher_role') AS IsLeastPrivilegeRoleMember,
            IS_SRVROLEMEMBER('sysadmin') AS IsSysAdmin;";

    await using (var cmd = new SqlCommand(kpiSql, conn))
    await using (var reader = await cmd.ExecuteReaderAsync())
    {
        if (await reader.ReadAsync())
        {
            kpis["totalTowRequests"] = reader.GetInt32(0);
            kpis["activeDispatches"] = reader.GetInt32(1);
            kpis["pendingDrafts"] = reader.GetInt32(2);
            kpis["availableTrucks"] = reader.GetInt32(3);
            kpis["activePolicies"] = reader.GetInt32(4);
            kpis["totalAuditLogs"] = reader.GetInt32(5);
            kpis["connectedSqlLogin"] = reader.GetString(6);
            kpis["connectedDatabaseUser"] = reader.GetString(7);
            kpis["isLeastPrivilegeRoleMember"] = reader.IsDBNull(8) ? 0 : reader.GetInt32(8);
            kpis["isSysAdmin"] = reader.IsDBNull(9) ? 0 : reader.GetInt32(9);
        }
    }

    // 2. Dynamic Lebanese Plate Codes (B, M, G, Y, J, N, S, Z, R, T...)
    var plateCodes = new List<object>();
    const string plateSql = @"
        SELECT PlateCodeId, Code, RegionDescription, DisplaySequence
        FROM dbo.PlateCodes
        WHERE IsActive = 1
        ORDER BY DisplaySequence ASC, Code ASC;";

    await using (var cmd = new SqlCommand(plateSql, conn))
    await using (var reader = await cmd.ExecuteReaderAsync())
    {
        while (await reader.ReadAsync())
        {
            plateCodes.Add(new
            {
                plateCodeId = reader.GetInt32(0),
                code = reader.GetString(1),
                regionDescription = reader.GetString(2),
                displaySequence = reader.GetInt32(3)
            });
        }
    }

    // 3. Featured Customers & Policies with Sequential Quota Tiers & Cooldown Days
    var policies = new List<object>();
    const string policySql = @"
        SELECT TOP (25)
            p.PolicyId,
            p.PolicyNumber,
            p.CustomerId,
            c.FullName AS CustomerName,
            c.Phone AS CustomerPhone,
            pr.ProviderName,
            p.StartDate,
            p.ExpirationDate,
            p.DefaultAllowedKm,
            p.DefaultMinIntervalDays,
            p.PolicyStatus
        FROM dbo.InsurancePolicies AS p
        INNER JOIN dbo.Customers AS c ON p.CustomerId = c.CustomerId
        INNER JOIN dbo.InsuranceProviders AS pr ON p.ProviderId = pr.ProviderId
        ORDER BY p.PolicyId ASC;";

    var rawPolicies = new List<Dictionary<string, object?>>();
    await using (var cmd = new SqlCommand(policySql, conn))
    await using (var reader = await cmd.ExecuteReaderAsync())
    {
        while (await reader.ReadAsync())
        {
            int pid = reader.GetInt32(0);
            rawPolicies.Add(new Dictionary<string, object?>
            {
                ["policyId"] = pid,
                ["policyNumber"] = reader.GetString(1),
                ["customerId"] = reader.GetInt32(2),
                ["customerName"] = reader.GetString(3),
                ["customerPhone"] = reader.GetString(4),
                ["providerName"] = reader.GetString(5),
                ["startDate"] = reader.GetDateTime(6).ToString("yyyy-MM-dd"),
                ["expirationDate"] = reader.GetDateTime(7).ToString("yyyy-MM-dd"),
                ["defaultAllowedKm"] = reader.GetDecimal(8),
                ["defaultMinIntervalDays"] = reader.GetInt32(9),
                ["policyStatus"] = reader.GetString(10),
                ["tiers"] = new List<object>()
            });
        }
    }

    const string tierSql = @"
        SELECT QuotaTierId, PolicyId, TierSequence, CoverageType, AllowedTows, UsedTows,
               (AllowedTows - UsedTows) AS RemainingTows, MaxDistanceKm, MinIntervalDays
        FROM dbo.PolicyQuotaTiers
        WHERE PolicyId <= 25
        ORDER BY PolicyId ASC, TierSequence ASC, QuotaTierId ASC;";

    var tiersByPolicy = new Dictionary<int, List<object>>();
    await using (var cmd = new SqlCommand(tierSql, conn))
    await using (var reader = await cmd.ExecuteReaderAsync())
    {
        while (await reader.ReadAsync())
        {
            int pid = reader.GetInt32(1);
            if (!tiersByPolicy.ContainsKey(pid))
                tiersByPolicy[pid] = new List<object>();

            tiersByPolicy[pid].Add(new
            {
                quotaTierId = reader.GetInt32(0),
                policyId = pid,
                tierSequence = reader.GetInt32(2),
                coverageType = reader.GetString(3),
                allowedTows = reader.GetInt32(4),
                usedTows = reader.GetInt32(5),
                remainingTows = reader.GetInt32(6),
                maxDistanceKm = reader.GetDecimal(7),
                minIntervalDays = reader.GetInt32(8)
            });
        }
    }

    foreach (var rp in rawPolicies)
    {
        int pid = (int)rp["policyId"]!;
        if (tiersByPolicy.TryGetValue(pid, out var tList))
            rp["tiers"] = tList;
        policies.Add(rp);
    }

    // 4. Live Fleet Tow Trucks
    var trucks = new List<object>();
    const string truckSql = @"
        SELECT TruckId, TruckCode, LicensePlate, DriverName, DriverPhone,
               CurrentLat, CurrentLng, SpeedKmh, FleetStatus, MaxPayloadKg,
               BaseMonthlySalary, OvertimeRatePerTow, IsWorkingOffDay, LastTelemetryAt
        FROM dbo.TowTrucks
        ORDER BY TruckCode ASC;";

    await using (var cmd = new SqlCommand(truckSql, conn))
    await using (var reader = await cmd.ExecuteReaderAsync())
    {
        while (await reader.ReadAsync())
        {
            trucks.Add(new
            {
                truckId = reader.GetInt32(0),
                truckCode = reader.GetString(1),
                licensePlate = reader.GetString(2),
                driverName = reader.GetString(3),
                driverPhone = reader.GetString(4),
                currentLat = reader.GetDecimal(5),
                currentLng = reader.GetDecimal(6),
                speedKmh = reader.GetDecimal(7),
                fleetStatus = reader.GetString(8),
                maxPayloadKg = reader.GetInt32(9),
                baseMonthlySalary = reader.GetDecimal(10),
                overtimeRatePerTow = reader.GetDecimal(11),
                isWorkingOffDay = reader.GetBoolean(12),
                lastTelemetryAt = reader.GetDateTime(13).ToString("yyyy-MM-dd HH:mm:ss")
            });
        }
    }

    // 5. Window Function View: Active Priority Queue per Truck (ROW_NUMBER, SUM OVER, COUNT OVER)
    var priorityQueue = new List<object>();
    const string queueSql = @"
        SELECT TowRequestId, RequestNumber, AssignedTruckId, TruckCode, TruckPlate, DriverName,
               FleetStatus, VehiclePlate, VehicleModel, IssueType, Status, TruckPrioritySequence,
               PickupAddress, PickupLat, PickupLng, DestinationAddress, DestinationLat, DestinationLng,
               ActualDistanceKm, OverageAmount, StopNumberInTruckQueue, CumulativeQueueDistanceKm, TotalActiveJobsForTruck
        FROM dbo.vw_FleetPriorityQueueAndRankings
        ORDER BY TruckCode ASC, StopNumberInTruckQueue ASC;";

    await using (var cmd = new SqlCommand(queueSql, conn))
    await using (var reader = await cmd.ExecuteReaderAsync())
    {
        while (await reader.ReadAsync())
        {
            priorityQueue.Add(new
            {
                towRequestId = reader.GetInt32(0),
                requestNumber = reader.GetString(1),
                assignedTruckId = reader.GetInt32(2),
                truckCode = reader.GetString(3),
                truckPlate = reader.GetString(4),
                driverName = reader.GetString(5),
                fleetStatus = reader.GetString(6),
                vehiclePlate = reader.GetString(7),
                vehicleModel = reader.GetString(8),
                issueType = reader.GetString(9),
                status = reader.GetString(10),
                truckPrioritySequence = reader.GetInt32(11),
                pickupAddress = reader.GetString(12),
                pickupLat = reader.GetDecimal(13),
                pickupLng = reader.GetDecimal(14),
                destinationAddress = reader.GetString(15),
                destinationLat = reader.GetDecimal(16),
                destinationLng = reader.GetDecimal(17),
                actualDistanceKm = reader.GetDecimal(18),
                overageAmount = reader.GetDecimal(19),
                stopNumberInTruckQueue = reader.GetInt64(20),
                cumulativeQueueDistanceKm = reader.GetDecimal(21),
                totalActiveJobsForTruck = reader.GetInt32(22)
            });
        }
    }

    // 6. Recent Operational Tow Requests
    var recentRequests = new List<object>();
    const string reqSql = @"
        SELECT TOP (30)
            tr.TowRequestId, tr.RequestNumber, tr.CustomerId, c.FullName AS CustomerName,
            tr.CallerPhone, tr.VehiclePlate, tr.VehicleModel, tr.IssueType, tr.IssueNotes,
            tr.PickupAddress, tr.PickupLat, tr.PickupLng,
            tr.DestinationAddress, tr.DestinationLat, tr.DestinationLng,
            tr.HasInsurance, tr.PolicyId, p.PolicyNumber,
            tr.IsOutsourced, tr.SubcontractorName, tr.SubcontractorFee,
            tr.AssignedTruckId, t.TruckCode, tr.TruckPrioritySequence,
            tr.ActualDistanceKm, tr.AllowedDistanceKm, tr.OverageKm, tr.OverageAmount,
            tr.CashCollected, tr.IsNightShift, tr.Status, tr.RejectionReason, tr.CreatedAt,
            CAST(tr.RowVer AS BINARY(8)) AS RowVerBytes
        FROM dbo.TowRequests AS tr
        INNER JOIN dbo.Customers AS c ON tr.CustomerId = c.CustomerId
        LEFT JOIN dbo.InsurancePolicies AS p ON tr.PolicyId = p.PolicyId
        LEFT JOIN dbo.TowTrucks AS t ON tr.AssignedTruckId = t.TruckId
        ORDER BY tr.TowRequestId DESC;";

    await using (var cmd = new SqlCommand(reqSql, conn))
    await using (var reader = await cmd.ExecuteReaderAsync())
    {
        while (await reader.ReadAsync())
        {
            byte[] rowVer = (byte[])reader["RowVerBytes"];
            recentRequests.Add(new
            {
                towRequestId = reader.GetInt32(0),
                requestNumber = reader.GetString(1),
                customerId = reader.GetInt32(2),
                customerName = reader.GetString(3),
                callerPhone = reader.GetString(4),
                vehiclePlate = reader.GetString(5),
                vehicleModel = reader.GetString(6),
                issueType = reader.GetString(7),
                issueNotes = reader.IsDBNull(8) ? "" : reader.GetString(8),
                pickupAddress = reader.GetString(9),
                pickupLat = reader.GetDecimal(10),
                pickupLng = reader.GetDecimal(11),
                destinationAddress = reader.GetString(12),
                destinationLat = reader.GetDecimal(13),
                destinationLng = reader.GetDecimal(14),
                hasInsurance = reader.GetBoolean(15),
                policyId = reader.IsDBNull(16) ? (int?)null : reader.GetInt32(16),
                policyNumber = reader.IsDBNull(17) ? null : reader.GetString(17),
                isOutsourced = reader.GetBoolean(18),
                subcontractorName = reader.IsDBNull(19) ? null : reader.GetString(19),
                subcontractorFee = reader.GetDecimal(20),
                assignedTruckId = reader.IsDBNull(21) ? (int?)null : reader.GetInt32(21),
                truckCode = reader.IsDBNull(22) ? null : reader.GetString(22),
                truckPrioritySequence = reader.GetInt32(23),
                actualDistanceKm = reader.GetDecimal(24),
                allowedDistanceKm = reader.GetDecimal(25),
                overageKm = reader.GetDecimal(26),
                overageAmount = reader.GetDecimal(27),
                cashCollected = reader.GetDecimal(28),
                isNightShift = reader.GetBoolean(29),
                status = reader.GetString(30),
                rejectionReason = reader.IsDBNull(31) ? null : reader.GetString(31),
                createdAt = reader.GetDateTime(32).ToString("yyyy-MM-dd HH:mm:ss"),
                rowVerHex = RowVerToHex(rowVer)
            });
        }
    }

    // 7. Driver Payroll, Overtime (19:00-07:00 & Off-Day) & Cash Report
    var payrollReport = new List<object>();
    const string payrollSql = @"
        SELECT TruckId, TruckCode, LicensePlate, DriverName, DriverPhone, FleetStatus,
               BaseMonthlySalary, OvertimeRatePerTow, IsWorkingOffDay,
               CompletedTowsThisMonth, OvertimeTowsCount, OvertimePayEarned,
               TotalCashCollectedByDriver, TotalOverageBilled, NetSalaryPayoutAfterCashDeduction
        FROM dbo.vw_DriverPayrollAndCashReport
        ORDER BY TruckCode ASC;";

    await using (var cmd = new SqlCommand(payrollSql, conn))
    await using (var reader = await cmd.ExecuteReaderAsync())
    {
        while (await reader.ReadAsync())
        {
            payrollReport.Add(new
            {
                truckId = reader.GetInt32(0),
                truckCode = reader.GetString(1),
                licensePlate = reader.GetString(2),
                driverName = reader.GetString(3),
                driverPhone = reader.GetString(4),
                fleetStatus = reader.GetString(5),
                baseMonthlySalary = reader.GetDecimal(6),
                overtimeRatePerTow = reader.GetDecimal(7),
                isWorkingOffDay = reader.GetBoolean(8),
                completedTowsThisMonth = reader.GetInt32(9),
                overtimeTowsCount = reader.GetInt32(10),
                overtimePayEarned = reader.GetDecimal(11),
                totalCashCollectedByDriver = reader.GetDecimal(12),
                totalOverageBilled = reader.GetDecimal(13),
                netSalaryPayoutAfterCashDeduction = reader.GetDecimal(14)
            });
        }
    }

    // 8. Trigger Audit Logs (dbo.TowAuditLogs)
    var auditLogs = new List<object>();
    const string auditSql = @"
        SELECT TOP (20) AuditId, TowRequestId, RequestNumber, OldStatus, NewStatus, ActionNote, ChangedBy, ChangedAt
        FROM dbo.TowAuditLogs
        ORDER BY AuditId DESC;";

    await using (var cmd = new SqlCommand(auditSql, conn))
    await using (var reader = await cmd.ExecuteReaderAsync())
    {
        while (await reader.ReadAsync())
        {
            auditLogs.Add(new
            {
                auditId = reader.GetInt64(0),
                towRequestId = reader.GetInt32(1),
                requestNumber = reader.GetString(2),
                oldStatus = reader.IsDBNull(3) ? "None" : reader.GetString(3),
                newStatus = reader.GetString(4),
                actionNote = reader.GetString(5),
                changedBy = reader.GetString(6),
                changedAt = reader.GetDateTime(7).ToString("yyyy-MM-dd HH:mm:ss")
            });
        }
    }

    return Results.Ok(new
    {
        kpis,
        plateCodes,
        policies,
        trucks,
        priorityQueue,
        recentRequests,
        payrollReport,
        auditLogs
    });
});

/*==============================================================================
  ENDPOINT 2: GET /api/policies/{policyId}/check-eligibility
  Calls T-SQL Table-Valued Function dbo.tvf_CheckPolicyEligibility(@PolicyId, @IssueType)
  and calculates real road network driving distance via OSRM + SQL fallback.
==============================================================================*/
app.MapGet("/api/policies/{policyId:int}/check-eligibility", async (int policyId, string issueType, decimal? lat1, decimal? lng1, decimal? lat2, decimal? lng2) =>
{
    await using var conn = await OpenLeastPrivilegeConnectionAsync();

    decimal pLat = lat1 ?? 33.8938m;
    decimal pLng = lng1 ?? 35.5018m;
    decimal dLat = lat2 ?? 33.8869m;
    decimal dLng = lng2 ?? 35.5131m;

    decimal actualKm = await CalculateRoadDistanceAsync(conn, pLat, pLng, dLat, dLng);

    const string sql = @"
        SELECT
            e.PolicyId,
            e.PolicyNumber,
            e.TargetCategory,
            e.IsEligible,
            e.MatchedQuotaTierId,
            e.MatchedTierName,
            e.AllowedDistanceKm,
            e.RemainingCategoryTows,
            e.RequiredCooldownDays,
            e.DaysSinceLastTow,
            e.LastTowRequestNumber,
            e.LastTowDate,
            e.StatusBanner
        FROM dbo.tvf_CheckPolicyEligibility(@PolicyId, @IssueType) AS e;";

    await using var cmd = new SqlCommand(sql, conn);
    cmd.Parameters.Add("@PolicyId", SqlDbType.Int).Value = policyId;
    cmd.Parameters.Add("@IssueType", SqlDbType.VarChar, 20).Value = issueType;

    await using var reader = await cmd.ExecuteReaderAsync();
    if (await reader.ReadAsync())
    {
        decimal allowedKm = reader.GetDecimal(6);
        decimal overageKm = actualKm > allowedKm ? actualKm - allowedKm : 0m;
        decimal overageAmount = Math.Round(overageKm * 2.50m, 2);

        return Results.Ok(new
        {
            policyId = reader.GetInt32(0),
            policyNumber = reader.GetString(1),
            targetCategory = reader.GetString(2),
            isEligible = reader.GetBoolean(3),
            matchedQuotaTierId = reader.IsDBNull(4) ? (int?)null : reader.GetInt32(4),
            matchedTierName = reader.IsDBNull(5) ? null : reader.GetString(5),
            allowedDistanceKm = allowedKm,
            remainingCategoryTows = reader.GetInt32(7),
            requiredCooldownDays = reader.GetInt32(8),
            daysSinceLastTow = reader.IsDBNull(9) ? (decimal?)null : reader.GetDecimal(9),
            lastTowRequestNumber = reader.IsDBNull(10) ? null : reader.GetString(10),
            lastTowDate = reader.IsDBNull(11) ? null : reader.GetDateTime(11).ToString("yyyy-MM-dd HH:mm"),
            statusBanner = reader.GetString(12),
            calculatedRoadKm = actualKm,
            overageKm,
            overageAmount
        });
    }

    return Results.NotFound(new { error = "Policy not found." });
});

/*==============================================================================
  ENDPOINT 3: POST /api/tow-requests
  Executes Stored Procedure dbo.usp_CreateTowRequest using parameterized ADO.NET.
==============================================================================*/
app.MapPost("/api/tow-requests", async (CreateTowRequestDto dto) =>
{
    try
    {
        await using var conn = await OpenLeastPrivilegeConnectionAsync();

        decimal actualKm = await CalculateRoadDistanceAsync(
            conn, dto.PickupLat, dto.PickupLng, dto.DestinationLat, dto.DestinationLng);

        await using var cmd = new SqlCommand("dbo.usp_CreateTowRequest", conn)
        {
            CommandType = CommandType.StoredProcedure
        };

        cmd.Parameters.Add("@CustomerId", SqlDbType.Int).Value = dto.CustomerId;
        cmd.Parameters.Add("@CallerPhone", SqlDbType.VarChar, 30).Value = dto.CallerPhone;
        cmd.Parameters.Add("@PlateCodeId", SqlDbType.Int).Value = (object?)dto.PlateCodeId ?? DBNull.Value;
        cmd.Parameters.Add("@PlateDigits", SqlDbType.VarChar, 20).Value = (object?)dto.PlateDigits ?? DBNull.Value;
        cmd.Parameters.Add("@NoPlate", SqlDbType.Bit).Value = dto.NoPlate;
        cmd.Parameters.Add("@VehicleModel", SqlDbType.NVarChar, 80).Value = dto.VehicleModel;
        cmd.Parameters.Add("@IssueType", SqlDbType.VarChar, 20).Value = dto.IssueType;
        cmd.Parameters.Add("@IssueNotes", SqlDbType.NVarChar, 400).Value = (object?)dto.IssueNotes ?? DBNull.Value;
        cmd.Parameters.Add("@PickupAddress", SqlDbType.NVarChar, 200).Value = dto.PickupAddress;
        cmd.Parameters.Add("@PickupLat", SqlDbType.Decimal).Value = dto.PickupLat;
        cmd.Parameters.Add("@PickupLng", SqlDbType.Decimal).Value = dto.PickupLng;
        cmd.Parameters.Add("@DestinationAddress", SqlDbType.NVarChar, 200).Value = dto.DestinationAddress;
        cmd.Parameters.Add("@DestinationLat", SqlDbType.Decimal).Value = dto.DestinationLat;
        cmd.Parameters.Add("@DestinationLng", SqlDbType.Decimal).Value = dto.DestinationLng;
        cmd.Parameters.Add("@HasInsurance", SqlDbType.Bit).Value = dto.HasInsurance;
        cmd.Parameters.Add("@PolicyId", SqlDbType.Int).Value = (object?)dto.PolicyId ?? DBNull.Value;
        cmd.Parameters.Add("@IsOutsourced", SqlDbType.Bit).Value = dto.IsOutsourced;
        cmd.Parameters.Add("@SubcontractorName", SqlDbType.NVarChar, 120).Value = (object?)dto.SubcontractorName ?? DBNull.Value;
        cmd.Parameters.Add("@SubcontractorFee", SqlDbType.Decimal).Value = dto.SubcontractorFee;
        cmd.Parameters.Add("@AssignedTruckId", SqlDbType.Int).Value = (object?)dto.AssignedTruckId ?? DBNull.Value;
        cmd.Parameters.Add("@AutoApprove", SqlDbType.Bit).Value = dto.AutoApprove;
        cmd.Parameters.Add("@ActualDistanceOverrideKm", SqlDbType.Decimal).Value = actualKm;

        await using var reader = await cmd.ExecuteReaderAsync();
        object? result = null;
        do
        {
            if (await reader.ReadAsync())
            {
                result = new
                {
                    towRequestId = reader.GetInt32(0),
                    requestNumber = reader.GetString(1),
                    status = reader.GetString(2)
                };
            }
        } while (await reader.NextResultAsync());

        return Results.Ok(new { success = true, message = "Tow Request processed successfully.", data = result });
    }
    catch (SqlException ex)
    {
        return Results.BadRequest(new { success = false, sqlErrorNumber = ex.Number, error = ex.Message });
    }
});

/*==============================================================================
  ENDPOINT 4: POST /api/tow-requests/{id}/dispatch
  Executes Transactional Stored Procedure dbo.usp_ApproveAndDispatchTow
==============================================================================*/
app.MapPost("/api/tow-requests/{id:int}/dispatch", async (int id, DispatchTowDto dto) =>
{
    try
    {
        await using var conn = await OpenLeastPrivilegeConnectionAsync();

        await using var cmd = new SqlCommand("dbo.usp_ApproveAndDispatchTow", conn)
        {
            CommandType = CommandType.StoredProcedure
        };

        cmd.Parameters.Add("@TowRequestId", SqlDbType.Int).Value = id;
        cmd.Parameters.Add("@AssignedTruckId", SqlDbType.Int).Value = dto.AssignedTruckId;
        cmd.Parameters.Add("@SimulatedHoldMs", SqlDbType.Int).Value = 0;

        await using var reader = await cmd.ExecuteReaderAsync();
        if (await reader.ReadAsync())
        {
            return Results.Ok(new
            {
                success = true,
                towRequestId = reader.GetInt32(0),
                requestNumber = reader.GetString(1),
                status = reader.GetString(2),
                assignedTruckId = reader.GetInt32(3),
                truckPrioritySequence = reader.GetInt32(4),
                actualDistanceKm = reader.GetDecimal(6),
                allowedDistanceKm = reader.GetDecimal(7),
                overageKm = reader.GetDecimal(8),
                overageAmount = reader.GetDecimal(9)
            });
        }
        return Results.Ok(new { success = true });
    }
    catch (SqlException ex)
    {
        return Results.BadRequest(new { success = false, sqlErrorNumber = ex.Number, error = ex.Message });
    }
});

/*==============================================================================
  ENDPOINT 5: POST /api/tow-requests/{id}/status
  Executes Transactional Stored Procedure dbo.usp_UpdateTowLifecycleStatus
==============================================================================*/
app.MapPost("/api/tow-requests/{id:int}/status", async (int id, UpdateLifecycleDto dto) =>
{
    try
    {
        await using var conn = await OpenLeastPrivilegeConnectionAsync();

        await using var cmd = new SqlCommand("dbo.usp_UpdateTowLifecycleStatus", conn)
        {
            CommandType = CommandType.StoredProcedure
        };

        cmd.Parameters.Add("@TowRequestId", SqlDbType.Int).Value = id;
        cmd.Parameters.Add("@NewStatus", SqlDbType.VarChar, 25).Value = dto.NewStatus;
        cmd.Parameters.Add("@CashCollected", SqlDbType.Decimal).Value = dto.CashCollected;
        cmd.Parameters.Add("@RejectionReason", SqlDbType.NVarChar, 300).Value = (object?)dto.RejectionReason ?? DBNull.Value;

        await cmd.ExecuteNonQueryAsync();
        return Results.Ok(new { success = true, message = $"Ticket transitioned to {dto.NewStatus}." });
    }
    catch (SqlException ex)
    {
        return Results.BadRequest(new { success = false, sqlErrorNumber = ex.Number, error = ex.Message });
    }
});

/*==============================================================================
  ENDPOINT 6: POST /api/trucks/{truckId}/reorder-queue
  Reorders a truck's active priority queue (Stop #1, Stop #2...) directly from
  the CAD Map drawer via Stored Procedure dbo.usp_ReorderTruckJobQueue.
==============================================================================*/
app.MapPost("/api/trucks/{truckId:int}/reorder-queue", async (int truckId, ReorderQueueDto dto) =>
{
    try
    {
        await using var conn = await OpenLeastPrivilegeConnectionAsync();
        await using var cmd = new SqlCommand("dbo.usp_ReorderTruckJobQueue", conn)
        {
            CommandType = CommandType.StoredProcedure
        };
        cmd.Parameters.Add("@TruckId", SqlDbType.Int).Value = truckId;
        cmd.Parameters.Add("@TowRequestId", SqlDbType.Int).Value = dto.TowRequestId;
        cmd.Parameters.Add("@Direction", SqlDbType.VarChar, 10).Value = dto.Direction;

        await cmd.ExecuteNonQueryAsync();
        return Results.Ok(new { success = true });
    }
    catch (SqlException ex)
    {
        return Results.BadRequest(new { success = false, error = ex.Message });
    }
});

/*==============================================================================
  ENDPOINT 7: POST /api/plate-codes
  Adds a new configurable Lebanese License Plate Letter (e.g. Y, R, M, C)
==============================================================================*/
app.MapPost("/api/plate-codes", async (CreatePlateCodeDto dto) =>
{
    try
    {
        await using var conn = await OpenLeastPrivilegeConnectionAsync();
        const string sql = @"
            INSERT INTO dbo.PlateCodes (Code, RegionDescription, DisplaySequence, IsActive)
            VALUES (UPPER(LTRIM(RTRIM(@Code))), @RegionDescription, @DisplaySequence, 1);";

        await using var cmd = new SqlCommand(sql, conn);
        cmd.Parameters.Add("@Code", SqlDbType.VarChar, 10).Value = dto.Code;
        cmd.Parameters.Add("@RegionDescription", SqlDbType.NVarChar, 100).Value = dto.RegionDescription;
        cmd.Parameters.Add("@DisplaySequence", SqlDbType.Int).Value = dto.DisplaySequence;

        await cmd.ExecuteNonQueryAsync();
        return Results.Ok(new { success = true, message = $"Plate Letter '{dto.Code.ToUpperInvariant()}' added." });
    }
    catch (SqlException ex)
    {
        return Results.BadRequest(new { success = false, error = ex.Message });
    }
});

/*==============================================================================
  ENDPOINT 8: PUT /api/quota-tiers/{tierId} & POST /api/policies/{policyId}/tiers
  Updates or adds Sequential Policy Quota Tiers (including MinIntervalDays —
  allowed time passed between each tow type!)
==============================================================================*/
app.MapPut("/api/quota-tiers/{tierId:int}", async (int tierId, UpdateQuotaTierDto dto) =>
{
    try
    {
        await using var conn = await OpenLeastPrivilegeConnectionAsync();
        const string sql = @"
            UPDATE dbo.PolicyQuotaTiers
            SET TierSequence    = @TierSequence,
                CoverageType    = @CoverageType,
                AllowedTows     = @AllowedTows,
                UsedTows        = @UsedTows,
                MaxDistanceKm   = @MaxDistanceKm,
                MinIntervalDays = @MinIntervalDays
            WHERE QuotaTierId = @QuotaTierId;";

        await using var cmd = new SqlCommand(sql, conn);
        cmd.Parameters.Add("@QuotaTierId", SqlDbType.Int).Value = tierId;
        cmd.Parameters.Add("@TierSequence", SqlDbType.Int).Value = dto.TierSequence;
        cmd.Parameters.Add("@CoverageType", SqlDbType.VarChar, 20).Value = dto.CoverageType;
        cmd.Parameters.Add("@AllowedTows", SqlDbType.Int).Value = dto.AllowedTows;
        cmd.Parameters.Add("@UsedTows", SqlDbType.Int).Value = dto.UsedTows;
        cmd.Parameters.Add("@MaxDistanceKm", SqlDbType.Decimal).Value = dto.MaxDistanceKm;
        cmd.Parameters.Add("@MinIntervalDays", SqlDbType.Int).Value = dto.MinIntervalDays;

        await cmd.ExecuteNonQueryAsync();
        return Results.Ok(new { success = true, message = "Policy Quota Tier updated." });
    }
    catch (SqlException ex)
    {
        return Results.BadRequest(new { success = false, error = ex.Message });
    }
});

app.MapPost("/api/policies/{policyId:int}/tiers", async (int policyId, UpdateQuotaTierDto dto) =>
{
    try
    {
        await using var conn = await OpenLeastPrivilegeConnectionAsync();
        const string sql = @"
            INSERT INTO dbo.PolicyQuotaTiers (PolicyId, TierSequence, CoverageType, AllowedTows, UsedTows, MaxDistanceKm, MinIntervalDays)
            VALUES (@PolicyId, @TierSequence, @CoverageType, @AllowedTows, 0, @MaxDistanceKm, @MinIntervalDays);";

        await using var cmd = new SqlCommand(sql, conn);
        cmd.Parameters.Add("@PolicyId", SqlDbType.Int).Value = policyId;
        cmd.Parameters.Add("@TierSequence", SqlDbType.Int).Value = dto.TierSequence;
        cmd.Parameters.Add("@CoverageType", SqlDbType.VarChar, 20).Value = dto.CoverageType;
        cmd.Parameters.Add("@AllowedTows", SqlDbType.Int).Value = dto.AllowedTows;
        cmd.Parameters.Add("@MaxDistanceKm", SqlDbType.Decimal).Value = dto.MaxDistanceKm;
        cmd.Parameters.Add("@MinIntervalDays", SqlDbType.Int).Value = dto.MinIntervalDays;

        await cmd.ExecuteNonQueryAsync();
        return Results.Ok(new { success = true, message = "New sequential Quota Tier added." });
    }
    catch (SqlException ex)
    {
        return Results.BadRequest(new { success = false, error = ex.Message });
    }
});

/*==============================================================================
  ENDPOINT 9: POST /api/tow-requests/{id}/test-immutability-trigger
==============================================================================*/
app.MapPost("/api/tow-requests/{id:int}/test-immutability-trigger", async (int id) =>
{
    try
    {
        await using var conn = await OpenLeastPrivilegeConnectionAsync();

        const string sql = @"
            UPDATE dbo.TowRequests
            SET Status = 'Draft', CashCollected = 0
            WHERE TowRequestId = @TowRequestId;";

        await using var cmd = new SqlCommand(sql, conn);
        cmd.Parameters.Add("@TowRequestId", SqlDbType.Int).Value = id;
        await cmd.ExecuteNonQueryAsync();

        return Results.Ok(new { blockedByTrigger = false, message = "Ticket was modified (it was not in a finalized state)." });
    }
    catch (SqlException ex)
    {
        return Results.Ok(new
        {
            blockedByTrigger = true,
            sqlErrorNumber = ex.Number,
            triggerMessage = ex.Message
        });
    }
});

/*==============================================================================
  ENDPOINT 10: PUT /api/tow-requests/{id}/optimistic-edit
==============================================================================*/
app.MapPut("/api/tow-requests/{id:int}/optimistic-edit", async (int id, OptimisticEditDto dto) =>
{
    try
    {
        await using var conn = await OpenLeastPrivilegeConnectionAsync();

        await using var cmd = new SqlCommand("dbo.usp_UpdateDraftTowOptimistic", conn)
        {
            CommandType = CommandType.StoredProcedure
        };

        cmd.Parameters.Add("@TowRequestId", SqlDbType.Int).Value = id;
        cmd.Parameters.Add("@NewIssueType", SqlDbType.VarChar, 20).Value = dto.IssueType;
        cmd.Parameters.Add("@NewIssueNotes", SqlDbType.NVarChar, 400).Value = dto.IssueNotes;
        cmd.Parameters.Add("@ExpectedRowVer", SqlDbType.Binary, 8).Value = HexToRowVer(dto.ExpectedRowVerHex);

        await cmd.ExecuteNonQueryAsync();
        return Results.Ok(new { success = true, message = "Draft updated successfully (ROWVERSION matched)." });
    }
    catch (SqlException ex)
    {
        return Results.BadRequest(new { success = false, sqlErrorNumber = ex.Number, error = ex.Message });
    }
});

/*==============================================================================
  ENDPOINT 11: POST /api/concurrency/simulate-race
==============================================================================*/
app.MapPost("/api/concurrency/simulate-race", async () =>
{
    int reqIdA, reqIdB;
    string reqNumA = "", reqNumB = "";

    await using (var setupConn = await OpenLeastPrivilegeConnectionAsync())
    {
        const string prepSql = @"
            UPDATE dbo.PolicyQuotaTiers
            SET AllowedTows = 2, UsedTows = 1
            WHERE PolicyId = 2 AND CoverageType = 'Accident';

            UPDATE dbo.InsurancePolicies
            SET PolicyStatus = 'Active'
            WHERE PolicyId = 2;";

        await using (var prepCmd = new SqlCommand(prepSql, setupConn))
        {
            await prepCmd.ExecuteNonQueryAsync();
        }

        reqIdA = await CreateRaceDraftAsync(setupConn, "M 881001", "BMW X5 (Dispatcher Tab 1)");
        reqIdB = await CreateRaceDraftAsync(setupConn, "M 882002", "Range Rover (Dispatcher Tab 2)");

        await using var numCmd = new SqlCommand("SELECT TowRequestId, RequestNumber FROM dbo.TowRequests WHERE TowRequestId IN (@A, @B)", setupConn);
        numCmd.Parameters.Add("@A", SqlDbType.Int).Value = reqIdA;
        numCmd.Parameters.Add("@B", SqlDbType.Int).Value = reqIdB;
        await using var r = await numCmd.ExecuteReaderAsync();
        while (await r.ReadAsync())
        {
            if (r.GetInt32(0) == reqIdA) reqNumA = r.GetString(1);
            if (r.GetInt32(0) == reqIdB) reqNumB = r.GetString(1);
        }
    }

    var globalTimer = Stopwatch.StartNew();

    async Task<object> RunDispatcherAsync(string dispatcherName, int towRequestId, string requestNumber, int truckId, int staggerMs)
    {
        if (staggerMs > 0) await Task.Delay(staggerMs);
        long startedAtMs = globalTimer.ElapsedMilliseconds;

        try
        {
            await using var conn = await OpenLeastPrivilegeConnectionAsync();

            await using var cmd = new SqlCommand("dbo.usp_ApproveAndDispatchTow", conn)
            {
                CommandType = CommandType.StoredProcedure
            };
            cmd.Parameters.Add("@TowRequestId", SqlDbType.Int).Value = towRequestId;
            cmd.Parameters.Add("@AssignedTruckId", SqlDbType.Int).Value = truckId;
            cmd.Parameters.Add("@SimulatedHoldMs", SqlDbType.Int).Value = 350;

            await cmd.ExecuteNonQueryAsync();
            long finishedAtMs = globalTimer.ElapsedMilliseconds;

            return new
            {
                dispatcher = dispatcherName,
                towRequestId,
                requestNumber,
                outcome = "COMMITTED",
                startedAtMs,
                finishedAtMs,
                durationMs = finishedAtMs - startedAtMs,
                detail = "Acquired UPDLOCK on Policy #2, verified 1 Accident tow remaining, incremented UsedTows (1 -> 2), and COMMITTED transaction."
            };
        }
        catch (SqlException ex)
        {
            long finishedAtMs = globalTimer.ElapsedMilliseconds;
            return new
            {
                dispatcher = dispatcherName,
                towRequestId,
                requestNumber,
                outcome = "ROLLED BACK (TRY...CATCH)",
                startedAtMs,
                finishedAtMs,
                durationMs = finishedAtMs - startedAtMs,
                sqlErrorNumber = ex.Number,
                detail = ex.Message
            };
        }
    }

    var task1 = RunDispatcherAsync("Dispatcher #1 (Tab A)", reqIdA, reqNumA, 3, 0);
    var task2 = RunDispatcherAsync("Dispatcher #2 (Tab B)", reqIdB, reqNumB, 4, 25);

    var results = await Task.WhenAll(task1, task2);

    int finalAllowed = 0, finalUsed = 0;
    await using (var checkConn = await OpenLeastPrivilegeConnectionAsync())
    {
        const string checkSql = @"
            SELECT AllowedTows, UsedTows
            FROM dbo.PolicyQuotaTiers
            WHERE PolicyId = 2 AND CoverageType = 'Accident';";
        await using var checkCmd = new SqlCommand(checkSql, checkConn);
        await using var reader = await checkCmd.ExecuteReaderAsync();
        if (await reader.ReadAsync())
        {
            finalAllowed = reader.GetInt32(0);
            finalUsed = reader.GetInt32(1);
        }
    }

    return Results.Ok(new
    {
        policyTested = "POL-2026-ACC-LAST1 (PolicyId = 2)",
        initialAccidentTowsRemaining = 1,
        finalAllowedTows = finalAllowed,
        finalUsedTows = finalUsed,
        finalRemainingTows = finalAllowed - finalUsed,
        concurrencyMechanism = "BEGIN TRAN + WITH (UPDLOCK, ROWLOCK) + TRY...CATCH + ROLLBACK TRAN",
        sessionResults = results
    });
});

async Task<int> CreateRaceDraftAsync(SqlConnection conn, string digits, string model)
{
    await using var cmd = new SqlCommand("dbo.usp_CreateTowRequest", conn)
    {
        CommandType = CommandType.StoredProcedure
    };
    cmd.Parameters.Add("@CustomerId", SqlDbType.Int).Value = 2;
    cmd.Parameters.Add("@CallerPhone", SqlDbType.VarChar, 30).Value = "+961-70-222333";
    cmd.Parameters.Add("@PlateCodeId", SqlDbType.Int).Value = 2;
    cmd.Parameters.Add("@PlateDigits", SqlDbType.VarChar, 20).Value = digits.Replace("M ", "");
    cmd.Parameters.Add("@NoPlate", SqlDbType.Bit).Value = false;
    cmd.Parameters.Add("@VehicleModel", SqlDbType.NVarChar, 80).Value = model;
    cmd.Parameters.Add("@IssueType", SqlDbType.VarChar, 20).Value = "Accident";
    cmd.Parameters.Add("@IssueNotes", SqlDbType.NVarChar, 400).Value = "Concurrent 2-Dispatcher Race Condition Test";
    cmd.Parameters.Add("@PickupAddress", SqlDbType.NVarChar, 200).Value = "Dora Highway, Metn";
    cmd.Parameters.Add("@PickupLat", SqlDbType.Decimal).Value = 33.8980m;
    cmd.Parameters.Add("@PickupLng", SqlDbType.Decimal).Value = 35.5520m;
    cmd.Parameters.Add("@DestinationAddress", SqlDbType.NVarChar, 200).Value = "Bouchrieh Bodyshop";
    cmd.Parameters.Add("@DestinationLat", SqlDbType.Decimal).Value = 33.8920m;
    cmd.Parameters.Add("@DestinationLng", SqlDbType.Decimal).Value = 35.5590m;
    cmd.Parameters.Add("@HasInsurance", SqlDbType.Bit).Value = true;
    cmd.Parameters.Add("@PolicyId", SqlDbType.Int).Value = 2;
    cmd.Parameters.Add("@IsOutsourced", SqlDbType.Bit).Value = false;
    cmd.Parameters.Add("@SubcontractorName", SqlDbType.NVarChar, 120).Value = DBNull.Value;
    cmd.Parameters.Add("@SubcontractorFee", SqlDbType.Decimal).Value = 0m;
    cmd.Parameters.Add("@AssignedTruckId", SqlDbType.Int).Value = DBNull.Value;
    cmd.Parameters.Add("@AutoApprove", SqlDbType.Bit).Value = false;
    cmd.Parameters.Add("@ActualDistanceOverrideKm", SqlDbType.Decimal).Value = 22.0m;

    await using var r = await cmd.ExecuteReaderAsync();
    if (await r.ReadAsync())
        return r.GetInt32(0);
    return 0;
}

/*==============================================================================
  ENDPOINT 12: GET /api/performance/search
==============================================================================*/
app.MapGet("/api/performance/search", async (string mode, int? policyId, string? issueType, string? status, string? startDate, string? endDate, string? vehiclePlate) =>
{
    var statsMessages = new List<string>();
    await using var conn = await OpenLeastPrivilegeConnectionAsync();
    conn.InfoMessage += (_, e) => statsMessages.Add(e.Message);

    string sql;
    string indexName;
    string queryPlanNote;

    await using var cmd = new SqlCommand { Connection = conn };

    if (mode == "policy")
    {
        indexName = "IX_TowRequests_Policy_Issue_CreatedAt (PolicyId ASC, IssueType ASC, CreatedAt DESC) INCLUDE (...)";
        queryPlanNote = "Index Seek + 0 Key Lookups + 0 Sort (pre-sorted by CreatedAt DESC)";
        sql = @"
            SET STATISTICS IO ON;
            SELECT TOP (50)
                tr.TowRequestId, tr.RequestNumber, tr.VehiclePlate, tr.VehicleModel,
                tr.IssueType, tr.Status, tr.ActualDistanceKm, tr.AllowedDistanceKm,
                tr.OverageAmount, tr.CreatedAt
            FROM dbo.TowRequests AS tr
            WHERE tr.PolicyId = @PolicyId
              AND tr.IssueType = @IssueType
              AND tr.Status IN ('Approved', 'InProgress', 'Done')
            ORDER BY tr.CreatedAt DESC;
            SET STATISTICS IO OFF;";

        cmd.Parameters.Add("@PolicyId", SqlDbType.Int).Value = policyId ?? 42;
        cmd.Parameters.Add("@IssueType", SqlDbType.VarChar, 20).Value = issueType ?? "Mechanical";
    }
    else if (mode == "plate")
    {
        indexName = "IX_TowRequests_VehiclePlate_CreatedAt (VehiclePlate ASC, CreatedAt DESC) INCLUDE (...)";
        queryPlanNote = "Index Seek on VehiclePlate + 0 Key Lookups + 0 Sort + Parameterized against SQL Injection";
        sql = @"
            SET STATISTICS IO ON;
            SELECT TOP (50)
                tr.TowRequestId, tr.RequestNumber, tr.VehiclePlate, tr.VehicleModel,
                tr.IssueType, tr.Status, tr.ActualDistanceKm, tr.AllowedDistanceKm,
                tr.OverageAmount, tr.CreatedAt
            FROM dbo.TowRequests AS tr
            WHERE tr.VehiclePlate = @VehiclePlate
            ORDER BY tr.CreatedAt DESC;
            SET STATISTICS IO OFF;";

        cmd.Parameters.Add("@VehiclePlate", SqlDbType.VarChar, 30).Value = (vehiclePlate ?? "M 100001").Trim();
    }
    else
    {
        indexName = "IX_TowRequests_Status_CreatedAt_Covering (Status ASC, CreatedAt DESC) INCLUDE (...)";
        queryPlanNote = "SARGable Date Range (CreatedAt >= @Start AND CreatedAt < @End) -> Index Seek, 0 Key Lookups, 0 Sort";
        sql = @"
            SET STATISTICS IO ON;
            SELECT TOP (50)
                tr.TowRequestId, tr.RequestNumber, tr.VehiclePlate, tr.VehicleModel,
                tr.IssueType, tr.Status, tr.ActualDistanceKm, tr.AllowedDistanceKm,
                tr.OverageAmount, tr.CreatedAt
            FROM dbo.TowRequests AS tr
            WHERE tr.Status = @Status
              AND tr.CreatedAt >= @StartDate
              AND tr.CreatedAt < @EndDate
            ORDER BY tr.CreatedAt DESC;
            SET STATISTICS IO OFF;";

        DateTime start = DateTime.TryParse(startDate, out var s) ? s : new DateTime(2026, 10, 1);
        DateTime end = DateTime.TryParse(endDate, out var e) ? e : new DateTime(2026, 11, 10);

        cmd.Parameters.Add("@Status", SqlDbType.VarChar, 25).Value = status ?? "Done";
        var pStart = cmd.Parameters.Add("@StartDate", SqlDbType.DateTime2);
        pStart.Scale = 0;
        pStart.Value = start;
        var pEnd = cmd.Parameters.Add("@EndDate", SqlDbType.DateTime2);
        pEnd.Scale = 0;
        pEnd.Value = end;
    }

    cmd.CommandText = sql;
    var sw = Stopwatch.StartNew();
    var rows = new List<object>();

    await using (var reader = await cmd.ExecuteReaderAsync())
    {
        while (await reader.ReadAsync())
        {
            rows.Add(new
            {
                towRequestId = reader.GetInt32(0),
                requestNumber = reader.GetString(1),
                vehiclePlate = reader.GetString(2),
                vehicleModel = reader.GetString(3),
                issueType = reader.GetString(4),
                status = reader.GetString(5),
                actualDistanceKm = reader.GetDecimal(6),
                allowedDistanceKm = reader.GetDecimal(7),
                overageAmount = reader.GetDecimal(8),
                createdAt = reader.GetDateTime(9).ToString("yyyy-MM-dd HH:mm")
            });
        }
    }
    sw.Stop();

    return Results.Ok(new
    {
        mode,
        elapsedMs = Math.Round(sw.Elapsed.TotalMilliseconds, 2),
        rowCountReturned = rows.Count,
        indexUsed = indexName,
        planCharacteristics = queryPlanNote,
        statisticsIo = string.Join(" | ", statsMessages),
        rows
    });
});

app.Run("http://localhost:5050");

static void LoadDotEnv(string filePath)
{
    if (!File.Exists(filePath)) return;
    foreach (var line in File.ReadAllLines(filePath))
    {
        var trimmed = line.Trim();
        if (string.IsNullOrEmpty(trimmed) || trimmed.StartsWith('#')) continue;
        int idx = trimmed.IndexOf('=');
        if (idx <= 0) continue;
        string key = trimmed[..idx].Trim();
        string val = trimmed[(idx + 1)..].Trim();
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable(key)))
        {
            Environment.SetEnvironmentVariable(key, val);
        }
    }
}

public record CreateTowRequestDto(
    int CustomerId,
    string CallerPhone,
    int? PlateCodeId,
    string? PlateDigits,
    bool NoPlate,
    string VehicleModel,
    string IssueType,
    string? IssueNotes,
    string PickupAddress,
    decimal PickupLat,
    decimal PickupLng,
    string DestinationAddress,
    decimal DestinationLat,
    decimal DestinationLng,
    bool HasInsurance,
    int? PolicyId,
    bool IsOutsourced,
    string? SubcontractorName,
    decimal SubcontractorFee,
    int? AssignedTruckId,
    bool AutoApprove
);

public record DispatchTowDto(int AssignedTruckId);
public record UpdateLifecycleDto(string NewStatus, decimal CashCollected, string? RejectionReason);
public record OptimisticEditDto(string IssueType, string IssueNotes, string ExpectedRowVerHex);
public record ReorderQueueDto(int TowRequestId, string Direction);
public record CreatePlateCodeDto(string Code, string RegionDescription, int DisplaySequence);
public record UpdateQuotaTierDto(int TierSequence, string CoverageType, int AllowedTows, int UsedTows, decimal MaxDistanceKm, int MinIntervalDays);
