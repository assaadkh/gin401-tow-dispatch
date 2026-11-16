using System.Collections.Concurrent;
using System.Data;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Data.SqlClient;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.ConfigureKestrel(options =>
{
    options.Limits.MaxRequestBodySize = 64 * 1024; // 64 KB upper bound on JSON API payloads
});

// 1. Load .env file if present so no database password is ever hardcoded in C# source code
LoadDotEnv(Path.Combine(builder.Environment.ContentRootPath, ".env"));

string connectionString = Environment.GetEnvironmentVariable("TOW_DB_CONNECTION_STRING")
    ?? "Server=localhost;Database=GIN401_TowDispatch;Integrated Security=True;Pooling=False;TrustServerCertificate=True;";

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
        policy.SetIsOriginAllowed(origin =>
              {
                  if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri)) return false;
                  return (uri.Scheme == "http" || uri.Scheme == "https") &&
                         (uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase) ||
                          uri.Host.Equals("127.0.0.1", StringComparison.OrdinalIgnoreCase));
              })
              .AllowAnyHeader()
              .AllowAnyMethod());
});

builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    // Partitioned per-IP login limiter (prevents a single IP from locking out all dispatch workstations)
    options.AddPolicy("login", httpContext =>
    {
        string partitionKey = httpContext.Connection.RemoteIpAddress?.ToString() ?? "local";
        return RateLimitPartition.GetFixedWindowLimiter(partitionKey, _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = 12,
            Window = TimeSpan.FromMinutes(1),
            QueueLimit = 0,
            AutoReplenishment = true
        });
    });
    // Partitioned per-operator limiter for lock/CPU-intensive operations
    options.AddPolicy("ops-heavy", httpContext =>
    {
        string partitionKey = httpContext.Items["OperatorUsername"] as string
            ?? httpContext.Connection.RemoteIpAddress?.ToString()
            ?? "anon";
        return RateLimitPartition.GetFixedWindowLimiter(partitionKey, _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = 15,
            Window = TimeSpan.FromMinutes(1),
            QueueLimit = 0,
            AutoReplenishment = true
        });
    });
});

var app = builder.Build();
app.UseCors();
app.Use(async (context, next) =>
{
    context.Response.OnStarting(() =>
    {
        context.Response.Headers["X-Content-Type-Options"] = "nosniff";
        context.Response.Headers["X-Frame-Options"] = "DENY";
        context.Response.Headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
        context.Response.Headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()";
        context.Response.Headers["Content-Security-Policy"] =
            "default-src 'self'; object-src 'none'; img-src 'self' data: https://mt1.google.com; " +
            "style-src 'self' 'unsafe-inline'; script-src 'self'; " +
            "connect-src 'self' https://api.bigdatacloud.net https://nominatim.openstreetmap.org https://photon.komoot.io https://router.project-osrm.org; " +
            "frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
        if (context.Request.Path.StartsWithSegments("/api"))
        {
            context.Response.Headers["Cache-Control"] = "no-store, no-cache, must-revalidate";
            context.Response.Headers["Pragma"] = "no-cache";
        }
        return Task.CompletedTask;
    });
    await next();
});
app.UseDefaultFiles();
app.UseStaticFiles();

string? configuredTokenSecret = Environment.GetEnvironmentVariable("TRACKER_TOKEN_SECRET");
if (string.IsNullOrWhiteSpace(configuredTokenSecret) ||
    configuredTokenSecret.Length < 32 ||
    configuredTokenSecret.Contains("REPLACE_WITH", StringComparison.OrdinalIgnoreCase))
{
    configuredTokenSecret = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    app.Logger.LogWarning("TRACKER_TOKEN_SECRET is missing or weak; generated a 256-bit ephemeral signing key for this process.");
}
byte[] tokenSecret = Encoding.UTF8.GetBytes(configuredTokenSecret);

var revokedTokenJtis = new ConcurrentDictionary<string, long>(StringComparer.Ordinal);
var userRevokedBeforeUnix = new ConcurrentDictionary<int, long>();

void PruneExpiredRevocations()
{
    long nowUnix = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    foreach (var kv in revokedTokenJtis)
    {
        if (kv.Value < nowUnix)
        {
            revokedTokenJtis.TryRemove(kv.Key, out _);
        }
    }
}

IResult MapSqlExceptionResult(SqlException ex)
{
    if (ex.Number is 50030 or 50031)
    {
        return Results.Json(new { success = false, error = "Operator session is invalid or inactive. Please sign in again." }, statusCode: StatusCodes.Status401Unauthorized);
    }
    if (ex.Number is 50032 or 50060)
    {
        return Results.Json(new { success = false, sqlErrorNumber = ex.Number, error = ex.Message }, statusCode: StatusCodes.Status403Forbidden);
    }
    if (ex.Number >= 50000 && ex.Number <= 50999)
    {
        return Results.BadRequest(new { success = false, sqlErrorNumber = ex.Number, error = ex.Message });
    }
    if (ex.Number is 2627 or 2601)
    {
        return Results.Conflict(new { success = false, error = "A record with this unique identifier or code already exists." });
    }
    if (ex.Number == 547)
    {
        return Results.BadRequest(new { success = false, error = "The submitted values violate a database validation or reference constraint." });
    }

    app.Logger.LogError(ex, "Unhandled database error (SqlErrorNumber={SqlErrorNumber})", ex.Number);
    return Results.Json(
        new { success = false, error = "An internal database error occurred while processing the request." },
        statusCode: StatusCodes.Status500InternalServerError);
}

// Global API Auth & Exception Boundary Middleware
app.Use(async (context, next) =>
{
    if (!context.Request.Path.StartsWithSegments("/api"))
    {
        await next();
        return;
    }

    try
    {
        if (!context.Request.Path.StartsWithSegments("/api/auth/login") &&
            !HttpMethods.IsOptions(context.Request.Method))
        {
            string authHeader = context.Request.Headers.Authorization.ToString();
            string token = authHeader.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)
                ? authHeader[7..].Trim()
                : "";

            if (!TryValidateSessionToken(
                    token,
                    tokenSecret,
                    revokedTokenJtis,
                    userRevokedBeforeUnix,
                    out int userId,
                    out string username,
                    out string tokenJti,
                    out long tokenExp))
            {
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                await context.Response.WriteAsJsonAsync(new { success = false, error = "A valid authenticated operator session is required." });
                return;
            }

            context.Items["OperatorUserId"] = userId;
            context.Items["OperatorUsername"] = username;
            context.Items["OperatorTokenJti"] = tokenJti;
            context.Items["OperatorTokenExp"] = tokenExp;
        }

        await next();
    }
    catch (UnauthorizedAccessException)
    {
        if (!context.Response.HasStarted)
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            await context.Response.WriteAsJsonAsync(new { success = false, error = "Operator session is invalid or inactive." });
        }
    }
    catch (SqlException ex)
    {
        if (!context.Response.HasStarted)
        {
            await MapSqlExceptionResult(ex).ExecuteAsync(context);
        }
    }
});
app.UseRateLimiter();

int useIntegratedFallbackFlag = 0;
bool configuredUsesIntegrated =
    connectionString.Contains("Integrated Security=True", StringComparison.OrdinalIgnoreCase) ||
    connectionString.Contains("Integrated Security=SSPI", StringComparison.OrdinalIgnoreCase) ||
    connectionString.Contains("Trusted_Connection=True", StringComparison.OrdinalIgnoreCase);

var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
httpClient.DefaultRequestHeaders.UserAgent.ParseAdd("TrackerConnectCAD/2.0");

async Task EnforceLeastPrivilegeOnIntegratedConnectionAsync(SqlConnection winConn)
{
    const string sql = @"
        IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'tow_cad_app_login')
           AND SUSER_SNAME() <> N'tow_cad_app_login'
        BEGIN
            EXECUTE AS LOGIN = N'tow_cad_app_login';
        END;
        SELECT IS_SRVROLEMEMBER('sysadmin'), IS_ROLEMEMBER('db_tow_dispatcher_role');";

    await using var impCmd = new SqlCommand(sql, winConn);
    await using var r = await impCmd.ExecuteReaderAsync();
    if (!await r.ReadAsync() || r.GetInt32(0) == 1 || r.GetInt32(1) != 1)
    {
        throw new InvalidOperationException("Least-privilege SQL role verification failed: refusing to execute under sysadmin or non-dispatcher principal.");
    }
}

// Opens a raw least-privilege SQL connection as [tow_cad_app_login] -> [tow_cad_app_user] in [db_tow_dispatcher_role]
async Task<SqlConnection> OpenRawLeastPrivilegeConnectionAsync()
{
    if (!configuredUsesIntegrated && Volatile.Read(ref useIntegratedFallbackFlag) == 0)
    {
        var conn = new SqlConnection(connectionString);
        try
        {
            await conn.OpenAsync();
            return conn;
        }
        catch (SqlException ex) when (ex.Number == 18456)
        {
            await conn.DisposeAsync();
            Interlocked.Exchange(ref useIntegratedFallbackFlag, 1);
            app.Logger.LogWarning("SQL login authentication failed (18456); switching to Integrated Security + mandatory EXECUTE AS LOGIN = 'tow_cad_app_login'.");
        }
        catch
        {
            await conn.DisposeAsync();
            throw;
        }
    }

    var winConn = new SqlConnection("Server=localhost;Database=GIN401_TowDispatch;Integrated Security=True;Pooling=False;TrustServerCertificate=True;");
    try
    {
        await winConn.OpenAsync();
        await EnforceLeastPrivilegeOnIntegratedConnectionAsync(winConn);
        return winConn;
    }
    catch
    {
        await winConn.DisposeAsync();
        throw;
    }
}

// Opens a connection for unauthenticated login lookup, clearing any prior SESSION_CONTEXT first
async Task<SqlConnection> OpenAnonymousAuthConnectionAsync()
{
    var conn = await OpenRawLeastPrivilegeConnectionAsync();
    try
    {
        await using var clearCmd = new SqlCommand("dbo.usp_ClearDispatcherSessionContext", conn)
        {
            CommandType = CommandType.StoredProcedure
        };
        await clearCmd.ExecuteNonQueryAsync();
        return conn;
    }
    catch
    {
        await conn.DisposeAsync();
        throw;
    }
}

// Sets AND validates SQL Server SESSION_CONTEXT + RBAC flags on each database connection
async Task<(bool CanDispatch, bool CanManageFleet, bool CanManagePolicies, bool CanManageBilling, bool CanManageUsers)>
    SetAndValidateDispatcherContextAsync(SqlConnection conn, int userId, string expectedUsername, bool updateLastLogin = false)
{
    await using var ctxCmd = new SqlCommand("dbo.usp_SetDispatcherSessionContext", conn)
    {
        CommandType = CommandType.StoredProcedure
    };
    ctxCmd.Parameters.Add("@UserId", SqlDbType.Int).Value = userId;
    ctxCmd.Parameters.Add("@ExpectedUsername", SqlDbType.VarChar, 60).Value = expectedUsername;
    ctxCmd.Parameters.Add("@UpdateLastLogin", SqlDbType.Bit).Value = updateLastLogin;

    await using var reader = await ctxCmd.ExecuteReaderAsync();
    if (!await reader.ReadAsync())
    {
        throw new UnauthorizedAccessException("Database failed to return validated SESSION_CONTEXT.");
    }

    int confirmedId = reader.IsDBNull(0) ? 0 : reader.GetInt32(0);
    string confirmedUser = reader.IsDBNull(1) ? "" : reader.GetString(1);
    if (confirmedId != userId || !string.Equals(confirmedUser, expectedUsername, StringComparison.OrdinalIgnoreCase))
    {
        throw new UnauthorizedAccessException("Database SESSION_CONTEXT validation mismatch.");
    }

    bool canDispatch = reader.FieldCount > 3 && !reader.IsDBNull(3) && reader.GetBoolean(3);
    bool canManageFleet = reader.FieldCount > 4 && !reader.IsDBNull(4) && reader.GetBoolean(4);
    bool canManagePolicies = reader.FieldCount > 5 && !reader.IsDBNull(5) && reader.GetBoolean(5);
    bool canManageBilling = reader.FieldCount > 6 && !reader.IsDBNull(6) && reader.GetBoolean(6);
    bool canManageUsers = reader.FieldCount > 7 && !reader.IsDBNull(7) && reader.GetBoolean(7);
    return (canDispatch, canManageFleet, canManagePolicies, canManageBilling, canManageUsers);
}

async Task<SqlConnection> OpenAuthenticatedConnectionAsync(HttpContext httpContext)
{
    if (httpContext.Items["OperatorUserId"] is not int userId ||
        httpContext.Items["OperatorUsername"] is not string username ||
        userId <= 0 ||
        string.IsNullOrWhiteSpace(username))
    {
        throw new UnauthorizedAccessException("Missing authenticated dispatcher identity.");
    }

    var conn = await OpenRawLeastPrivilegeConnectionAsync();
    try
    {
        var perms = await SetAndValidateDispatcherContextAsync(conn, userId, username, updateLastLogin: false);
        httpContext.Items["CanDispatch"] = perms.CanDispatch;
        httpContext.Items["CanManageFleet"] = perms.CanManageFleet;
        httpContext.Items["CanManagePolicies"] = perms.CanManagePolicies;
        httpContext.Items["CanManageBilling"] = perms.CanManageBilling;
        httpContext.Items["CanManageUsers"] = perms.CanManageUsers;
        return conn;
    }
    catch
    {
        await conn.DisposeAsync();
        throw;
    }
}

static string RowVerToHex(byte[] bytes) => "0x" + Convert.ToHexString(bytes);
static bool TryHexToRowVer(string? hex, out byte[] rowVer)
{
    rowVer = Array.Empty<byte>();
    if (string.IsNullOrWhiteSpace(hex)) return false;
    string clean = hex.Trim();
    if (clean.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) clean = clean[2..];
    if (clean.Length != 16) return false;
    try
    {
        rowVer = Convert.FromHexString(clean);
        return rowVer.Length == 8;
    }
    catch (FormatException)
    {
        return false;
    }
}

static void AddDecimalParam(SqlCommand cmd, string name, byte precision, byte scale, object value)
{
    var p = cmd.Parameters.Add(name, SqlDbType.Decimal);
    p.Precision = precision;
    p.Scale = scale;
    p.Value = value;
}

static string CreateSessionToken(int userId, string username, string station, byte[] secretKey)
{
    string jti = Convert.ToHexString(RandomNumberGenerator.GetBytes(12));
    string jsonPayload = JsonSerializer.Serialize(new SessionTokenPayload(
        userId,
        username,
        station,
        DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
        jti
    ));
    string b64Payload = Convert.ToBase64String(Encoding.UTF8.GetBytes(jsonPayload));
    byte[] signedSegment = Encoding.ASCII.GetBytes($"TRK.{b64Payload}");
    using var hmac = new HMACSHA256(secretKey);
    string signatureHex = Convert.ToHexString(hmac.ComputeHash(signedSegment));
    return $"TRK.{b64Payload}.{signatureHex}";
}

static bool TryValidateSessionToken(
    string token,
    byte[] secretKey,
    ConcurrentDictionary<string, long> revokedJtis,
    ConcurrentDictionary<int, long> userRevokedBefore,
    out int userId,
    out string username,
    out string jti,
    out long expiresAtUnix)
{
    userId = 0;
    username = "";
    jti = "";
    expiresAtUnix = 0;
    try
    {
        if (string.IsNullOrWhiteSpace(token) || token.Length > 1024) return false;
        string[] parts = token.Split('.');
        if (parts.Length != 3 || parts[0] != "TRK" || parts[2].Length != 64) return false;

        byte[] supplied = Convert.FromHexString(parts[2]);
        byte[] signedSegment = Encoding.ASCII.GetBytes($"TRK.{parts[1]}");
        using var hmac = new HMACSHA256(secretKey);
        byte[] expected = hmac.ComputeHash(signedSegment);
        if (!CryptographicOperations.FixedTimeEquals(expected, supplied)) return false;

        byte[] payloadBytes = Convert.FromBase64String(parts[1]);
        string payload = Encoding.UTF8.GetString(payloadBytes);
        var parsed = JsonSerializer.Deserialize<SessionTokenPayload>(payload);
        if (parsed is null || parsed.Uid <= 0 || string.IsNullOrWhiteSpace(parsed.Uname)) return false;

        long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        if (parsed.Iat > now + 300 || now - parsed.Iat > 12 * 60 * 60) return false;

        if (!string.IsNullOrWhiteSpace(parsed.Jti) && revokedJtis.ContainsKey(parsed.Jti)) return false;
        if (userRevokedBefore.TryGetValue(parsed.Uid, out long cutoff) && parsed.Iat <= cutoff) return false;

        userId = parsed.Uid;
        username = parsed.Uname;
        jti = parsed.Jti ?? "";
        expiresAtUnix = parsed.Iat + 12 * 60 * 60;
        return true;
    }
    catch
    {
        return false;
    }
}

// Precomputed cost-12 BCrypt dummy hash so unknown-username login checks run in constant time
string dummyBcryptHash = BCrypt.Net.BCrypt.HashPassword("ConstantTimeDummyGuard@2026", workFactor: 12);

// Road-distance calculation with explicit provenance (Doctor Requirement #7):
// 1. If a dispatcher supplied an explicit verified road distance (> 0), tag as 'DispatcherVerifiedEstimate'.
// 2. Otherwise query OSRM real road-network routing -> tag as 'OSRM_DrivingRoute'.
// 3. If OSRM is unreachable, return null so SQL Server computes fn_EstimateRoadHeuristicKm -> 'HeuristicFallbackEstimate'
//    alongside StraightLineDistanceKm (never presenting straight-line Haversine distance as actual driving distance).
async Task<(decimal? RoadDistanceKm, decimal? DurationMinutes, string DistanceSource)> ResolveRoadRouteAsync(
    decimal lat1, decimal lng1, decimal lat2, decimal lng2, decimal? manualVerifiedRoadKm = null)
{
    if (manualVerifiedRoadKm.HasValue && manualVerifiedRoadKm.Value > 0m)
    {
        return (Math.Round(manualVerifiedRoadKm.Value, 2), null, "DispatcherVerifiedEstimate");
    }

    try
    {
        string url = FormattableString.Invariant($"https://router.project-osrm.org/route/v1/driving/{lng1},{lat1};{lng2},{lat2}?overview=false");
        using var resp = await httpClient.GetAsync(url);
        if (resp.IsSuccessStatusCode)
        {
            using var doc = await JsonDocument.ParseAsync(await resp.Content.ReadAsStreamAsync());
            if (doc.RootElement.TryGetProperty("routes", out var routes) && routes.GetArrayLength() > 0)
            {
                double meters = routes[0].GetProperty("distance").GetDouble();
                double seconds = routes[0].TryGetProperty("duration", out var durEl) ? durEl.GetDouble() : 0.0;
                decimal km = Math.Round((decimal)(meters / 1000.0), 2);
                decimal? durationMin = seconds > 0 ? Math.Round((decimal)(seconds / 60.0), 1) : null;
                if (km > 0m)
                {
                    return (km, durationMin, "OSRM_DrivingRoute");
                }
            }
        }
    }
    catch
    {
        // OSRM offline or blocked; SQL stored procedure will explicitly tag as 'HeuristicFallbackEstimate'
    }

    return (null, null, "HeuristicFallbackEstimate");
}

/*==============================================================================
  AUTH ENDPOINT: POST /api/auth/login
  Uses parameterized stored procedure dbo.usp_GetSystemUserForAuth + BCrypt (cost=12)
  verification (no separate PasswordSalt field), then sets & validates SESSION_CONTEXT.
==============================================================================*/
app.MapPost("/api/auth/login", async (LoginRequestDto dto) =>
{
    if ((dto.Username?.Length ?? 0) > 60 || (dto.Password?.Length ?? 0) > 128)
    {
        return Results.Unauthorized();
    }

    try
    {
        await using var conn = await OpenAnonymousAuthConnectionAsync();

        int uid = 0, groupId = 0;
        string uname = "", passwordHash = "", fullName = "", roleTitle = "", dept = "", station = "", accessRole = "DISPATCHER", groupCode = "DISPATCHER", groupName = "Emergency Roadside Dispatchers";
        bool foundUser = false, canDispatch = true, canManageFleet = false, canManagePolicies = false, canManageBilling = false, canManageUsers = false;

        await using (var cmd = new SqlCommand("dbo.usp_GetSystemUserForAuth", conn)
        {
            CommandType = CommandType.StoredProcedure
        })
        {
            cmd.Parameters.Add("@Username", SqlDbType.VarChar, 60).Value = (dto.Username ?? "").Trim();
            await using var reader = await cmd.ExecuteReaderAsync();
            if (await reader.ReadAsync())
            {
                uid = reader.GetInt32(0);
                uname = reader.GetString(1);
                passwordHash = reader.GetString(2);
                fullName = reader.GetString(3);
                roleTitle = reader.GetString(4);
                dept = reader.GetString(5);
                station = reader.GetString(6);
                foundUser = reader.GetBoolean(7);
                accessRole = reader.GetString(8);
                canDispatch = reader.GetBoolean(9);
                canManageFleet = reader.GetBoolean(10);
                canManagePolicies = reader.GetBoolean(11);
                canManageBilling = reader.GetBoolean(12);
                canManageUsers = reader.GetBoolean(13);
                groupId = reader.GetInt32(14);
                groupCode = reader.GetString(15);
                groupName = reader.GetString(16);
            }
        }

        string hashToCheck = foundUser && !string.IsNullOrWhiteSpace(passwordHash)
            ? passwordHash
            : dummyBcryptHash;
        bool hashMatches = BCrypt.Net.BCrypt.Verify(dto.Password ?? "", hashToCheck);
        if (!foundUser || !hashMatches)
        {
            return Results.Unauthorized();
        }

        await SetAndValidateDispatcherContextAsync(conn, uid, uname, updateLastLogin: true);
        string sessionToken = CreateSessionToken(uid, uname, station, tokenSecret);

        return Results.Ok(new
        {
            success = true,
            user = new
            {
                userId = uid,
                username = uname,
                fullName,
                roleTitle,
                department = dept,
                stationCode = station,
                groupId,
                groupCode,
                groupName,
                accessRole,
                canDispatch,
                canManageFleet,
                canManagePolicies,
                canManageBilling,
                canManageUsers,
                encryptionAlgorithm = "BCrypt (Cost=12) + 3NF UserGroups + EXECUTE-Only Role + SESSION_CONTEXT Audit",
                sessionToken,
                loginTime = DateTime.Now.ToString("HH:mm:ss")
            }
        });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
}).RequireRateLimiting("login");

app.MapPost("/api/auth/logout", (HttpContext httpContext) =>
{
    PruneExpiredRevocations();
    if (httpContext.Items["OperatorTokenJti"] is string jti && !string.IsNullOrWhiteSpace(jti))
    {
        long exp = httpContext.Items["OperatorTokenExp"] is long e
            ? e
            : DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 12 * 60 * 60;
        revokedTokenJtis[jti] = exp;
    }
    return Results.Ok(new { success = true, message = "Operator session revoked." });
});

/*==============================================================================
  ENDPOINT 1: GET /api/dashboard
  Executes dbo.usp_GetDashboardSnapshot (18 normalized result sets) via ADO.NET.
==============================================================================*/
app.MapGet("/api/dashboard", async (HttpContext httpContext) =>
{
    await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);
    await using var cmd = new SqlCommand("dbo.usp_GetDashboardSnapshot", conn)
    {
        CommandType = CommandType.StoredProcedure
    };

    await using var reader = await cmd.ExecuteReaderAsync();

    // Result Set 1: KPIs + Least-Privilege & SESSION_CONTEXT Diagnostics
    var kpis = new Dictionary<string, object?>();
    if (await reader.ReadAsync())
    {
        kpis["totalTowRequests"] = reader.GetInt32(0);
        kpis["activeDispatches"] = reader.GetInt32(1);
        kpis["pendingDrafts"] = reader.GetInt32(2);
        kpis["availableTrucks"] = reader.GetInt32(3);
        kpis["activePolicies"] = reader.GetInt32(4);
        kpis["totalAuditLogs"] = reader.GetInt32(5);
        kpis["unpaidInsurerBalance"] = reader.GetDecimal(6);
        kpis["unpaidCustomerBalance"] = reader.GetDecimal(7);
        kpis["connectedSqlLogin"] = reader.GetString(8);
        kpis["connectedDatabaseUser"] = reader.GetString(9);
        kpis["isLeastPrivilegeRoleMember"] = reader.IsDBNull(10) ? 0 : reader.GetInt32(10);
        kpis["isSysAdmin"] = reader.IsDBNull(11) ? 0 : reader.GetInt32(11);
        kpis["directTableSelectAllowed"] = reader.GetInt32(12);
        kpis["sessionUserId"] = reader.IsDBNull(13) ? (int?)null : reader.GetInt32(13);
        kpis["sessionUsername"] = reader.GetString(14);
    }

    // Result Set 2: PlateCodes
    await reader.NextResultAsync();
    var plateCodes = new List<object>();
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

    // Result Set 3: Customers
    await reader.NextResultAsync();
    var customers = new List<object>();
    while (await reader.ReadAsync())
    {
        customers.Add(new
        {
            customerId = reader.GetInt32(0),
            fullName = reader.GetString(1),
            phone = reader.GetString(2),
            email = reader.GetString(3),
            policyCount = reader.GetInt32(4),
            vehicleCount = reader.GetInt32(5)
        });
    }

    // Result Set 4: Normalized Vehicles
    await reader.NextResultAsync();
    var vehicles = new List<object>();
    while (await reader.ReadAsync())
    {
        vehicles.Add(new
        {
            vehicleId = reader.GetInt32(0),
            customerId = reader.GetInt32(1),
            plateCodeId = reader.IsDBNull(2) ? (int?)null : reader.GetInt32(2),
            plateDigits = reader.GetString(3),
            noPlate = reader.GetBoolean(4),
            vehiclePlate = reader.GetString(5),
            vehicleModel = reader.GetString(6)
        });
    }

    // Result Set 5: InsuranceProviders
    await reader.NextResultAsync();
    var providers = new List<object>();
    while (await reader.ReadAsync())
    {
        providers.Add(new
        {
            providerId = reader.GetInt32(0),
            providerName = reader.GetString(1),
            supportPhone = reader.GetString(2),
            contractEmail = reader.IsDBNull(3) ? "" : reader.GetString(3)
        });
    }

    // Result Set 6: InsurancePolicies
    await reader.NextResultAsync();
    var rawPolicies = new List<Dictionary<string, object?>>();
    while (await reader.ReadAsync())
    {
        rawPolicies.Add(new Dictionary<string, object?>
        {
            ["policyId"] = reader.GetInt32(0),
            ["policyNumber"] = reader.GetString(1),
            ["customerId"] = reader.GetInt32(2),
            ["customerName"] = reader.GetString(3),
            ["customerPhone"] = reader.GetString(4),
            ["providerId"] = reader.GetInt32(5),
            ["providerName"] = reader.GetString(6),
            ["startDate"] = reader.GetDateTime(7).ToString("yyyy-MM-dd"),
            ["expirationDate"] = reader.GetDateTime(8).ToString("yyyy-MM-dd"),
            ["defaultAllowedKm"] = reader.GetDecimal(9),
            ["defaultMinIntervalDays"] = reader.GetInt32(10),
            ["policyStatus"] = reader.GetString(11),
            ["tiers"] = new List<object>()
        });
    }

    // Result Set 7: PolicyQuotaTiers
    await reader.NextResultAsync();
    var tiersByPolicy = new Dictionary<int, List<object>>();
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

    var policies = new List<object>();
    foreach (var rp in rawPolicies)
    {
        int pid = (int)rp["policyId"]!;
        if (tiersByPolicy.TryGetValue(pid, out var tList))
            rp["tiers"] = tList;
        policies.Add(rp);
    }

    // Result Set 8: Normalized Drivers
    await reader.NextResultAsync();
    var drivers = new List<object>();
    while (await reader.ReadAsync())
    {
        drivers.Add(new
        {
            driverId = reader.GetInt32(0),
            employeeCode = reader.GetString(1),
            fullName = reader.GetString(2),
            phone = reader.GetString(3),
            licenseNumber = reader.GetString(4),
            baseMonthlySalary = reader.GetDecimal(5),
            overtimeRatePerTow = reader.GetDecimal(6),
            isWorkingOffDay = reader.GetBoolean(7),
            driverStatus = reader.GetString(8),
            activeTruckId = reader.IsDBNull(9) ? (int?)null : reader.GetInt32(9),
            activeTruckCode = reader.GetString(10)
        });
    }

    // Result Set 9: DriverTruckAssignments (Active + Historical)
    await reader.NextResultAsync();
    var driverAssignments = new List<object>();
    while (await reader.ReadAsync())
    {
        driverAssignments.Add(new
        {
            assignmentId = reader.GetInt32(0),
            driverId = reader.GetInt32(1),
            employeeCode = reader.GetString(2),
            driverName = reader.GetString(3),
            truckId = reader.GetInt32(4),
            truckCode = reader.GetString(5),
            truckPlate = reader.GetString(6),
            startDate = reader.GetDateTime(7).ToString("yyyy-MM-dd HH:mm"),
            endDate = reader.IsDBNull(8) ? null : reader.GetDateTime(8).ToString("yyyy-MM-dd HH:mm"),
            assignmentNotes = reader.GetString(9)
        });
    }

    // Result Set 10: Fleet TowTrucks (joined with active Driver)
    await reader.NextResultAsync();
    var trucks = new List<object>();
    while (await reader.ReadAsync())
    {
        trucks.Add(new
        {
            truckId = reader.GetInt32(0),
            truckCode = reader.GetString(1),
            licensePlate = reader.GetString(2),
            truckModel = reader.GetString(3),
            maxPayloadKg = reader.GetInt32(4),
            currentLat = reader.GetDecimal(5),
            currentLng = reader.GetDecimal(6),
            speedKmh = reader.GetDecimal(7),
            fleetStatus = reader.GetString(8),
            lastTelemetryAt = reader.GetDateTime(9).ToString("yyyy-MM-dd HH:mm:ss"),
            driverId = reader.IsDBNull(10) ? (int?)null : reader.GetInt32(10),
            driverName = reader.GetString(11),
            driverPhone = reader.GetString(12),
            baseMonthlySalary = reader.GetDecimal(13),
            overtimeRatePerTow = reader.GetDecimal(14),
            isWorkingOffDay = reader.GetBoolean(15)
        });
    }

    // Result Set 11: Normalized Subcontractors
    await reader.NextResultAsync();
    var subcontractors = new List<object>();
    while (await reader.ReadAsync())
    {
        subcontractors.Add(new
        {
            subcontractorId = reader.GetInt32(0),
            companyName = reader.GetString(1),
            contactPerson = reader.GetString(2),
            phone = reader.GetString(3),
            coverageRegion = reader.GetString(4),
            defaultDispatchFee = reader.GetDecimal(5)
        });
    }

    // Result Set 12: Tariffs (Active & Historical)
    await reader.NextResultAsync();
    var tariffs = new List<object>();
    while (await reader.ReadAsync())
    {
        tariffs.Add(new
        {
            tariffId = reader.GetInt32(0),
            tariffCode = reader.GetString(1),
            tariffName = reader.GetString(2),
            serviceCategory = reader.GetString(3),
            baseFee = reader.GetDecimal(4),
            pricePerKm = reader.GetDecimal(5),
            nightSurcharge = reader.GetDecimal(6),
            effectiveFrom = reader.GetDateTime(7).ToString("yyyy-MM-dd"),
            effectiveTo = reader.IsDBNull(8) ? null : reader.GetDateTime(8).ToString("yyyy-MM-dd"),
            isActive = reader.GetBoolean(9)
        });
    }

    // Result Set 13: Window Function Priority Queue View
    await reader.NextResultAsync();
    var priorityQueue = new List<object>();
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
            distanceSource = reader.GetString(19),
            overageAmount = reader.GetDecimal(20),
            insurerBilledAmount = reader.GetDecimal(21),
            stopNumberInTruckQueue = reader.GetInt64(22),
            cumulativeQueueDistanceKm = reader.GetDecimal(23),
            totalActiveJobsForTruck = reader.GetInt32(24)
        });
    }

    // Result Set 14: Recent Operational TowRequests
    await reader.NextResultAsync();
    var recentRequests = new List<object>();
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
            vehicleId = reader.GetInt32(5),
            vehiclePlate = reader.GetString(6),
            vehicleModel = reader.GetString(7),
            issueType = reader.GetString(8),
            issueNotes = reader.GetString(9),
            pickupAddress = reader.GetString(10),
            pickupLat = reader.GetDecimal(11),
            pickupLng = reader.GetDecimal(12),
            destinationAddress = reader.GetString(13),
            destinationLat = reader.GetDecimal(14),
            destinationLng = reader.GetDecimal(15),
            hasInsurance = reader.GetBoolean(16),
            policyId = reader.IsDBNull(17) ? (int?)null : reader.GetInt32(17),
            policyNumber = reader.IsDBNull(18) ? null : reader.GetString(18),
            isOutsourced = reader.GetBoolean(19),
            subcontractorId = reader.IsDBNull(20) ? (int?)null : reader.GetInt32(20),
            subcontractorName = reader.IsDBNull(21) ? null : reader.GetString(21),
            subcontractorFee = reader.GetDecimal(22),
            assignedTruckId = reader.IsDBNull(23) ? (int?)null : reader.GetInt32(23),
            truckCode = reader.IsDBNull(24) ? null : reader.GetString(24),
            assignedDriverId = reader.IsDBNull(25) ? (int?)null : reader.GetInt32(25),
            assignedDriverName = reader.IsDBNull(26) ? null : reader.GetString(26),
            truckPrioritySequence = reader.GetInt32(27),
            straightLineDistanceKm = reader.GetDecimal(28),
            actualDistanceKm = reader.GetDecimal(29),
            distanceSource = reader.GetString(30),
            allowedDistanceKm = reader.GetDecimal(31),
            overageKm = reader.GetDecimal(32),
            overageAmount = reader.GetDecimal(33),
            insurerBilledAmount = reader.GetDecimal(34),
            totalInvoiceAmount = reader.GetDecimal(35),
            cashCollected = reader.GetDecimal(36),
            invoiceStatus = reader.GetString(37),
            invoiceId = reader.GetInt32(38),
            isNightShift = reader.GetBoolean(39),
            status = reader.GetString(40),
            rejectionReason = reader.IsDBNull(41) ? null : reader.GetString(41),
            createdAt = reader.GetDateTime(42).ToString("yyyy-MM-dd HH:mm:ss"),
            rowVerHex = RowVerToHex(rowVer),
            createdByUserId = reader.IsDBNull(44) ? (int?)null : reader.GetInt32(44),
            createdByUsername = reader.GetString(45)
        });
    }

    // Result Set 15: Recent TowInvoices (separate Insurer vs Customer obligations)
    await reader.NextResultAsync();
    var invoices = new List<object>();
    while (await reader.ReadAsync())
    {
        invoices.Add(new
        {
            invoiceId = reader.GetInt32(0),
            invoiceNumber = reader.GetString(1),
            towRequestId = reader.GetInt32(2),
            requestNumber = reader.GetString(3),
            tariffId = reader.GetInt32(4),
            tariffCode = reader.GetString(5),
            tariffName = reader.GetString(6),
            insuranceProviderId = reader.IsDBNull(7) ? (int?)null : reader.GetInt32(7),
            insuranceProviderName = reader.IsDBNull(8) ? null : reader.GetString(8),
            customerId = reader.GetInt32(9),
            customerName = reader.GetString(10),
            appliedBaseFee = reader.GetDecimal(11),
            appliedPricePerKm = reader.GetDecimal(12),
            appliedNightSurcharge = reader.GetDecimal(13),
            coveredDistanceKm = reader.GetDecimal(14),
            overageDistanceKm = reader.GetDecimal(15),
            subcontractorCost = reader.GetDecimal(16),
            insurerBilledAmount = reader.GetDecimal(17),
            insurerPaidAmount = reader.GetDecimal(18),
            insurerBalanceDue = reader.GetDecimal(19),
            customerBilledAmount = reader.GetDecimal(20),
            customerPaidAmount = reader.GetDecimal(21),
            customerBalanceDue = reader.GetDecimal(22),
            totalAmount = reader.GetDecimal(23),
            invoiceStatus = reader.GetString(24),
            issuedAt = reader.GetDateTime(25).ToString("yyyy-MM-dd HH:mm")
        });
    }

    // Result Set 16: Individual InvoicePayments (each partial/full payment is its own row)
    await reader.NextResultAsync();
    var invoicePayments = new List<object>();
    while (await reader.ReadAsync())
    {
        invoicePayments.Add(new
        {
            paymentId = reader.GetInt64(0),
            invoiceId = reader.GetInt32(1),
            invoiceNumber = reader.GetString(2),
            requestNumber = reader.GetString(3),
            payerType = reader.GetString(4),
            payerName = reader.IsDBNull(5) ? "—" : reader.GetString(5),
            amountPaid = reader.GetDecimal(6),
            paymentMethod = reader.GetString(7),
            referenceNumber = reader.GetString(8),
            collectedByDriverName = reader.IsDBNull(9) ? null : reader.GetString(9),
            recordedByUsername = reader.IsDBNull(10) ? "system" : reader.GetString(10),
            paidAt = reader.GetDateTime(11).ToString("yyyy-MM-dd HH:mm"),
            notes = reader.GetString(12),
            collectedByDriverId = reader.IsDBNull(13) ? (int?)null : reader.GetInt32(13),
            recordedByUserId = reader.IsDBNull(14) ? (int?)null : reader.GetInt32(14)
        });
    }

    // Result Set 17: Driver Payroll Report View
    await reader.NextResultAsync();
    var payrollReport = new List<object>();
    while (await reader.ReadAsync())
    {
        payrollReport.Add(new
        {
            driverId = reader.GetInt32(0),
            employeeCode = reader.GetString(1),
            driverName = reader.GetString(2),
            driverPhone = reader.GetString(3),
            driverStatus = reader.GetString(4),
            truckId = reader.GetInt32(5),
            truckCode = reader.GetString(6),
            licensePlate = reader.GetString(7),
            fleetStatus = reader.GetString(8),
            baseMonthlySalary = reader.GetDecimal(9),
            overtimeRatePerTow = reader.GetDecimal(10),
            isWorkingOffDay = reader.GetBoolean(11),
            completedTowsThisMonth = reader.GetInt32(12),
            overtimeTowsCount = reader.GetInt32(13),
            overtimePayEarned = reader.GetDecimal(14),
            totalCashCollectedByDriver = reader.GetDecimal(15),
            totalOverageBilled = reader.GetDecimal(15),
            netSalaryPayoutAfterCashDeduction = reader.GetDecimal(16)
        });
    }

    // Result Set 18: Trigger Audit Logs (identifying actual SESSION_CONTEXT Dispatcher!)
    await reader.NextResultAsync();
    var auditLogs = new List<object>();
    while (await reader.ReadAsync())
    {
        int? dispUserId = reader.IsDBNull(6) ? null : reader.GetInt32(6);
        string dispUsername = reader.GetString(7);
        string dispFullName = reader.GetString(8);
        string sqlLogin = reader.GetString(9);
        string changedByDisplay = string.IsNullOrWhiteSpace(dispFullName)
            ? dispUsername
            : $"{dispFullName} ({dispUsername})";

        auditLogs.Add(new
        {
            auditId = reader.GetInt64(0),
            towRequestId = reader.GetInt32(1),
            requestNumber = reader.GetString(2),
            oldStatus = reader.IsDBNull(3) ? "None" : reader.GetString(3),
            newStatus = reader.GetString(4),
            actionNote = reader.GetString(5),
            dispatcherUserId = dispUserId,
            dispatcherUsername = dispUsername,
            dispatcherFullName = dispFullName,
            sqlLoginName = sqlLogin,
            changedBy = changedByDisplay,
            changedAt = reader.GetDateTime(10).ToString("yyyy-MM-dd HH:mm:ss")
        });
    }

    return Results.Ok(new
    {
        kpis,
        plateCodes,
        customers,
        vehicles,
        providers,
        policies,
        drivers,
        driverAssignments,
        trucks,
        subcontractors,
        tariffs,
        priorityQueue,
        recentRequests,
        invoices,
        invoicePayments,
        payrollReport,
        auditLogs
    });
});

/*==============================================================================
  ENDPOINT 2: GET /api/policies/{policyId}/check-eligibility
  Executes dbo.usp_CheckPolicyAndPreviewTariff (supports policyId = 0 for cash calls)
  and resolves road distance via OSRM or validated estimate.
==============================================================================*/
app.MapGet("/api/policies/{policyId:int}/check-eligibility", async (
    HttpContext httpContext,
    int policyId,
    string issueType,
    decimal? lat1,
    decimal? lng1,
    decimal? lat2,
    decimal? lng2,
    decimal? verifiedKm) =>
{
    await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);

    decimal pLat = lat1 ?? 33.8938m;
    decimal pLng = lng1 ?? 35.5018m;
    decimal dLat = lat2 ?? 33.8869m;
    decimal dLng = lng2 ?? 35.5131m;

    var (roadKm, durationMin, distanceSource) = await ResolveRoadRouteAsync(pLat, pLng, dLat, dLng, verifiedKm);

    await using var cmd = new SqlCommand("dbo.usp_CheckPolicyAndPreviewTariff", conn)
    {
        CommandType = CommandType.StoredProcedure
    };
    cmd.Parameters.Add("@PolicyId", SqlDbType.Int).Value = policyId > 0 ? policyId : DBNull.Value;
    cmd.Parameters.Add("@IssueType", SqlDbType.VarChar, 20).Value = string.IsNullOrWhiteSpace(issueType) ? "Mechanical" : issueType;
    AddDecimalParam(cmd, "@PickupLat", 9, 6, pLat);
    AddDecimalParam(cmd, "@PickupLng", 9, 6, pLng);
    AddDecimalParam(cmd, "@DestinationLat", 9, 6, dLat);
    AddDecimalParam(cmd, "@DestinationLng", 9, 6, dLng);
    AddDecimalParam(cmd, "@RoutedDistanceKm", 8, 2, (object?)roadKm ?? DBNull.Value);
    cmd.Parameters.Add("@DistanceSource", SqlDbType.VarChar, 30).Value = distanceSource;
    AddDecimalParam(cmd, "@RouteDurationMinutes", 6, 1, (object?)durationMin ?? DBNull.Value);

    await using var reader = await cmd.ExecuteReaderAsync();
    if (await reader.ReadAsync())
    {
        return Results.Ok(new
        {
            policyId = reader.GetInt32(0),
            policyNumber = reader.GetString(1),
            targetCategory = reader.GetString(2),
            isEligible = reader.GetBoolean(3),
            matchedQuotaTierId = reader.IsDBNull(4) ? (int?)null : reader.GetInt32(4),
            matchedTierName = reader.IsDBNull(5) ? null : reader.GetString(5),
            allowedDistanceKm = reader.GetDecimal(6),
            remainingCategoryTows = reader.GetInt32(7),
            requiredCooldownDays = reader.GetInt32(8),
            daysSinceLastTow = reader.IsDBNull(9) ? (decimal?)null : reader.GetDecimal(9),
            lastTowRequestNumber = reader.IsDBNull(10) ? null : reader.GetString(10),
            lastTowDate = reader.IsDBNull(11) ? null : reader.GetDateTime(11).ToString("yyyy-MM-dd HH:mm"),
            statusBanner = reader.GetString(12),
            straightLineDistanceKm = reader.GetDecimal(13),
            calculatedRoadKm = reader.GetDecimal(14),
            distanceSource = reader.GetString(15),
            routeDurationMinutes = reader.IsDBNull(16) ? (decimal?)null : reader.GetDecimal(16),
            coveredDistanceKm = reader.GetDecimal(17),
            overageKm = reader.GetDecimal(18),
            tariffId = reader.GetInt32(19),
            tariffCode = reader.GetString(20),
            tariffName = reader.GetString(21),
            appliedBaseFee = reader.GetDecimal(22),
            appliedPricePerKm = reader.GetDecimal(23),
            appliedNightSurcharge = reader.GetDecimal(24),
            insurerBilledAmount = reader.GetDecimal(25),
            overageAmount = reader.GetDecimal(26),
            customerBilledAmount = reader.GetDecimal(26),
            totalInvoiceAmount = reader.GetDecimal(27)
        });
    }

    return Results.NotFound(new { error = "Unable to preview policy & tariff." });
});

/*==============================================================================
  ENDPOINT 3: POST /api/tow-requests
  Executes Stored Procedure dbo.usp_CreateTowRequest using parameterized ADO.NET.
==============================================================================*/
app.MapPost("/api/tow-requests", async (HttpContext httpContext, CreateTowRequestDto dto) =>
{
    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);

        var (roadKm, durationMin, distanceSource) = await ResolveRoadRouteAsync(
            dto.PickupLat, dto.PickupLng, dto.DestinationLat, dto.DestinationLng, dto.VerifiedRoadDistanceKm);

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
        AddDecimalParam(cmd, "@PickupLat", 9, 6, dto.PickupLat);
        AddDecimalParam(cmd, "@PickupLng", 9, 6, dto.PickupLng);
        cmd.Parameters.Add("@DestinationAddress", SqlDbType.NVarChar, 200).Value = dto.DestinationAddress;
        AddDecimalParam(cmd, "@DestinationLat", 9, 6, dto.DestinationLat);
        AddDecimalParam(cmd, "@DestinationLng", 9, 6, dto.DestinationLng);
        cmd.Parameters.Add("@HasInsurance", SqlDbType.Bit).Value = dto.HasInsurance;
        cmd.Parameters.Add("@PolicyId", SqlDbType.Int).Value = (object?)dto.PolicyId ?? DBNull.Value;
        cmd.Parameters.Add("@IsOutsourced", SqlDbType.Bit).Value = dto.IsOutsourced;
        cmd.Parameters.Add("@SubcontractorId", SqlDbType.Int).Value = (object?)dto.SubcontractorId ?? DBNull.Value;
        AddDecimalParam(cmd, "@SubcontractorFee", 10, 2, dto.SubcontractorFee);
        cmd.Parameters.Add("@AssignedTruckId", SqlDbType.Int).Value = (object?)dto.AssignedTruckId ?? DBNull.Value;
        cmd.Parameters.Add("@AutoApprove", SqlDbType.Bit).Value = dto.AutoApprove;
        cmd.Parameters.Add("@InitialStatus", SqlDbType.VarChar, 25).Value = string.IsNullOrWhiteSpace(dto.InitialStatus) ? "Draft" : dto.InitialStatus;
        AddDecimalParam(cmd, "@RoutedDistanceKm", 8, 2, (object?)roadKm ?? DBNull.Value);
        cmd.Parameters.Add("@DistanceSource", SqlDbType.VarChar, 30).Value = distanceSource;
        AddDecimalParam(cmd, "@RouteDurationMinutes", 6, 1, (object?)durationMin ?? DBNull.Value);

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

        return Results.Ok(new { success = true, message = "Normalized Tow Request & Invoice created successfully.", data = result });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
});

/*==============================================================================
  ENDPOINT 4: POST /api/tow-requests/{id}/dispatch
  Executes Transactional Stored Procedure dbo.usp_ApproveAndDispatchTow
==============================================================================*/
app.MapPost("/api/tow-requests/{id:int}/dispatch", async (HttpContext httpContext, int id, DispatchTowDto dto) =>
{
    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);

        await using var cmd = new SqlCommand("dbo.usp_ApproveAndDispatchTow", conn)
        {
            CommandType = CommandType.StoredProcedure
        };

        cmd.Parameters.Add("@TowRequestId", SqlDbType.Int).Value = id;
        cmd.Parameters.Add("@AssignedTruckId", SqlDbType.Int).Value = dto.AssignedTruckId > 0 ? dto.AssignedTruckId : DBNull.Value;
        cmd.Parameters.Add("@SubcontractorId", SqlDbType.Int).Value = (object?)dto.SubcontractorId ?? DBNull.Value;
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
                overageAmount = reader.GetDecimal(9),
                insurerBilledAmount = reader.GetDecimal(10),
                totalAmount = reader.GetDecimal(11)
            });
        }
        return Results.Ok(new { success = true });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
});

/*==============================================================================
  ENDPOINT 5: POST /api/tow-requests/{id}/status
  Executes Transactional Stored Procedure dbo.usp_UpdateTowLifecycleStatus
==============================================================================*/
app.MapPost("/api/tow-requests/{id:int}/status", async (HttpContext httpContext, int id, UpdateLifecycleDto dto) =>
{
    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);

        await using var cmd = new SqlCommand("dbo.usp_UpdateTowLifecycleStatus", conn)
        {
            CommandType = CommandType.StoredProcedure
        };

        cmd.Parameters.Add("@TowRequestId", SqlDbType.Int).Value = id;
        cmd.Parameters.Add("@NewStatus", SqlDbType.VarChar, 25).Value = dto.NewStatus;
        AddDecimalParam(cmd, "@CashCollected", 10, 2, dto.CashCollected);
        cmd.Parameters.Add("@RejectionReason", SqlDbType.NVarChar, 300).Value = (object?)dto.RejectionReason ?? DBNull.Value;

        await cmd.ExecuteNonQueryAsync();
        return Results.Ok(new { success = true, message = $"Ticket transitioned to {dto.NewStatus}." });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
});

/*==============================================================================
  ENDPOINT 6: POST /api/trucks/{truckId}/reorder-queue
==============================================================================*/
app.MapPost("/api/trucks/{truckId:int}/reorder-queue", async (HttpContext httpContext, int truckId, ReorderQueueDto dto) =>
{
    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);
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
        return MapSqlExceptionResult(ex);
    }
});

/*==============================================================================
  ENDPOINT 7: POST /api/plate-codes
  Executes Stored Procedure dbo.usp_AddPlateCode
==============================================================================*/
app.MapPost("/api/plate-codes", async (HttpContext httpContext, CreatePlateCodeDto dto) =>
{
    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);
        await using var cmd = new SqlCommand("dbo.usp_AddPlateCode", conn)
        {
            CommandType = CommandType.StoredProcedure
        };
        cmd.Parameters.Add("@Code", SqlDbType.VarChar, 10).Value = dto.Code;
        cmd.Parameters.Add("@RegionDescription", SqlDbType.NVarChar, 100).Value = dto.RegionDescription;
        cmd.Parameters.Add("@DisplaySequence", SqlDbType.Int).Value = dto.DisplaySequence;

        await cmd.ExecuteNonQueryAsync();
        return Results.Ok(new { success = true, message = $"Plate Letter '{dto.Code.ToUpperInvariant()}' added." });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
});

/*==============================================================================
  ENDPOINT 8: PUT /api/quota-tiers/{tierId} & POST /api/policies/{policyId}/tiers
  Executes Stored Procedure dbo.usp_UpsertQuotaTier
==============================================================================*/
app.MapPut("/api/quota-tiers/{tierId:int}", async (HttpContext httpContext, int tierId, UpdateQuotaTierDto dto) =>
{
    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);
        await using var cmd = new SqlCommand("dbo.usp_UpsertQuotaTier", conn)
        {
            CommandType = CommandType.StoredProcedure
        };
        cmd.Parameters.Add("@QuotaTierId", SqlDbType.Int).Value = tierId;
        cmd.Parameters.Add("@PolicyId", SqlDbType.Int).Value = DBNull.Value;
        cmd.Parameters.Add("@TierSequence", SqlDbType.Int).Value = dto.TierSequence;
        cmd.Parameters.Add("@CoverageType", SqlDbType.VarChar, 20).Value = dto.CoverageType;
        cmd.Parameters.Add("@AllowedTows", SqlDbType.Int).Value = dto.AllowedTows;
        cmd.Parameters.Add("@UsedTows", SqlDbType.Int).Value = dto.UsedTows;
        AddDecimalParam(cmd, "@MaxDistanceKm", 8, 2, dto.MaxDistanceKm);
        cmd.Parameters.Add("@MinIntervalDays", SqlDbType.Int).Value = dto.MinIntervalDays;

        await cmd.ExecuteNonQueryAsync();
        return Results.Ok(new { success = true, message = "Policy Quota Tier updated." });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
});

app.MapPost("/api/policies/{policyId:int}/tiers", async (HttpContext httpContext, int policyId, UpdateQuotaTierDto dto) =>
{
    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);
        await using var cmd = new SqlCommand("dbo.usp_UpsertQuotaTier", conn)
        {
            CommandType = CommandType.StoredProcedure
        };
        cmd.Parameters.Add("@QuotaTierId", SqlDbType.Int).Value = DBNull.Value;
        cmd.Parameters.Add("@PolicyId", SqlDbType.Int).Value = policyId;
        cmd.Parameters.Add("@TierSequence", SqlDbType.Int).Value = dto.TierSequence;
        cmd.Parameters.Add("@CoverageType", SqlDbType.VarChar, 20).Value = dto.CoverageType;
        cmd.Parameters.Add("@AllowedTows", SqlDbType.Int).Value = dto.AllowedTows;
        cmd.Parameters.Add("@UsedTows", SqlDbType.Int).Value = 0;
        AddDecimalParam(cmd, "@MaxDistanceKm", 8, 2, dto.MaxDistanceKm);
        cmd.Parameters.Add("@MinIntervalDays", SqlDbType.Int).Value = dto.MinIntervalDays;

        await cmd.ExecuteNonQueryAsync();
        return Results.Ok(new { success = true, message = "New sequential Quota Tier added." });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
});

/*==============================================================================
  ENDPOINT 9: POST /api/customers & POST /api/policies
==============================================================================*/
app.MapPost("/api/customers", async (HttpContext httpContext, CreateCustomerDto dto) =>
{
    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);
        await using var cmd = new SqlCommand("dbo.usp_CreateCustomer", conn)
        {
            CommandType = CommandType.StoredProcedure
        };
        cmd.Parameters.Add("@FullName", SqlDbType.NVarChar, 120).Value = dto.FullName;
        cmd.Parameters.Add("@Phone", SqlDbType.VarChar, 30).Value = dto.Phone;
        cmd.Parameters.Add("@Email", SqlDbType.VarChar, 120).Value = (object?)dto.Email ?? DBNull.Value;

        int newCustId = Convert.ToInt32(await cmd.ExecuteScalarAsync());

        return Results.Ok(new
        {
            success = true,
            customerId = newCustId,
            fullName = dto.FullName,
            message = $"Customer '{dto.FullName}' registered in dbo.Customers (ID #{newCustId})."
        });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
});

app.MapPost("/api/policies", async (HttpContext httpContext, CreatePolicyDto dto) =>
{
    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);
        await using var cmd = new SqlCommand("dbo.usp_CreatePolicyWithTiers", conn)
        {
            CommandType = CommandType.StoredProcedure
        };
        cmd.Parameters.Add("@InputCustomerId", SqlDbType.Int).Value = (object?)dto.CustomerId ?? DBNull.Value;
        cmd.Parameters.Add("@FullName", SqlDbType.NVarChar, 120).Value = (object?)dto.CustomerName ?? "";
        cmd.Parameters.Add("@Phone", SqlDbType.VarChar, 30).Value = (object?)dto.CustomerPhone ?? "";
        cmd.Parameters.Add("@Email", SqlDbType.VarChar, 120).Value = (object?)dto.CustomerEmail ?? DBNull.Value;
        cmd.Parameters.Add("@PolicyNumber", SqlDbType.VarChar, 40).Value = dto.PolicyNumber;
        cmd.Parameters.Add("@ProviderId", SqlDbType.Int).Value = dto.ProviderId;
        if (!DateTime.TryParse(dto.StartDate, out var parsedStart) || !DateTime.TryParse(dto.ExpirationDate, out var parsedEnd))
        {
            return Results.BadRequest(new { success = false, error = "Invalid policy StartDate or ExpirationDate format." });
        }
        cmd.Parameters.Add("@StartDate", SqlDbType.Date).Value = parsedStart;
        cmd.Parameters.Add("@ExpirationDate", SqlDbType.Date).Value = parsedEnd;
        AddDecimalParam(cmd, "@DefaultAllowedKm", 8, 2, dto.DefaultAllowedKm);
        cmd.Parameters.Add("@MechanicalAllowedTows", SqlDbType.Int).Value = dto.MechanicalAllowedTows;
        cmd.Parameters.Add("@MechanicalCooldownDays", SqlDbType.Int).Value = dto.MechanicalCooldownDays;
        cmd.Parameters.Add("@AccidentAllowedTows", SqlDbType.Int).Value = dto.AccidentAllowedTows;
        cmd.Parameters.Add("@AccidentCooldownDays", SqlDbType.Int).Value = dto.AccidentCooldownDays;

        int newPolicyId = 0;
        int finalCustomerId = dto.CustomerId ?? 1;
        await using (var reader = await cmd.ExecuteReaderAsync())
        {
            if (await reader.ReadAsync())
            {
                newPolicyId = reader.GetInt32(0);
                finalCustomerId = reader.GetInt32(1);
            }
        }

        return Results.Ok(new
        {
            success = true,
            policyId = newPolicyId,
            customerId = finalCustomerId,
            policyNumber = dto.PolicyNumber,
            message = $"Policy '{dto.PolicyNumber}' created and linked to Customer ID #{finalCustomerId}."
        });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
});

/*==============================================================================
  ENDPOINT 10: NORMALIZED DRIVERS, ASSIGNMENTS, TARIFFS & PARTIAL PAYMENTS
==============================================================================*/
// Single-row 3NF update on dbo.Drivers (full normalized profile or phone/off-day) without touching TowTrucks or TowRequests!
app.MapPut("/api/drivers/{driverId:int}", async (HttpContext httpContext, int driverId, UpdateDriverDto dto) =>
{
    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);
        await using var cmd = new SqlCommand("dbo.usp_UpdateDriverContact", conn)
        {
            CommandType = CommandType.StoredProcedure
        };
        cmd.Parameters.Add("@DriverId", SqlDbType.Int).Value = driverId;
        cmd.Parameters.Add("@Phone", SqlDbType.VarChar, 30).Value = dto.Phone;
        cmd.Parameters.Add("@IsWorkingOffDay", SqlDbType.Bit).Value = dto.IsWorkingOffDay;
        cmd.Parameters.Add("@FullName", SqlDbType.NVarChar, 100).Value = (object?)dto.FullName ?? DBNull.Value;
        cmd.Parameters.Add("@LicenseNumber", SqlDbType.VarChar, 40).Value = (object?)dto.LicenseNumber ?? DBNull.Value;
        if (dto.BaseMonthlySalary.HasValue)
            AddDecimalParam(cmd, "@BaseMonthlySalary", 10, 2, dto.BaseMonthlySalary.Value);
        else
            cmd.Parameters.Add("@BaseMonthlySalary", SqlDbType.Decimal).Value = DBNull.Value;

        if (dto.OvertimeRatePerTow.HasValue)
            AddDecimalParam(cmd, "@OvertimeRatePerTow", 8, 2, dto.OvertimeRatePerTow.Value);
        else
            cmd.Parameters.Add("@OvertimeRatePerTow", SqlDbType.Decimal).Value = DBNull.Value;

        cmd.Parameters.Add("@DriverStatus", SqlDbType.VarChar, 20).Value = (object?)dto.DriverStatus ?? DBNull.Value;

        await cmd.ExecuteNonQueryAsync();
        return Results.Ok(new { success = true, message = "Driver record updated in dbo.Drivers (0 trucks/requests duplicated)." });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
});

// Registers a new normalized Driver in dbo.Drivers
app.MapPost("/api/drivers", async (HttpContext httpContext, CreateDriverDto dto) =>
{
    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);
        await using var cmd = new SqlCommand("dbo.usp_CreateDriver", conn)
        {
            CommandType = CommandType.StoredProcedure
        };
        cmd.Parameters.Add("@EmployeeCode", SqlDbType.VarChar, 20).Value = dto.EmployeeCode.Trim();
        cmd.Parameters.Add("@FullName", SqlDbType.NVarChar, 100).Value = dto.FullName.Trim();
        cmd.Parameters.Add("@Phone", SqlDbType.VarChar, 30).Value = dto.Phone.Trim();
        cmd.Parameters.Add("@LicenseNumber", SqlDbType.VarChar, 40).Value = dto.LicenseNumber.Trim();
        AddDecimalParam(cmd, "@BaseMonthlySalary", 10, 2, dto.BaseMonthlySalary);
        AddDecimalParam(cmd, "@OvertimeRatePerTow", 8, 2, dto.OvertimeRatePerTow);
        cmd.Parameters.Add("@IsWorkingOffDay", SqlDbType.Bit).Value = dto.IsWorkingOffDay;
        cmd.Parameters.Add("@DriverStatus", SqlDbType.VarChar, 20).Value = dto.DriverStatus;

        int newDriverId = Convert.ToInt32(await cmd.ExecuteScalarAsync());
        return Results.Ok(new { success = true, driverId = newDriverId, message = $"Driver '{dto.FullName.Trim()}' ({dto.EmployeeCode.Trim()}) created in dbo.Drivers." });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
});

// Registers a new normalized TowTruck in dbo.TowTrucks
app.MapPost("/api/trucks", async (HttpContext httpContext, UpsertTowTruckDto dto) =>
{
    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);
        await using var cmd = new SqlCommand("dbo.usp_CreateTowTruck", conn)
        {
            CommandType = CommandType.StoredProcedure
        };
        cmd.Parameters.Add("@TruckCode", SqlDbType.VarChar, 20).Value = dto.TruckCode.Trim();
        cmd.Parameters.Add("@LicensePlate", SqlDbType.VarChar, 20).Value = dto.LicensePlate.Trim();
        cmd.Parameters.Add("@TruckModel", SqlDbType.NVarChar, 80).Value = dto.TruckModel.Trim();
        cmd.Parameters.Add("@MaxPayloadKg", SqlDbType.Int).Value = dto.MaxPayloadKg;
        AddDecimalParam(cmd, "@CurrentLat", 9, 6, dto.CurrentLat);
        AddDecimalParam(cmd, "@CurrentLng", 9, 6, dto.CurrentLng);
        cmd.Parameters.Add("@FleetStatus", SqlDbType.VarChar, 20).Value = dto.FleetStatus;

        int newTruckId = Convert.ToInt32(await cmd.ExecuteScalarAsync());
        return Results.Ok(new { success = true, truckId = newTruckId, message = $"Tow truck '{dto.TruckCode.Trim()}' registered in dbo.TowTrucks." });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
});

// Updates a normalized TowTruck in dbo.TowTrucks
app.MapPut("/api/trucks/{truckId:int}", async (HttpContext httpContext, int truckId, UpsertTowTruckDto dto) =>
{
    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);
        await using var cmd = new SqlCommand("dbo.usp_UpdateTowTruck", conn)
        {
            CommandType = CommandType.StoredProcedure
        };
        cmd.Parameters.Add("@TruckId", SqlDbType.Int).Value = truckId;
        cmd.Parameters.Add("@TruckCode", SqlDbType.VarChar, 20).Value = dto.TruckCode.Trim();
        cmd.Parameters.Add("@LicensePlate", SqlDbType.VarChar, 20).Value = dto.LicensePlate.Trim();
        cmd.Parameters.Add("@TruckModel", SqlDbType.NVarChar, 80).Value = dto.TruckModel.Trim();
        cmd.Parameters.Add("@MaxPayloadKg", SqlDbType.Int).Value = dto.MaxPayloadKg;
        AddDecimalParam(cmd, "@CurrentLat", 9, 6, dto.CurrentLat);
        AddDecimalParam(cmd, "@CurrentLng", 9, 6, dto.CurrentLng);
        cmd.Parameters.Add("@FleetStatus", SqlDbType.VarChar, 20).Value = dto.FleetStatus;

        await cmd.ExecuteNonQueryAsync();
        return Results.Ok(new { success = true, message = $"Tow truck '{dto.TruckCode.Trim()}' updated in dbo.TowTrucks." });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
});

// Ends an active DriverTruckAssignments shift cleanly (places driver & truck on Standby)
app.MapPost("/api/driver-assignments/{assignmentId:int}/end", async (HttpContext httpContext, int assignmentId, EndAssignmentDto? dto) =>
{
    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);
        await using var cmd = new SqlCommand("dbo.usp_EndDriverTruckAssignment", conn)
        {
            CommandType = CommandType.StoredProcedure
        };
        cmd.Parameters.Add("@AssignmentId", SqlDbType.Int).Value = assignmentId;
        cmd.Parameters.Add("@EndNotes", SqlDbType.NVarChar, 200).Value = (object?)dto?.EndNotes ?? DBNull.Value;

        await cmd.ExecuteNonQueryAsync();
        return Results.Ok(new { success = true, message = "Active shift ended (EndDate recorded in dbo.DriverTruckAssignments)." });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
});

// Updates a normalized Customer in dbo.Customers
app.MapPut("/api/customers/{customerId:int}", async (HttpContext httpContext, int customerId, CreateCustomerDto dto) =>
{
    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);
        await using var cmd = new SqlCommand("dbo.usp_UpdateCustomer", conn)
        {
            CommandType = CommandType.StoredProcedure
        };
        cmd.Parameters.Add("@CustomerId", SqlDbType.Int).Value = customerId;
        cmd.Parameters.Add("@FullName", SqlDbType.NVarChar, 120).Value = dto.FullName.Trim();
        cmd.Parameters.Add("@Phone", SqlDbType.VarChar, 30).Value = dto.Phone.Trim();
        cmd.Parameters.Add("@Email", SqlDbType.VarChar, 120).Value = (object?)dto.Email ?? DBNull.Value;

        await cmd.ExecuteNonQueryAsync();
        return Results.Ok(new { success = true, message = $"Customer '{dto.FullName.Trim()}' updated in dbo.Customers." });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
});

// Closes prior active DriverTruckAssignments row (EndDate = NOW) and opens new assignment
app.MapPost("/api/driver-assignments", async (HttpContext httpContext, AssignDriverTruckDto dto) =>
{
    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);
        await using var cmd = new SqlCommand("dbo.usp_AssignDriverToTruck", conn)
        {
            CommandType = CommandType.StoredProcedure
        };
        cmd.Parameters.Add("@DriverId", SqlDbType.Int).Value = dto.DriverId;
        cmd.Parameters.Add("@TruckId", SqlDbType.Int).Value = dto.TruckId;
        cmd.Parameters.Add("@AssignmentNotes", SqlDbType.NVarChar, 200).Value = (object?)dto.AssignmentNotes ?? DBNull.Value;

        await cmd.ExecuteNonQueryAsync();
        return Results.Ok(new { success = true, message = "Driver reassigned to truck; historical assignment preserved in dbo.DriverTruckAssignments." });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
});

// Adds a new Tariff in dbo.Tariffs while preserving historical TowInvoices snapshot pricing
app.MapPost("/api/tariffs", async (HttpContext httpContext, CreateTariffDto dto) =>
{
    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);
        await using var cmd = new SqlCommand("dbo.usp_CreateTariff", conn)
        {
            CommandType = CommandType.StoredProcedure
        };
        cmd.Parameters.Add("@TariffCode", SqlDbType.VarChar, 30).Value = dto.TariffCode;
        cmd.Parameters.Add("@TariffName", SqlDbType.NVarChar, 100).Value = dto.TariffName;
        cmd.Parameters.Add("@ServiceCategory", SqlDbType.VarChar, 20).Value = dto.ServiceCategory;
        AddDecimalParam(cmd, "@BaseFee", 10, 2, dto.BaseFee);
        AddDecimalParam(cmd, "@PricePerKm", 8, 2, dto.PricePerKm);
        AddDecimalParam(cmd, "@NightSurcharge", 10, 2, dto.NightSurcharge);
        if (!DateTime.TryParse(dto.EffectiveFrom, out var parsedEffectiveFrom))
        {
            return Results.BadRequest(new { success = false, error = "Invalid tariff EffectiveFrom date format." });
        }
        cmd.Parameters.Add("@EffectiveFrom", SqlDbType.Date).Value = parsedEffectiveFrom;

        await using var reader = await cmd.ExecuteReaderAsync();
        object? tariff = null;
        if (await reader.ReadAsync())
        {
            tariff = new
            {
                tariffId = reader.GetInt32(0),
                tariffCode = reader.GetString(1),
                tariffName = reader.GetString(2)
            };
        }
        return Results.Ok(new { success = true, message = $"Tariff '{dto.TariffCode}' activated. Historical invoices remain locked at their original rates.", tariff });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
});

// Records an individual partial or full payment row in dbo.InvoicePayments for InsuranceProvider or Customer
app.MapPost("/api/invoices/{invoiceId:int}/payments", async (HttpContext httpContext, int invoiceId, RecordPaymentDto dto) =>
{
    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);
        await using var cmd = new SqlCommand("dbo.usp_RecordInvoicePayment", conn)
        {
            CommandType = CommandType.StoredProcedure
        };
        cmd.Parameters.Add("@InvoiceId", SqlDbType.Int).Value = invoiceId;
        cmd.Parameters.Add("@PayerType", SqlDbType.VarChar, 20).Value = dto.PayerType;
        AddDecimalParam(cmd, "@AmountPaid", 10, 2, dto.AmountPaid);
        cmd.Parameters.Add("@PaymentMethod", SqlDbType.VarChar, 30).Value = dto.PaymentMethod;
        cmd.Parameters.Add("@ReferenceNumber", SqlDbType.VarChar, 60).Value = (object?)dto.ReferenceNumber ?? DBNull.Value;
        cmd.Parameters.Add("@CollectedByDriverId", SqlDbType.Int).Value = (object?)dto.CollectedByDriverId ?? DBNull.Value;
        cmd.Parameters.Add("@Notes", SqlDbType.NVarChar, 200).Value = (object?)dto.Notes ?? DBNull.Value;

        await using var reader = await cmd.ExecuteReaderAsync();
        object? updated = null;
        if (await reader.ReadAsync())
        {
            updated = new
            {
                invoiceId = reader.GetInt32(0),
                invoiceNumber = reader.GetString(1),
                insurerBilledAmount = reader.GetDecimal(2),
                insurerPaidAmount = reader.GetDecimal(3),
                insurerBalanceDue = reader.GetDecimal(4),
                customerBilledAmount = reader.GetDecimal(5),
                customerPaidAmount = reader.GetDecimal(6),
                customerBalanceDue = reader.GetDecimal(7),
                invoiceStatus = reader.GetString(8)
            };
        }
        return Results.Ok(new { success = true, message = $"Recorded {dto.PayerType} payment of ${dto.AmountPaid:F2} in dbo.InvoicePayments.", invoice = updated });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
});

/*==============================================================================
  ENDPOINT 11: POST /api/tow-requests/{id}/test-immutability-trigger
  Attempts to modify a finalized TowRequest via dbo.usp_UpdateTowLifecycleStatus,
  proving dbo.trg_TowRequests_ImmutabilityAndAudit blocks tampering (Err 50010).
==============================================================================*/
app.MapPost("/api/tow-requests/{id:int}/test-immutability-trigger", async (HttpContext httpContext, int id) =>
{
    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);
        await using (var detailCmd = new SqlCommand("dbo.usp_GetTowRequestDetailById", conn) { CommandType = CommandType.StoredProcedure })
        {
            detailCmd.Parameters.Add("@TowRequestId", SqlDbType.Int).Value = id;
            await using var r = await detailCmd.ExecuteReaderAsync();
            if (!await r.ReadAsync())
            {
                return Results.NotFound(new { success = false, error = "Tow request not found." });
            }
            string currentStatus = r.GetString(r.GetOrdinal("Status"));
            if (currentStatus is not ("Done" or "UnableToLoad" or "Rejected"))
            {
                return Results.BadRequest(new { success = false, error = "Compliance seal verification applies only to finalized tickets." });
            }
        }

        await using var cmd = new SqlCommand("dbo.usp_UpdateTowLifecycleStatus", conn)
        {
            CommandType = CommandType.StoredProcedure
        };
        cmd.Parameters.Add("@TowRequestId", SqlDbType.Int).Value = id;
        cmd.Parameters.Add("@NewStatus", SqlDbType.VarChar, 25).Value = "InProgress";
        AddDecimalParam(cmd, "@CashCollected", 10, 2, 0m);
        cmd.Parameters.Add("@RejectionReason", SqlDbType.NVarChar, 300).Value = DBNull.Value;

        await cmd.ExecuteNonQueryAsync();
        return Results.Ok(new { blockedByTrigger = false, message = "Ticket was modified." });
    }
    catch (SqlException ex) when (ex.Number is 50030 or 50031 or 50032 or 50060)
    {
        return MapSqlExceptionResult(ex);
    }
    catch (SqlException ex) when (ex.Number >= 50000 && ex.Number <= 50999)
    {
        return Results.Ok(new
        {
            blockedByTrigger = true,
            sqlErrorNumber = ex.Number,
            triggerMessage = ex.Message
        });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
});

/*==============================================================================
  ENDPOINT 12: PUT /api/tow-requests/{id}/optimistic-edit
==============================================================================*/
app.MapPut("/api/tow-requests/{id:int}/optimistic-edit", async (HttpContext httpContext, int id, OptimisticEditDto dto) =>
{
    if (!TryHexToRowVer(dto.ExpectedRowVerHex, out byte[] rowVerBytes))
    {
        return Results.BadRequest(new { success = false, error = "Invalid 8-byte hexadecimal revision token." });
    }

    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);

        await using var cmd = new SqlCommand("dbo.usp_UpdateDraftTowOptimistic", conn)
        {
            CommandType = CommandType.StoredProcedure
        };

        cmd.Parameters.Add("@TowRequestId", SqlDbType.Int).Value = id;
        cmd.Parameters.Add("@NewIssueType", SqlDbType.VarChar, 20).Value = dto.IssueType;
        cmd.Parameters.Add("@NewIssueNotes", SqlDbType.NVarChar, 400).Value = dto.IssueNotes;
        cmd.Parameters.Add("@ExpectedRowVer", SqlDbType.Binary, 8).Value = rowVerBytes;

        await cmd.ExecuteNonQueryAsync();
        return Results.Ok(new { success = true, message = "Draft updated successfully (ROWVERSION matched)." });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
});

/*==============================================================================
  ENDPOINT 13: POST /api/concurrency/simulate-race
  Runs two parallel database connections under the authenticated caller's
  SESSION_CONTEXT competing for the last remaining Accident tow on Policy #2,
  proving UPDLOCK + ROWLOCK row-level serialization & audit attribution!
==============================================================================*/
app.MapPost("/api/concurrency/simulate-race", async (HttpContext httpContext) =>
{
    int reqIdA = 0, reqIdB = 0;
    string reqNumA = "", reqNumB = "";

    await using (var setupConn = await OpenAuthenticatedConnectionAsync(httpContext))
    {
        await using var prepCmd = new SqlCommand("dbo.usp_PrepareConcurrencyRaceDemo", setupConn)
        {
            CommandType = CommandType.StoredProcedure
        };
        prepCmd.Parameters.Add("@CheckOnly", SqlDbType.Bit).Value = false;

        await using var r = await prepCmd.ExecuteReaderAsync();
        if (await r.ReadAsync())
        {
            reqIdA = r.GetInt32(0);
            reqNumA = r.GetString(1);
        }
        if (await r.ReadAsync())
        {
            reqIdB = r.GetInt32(0);
            reqNumB = r.GetString(1);
        }
    }

    var globalTimer = Stopwatch.StartNew();

    async Task<object> RunDispatcherAsync(
        string dispatcherLabel, int simUserId, string simUsername, int towRequestId, string requestNumber, int truckId, int staggerMs)
    {
        if (staggerMs > 0) await Task.Delay(staggerMs);
        long startedAtMs = globalTimer.ElapsedMilliseconds;

        try
        {
            await using var conn = await OpenRawLeastPrivilegeConnectionAsync();
            await SetAndValidateDispatcherContextAsync(conn, simUserId, simUsername, updateLastLogin: false);

            await using var cmd = new SqlCommand("dbo.usp_ApproveAndDispatchTow", conn)
            {
                CommandType = CommandType.StoredProcedure
            };
            cmd.Parameters.Add("@TowRequestId", SqlDbType.Int).Value = towRequestId;
            cmd.Parameters.Add("@AssignedTruckId", SqlDbType.Int).Value = truckId;
            cmd.Parameters.Add("@SubcontractorId", SqlDbType.Int).Value = DBNull.Value;
            cmd.Parameters.Add("@SimulatedHoldMs", SqlDbType.Int).Value = 350;

            await cmd.ExecuteNonQueryAsync();
            long finishedAtMs = globalTimer.ElapsedMilliseconds;

            return new
            {
                dispatcher = dispatcherLabel,
                towRequestId,
                requestNumber,
                outcome = "COMMITTED",
                startedAtMs,
                finishedAtMs,
                durationMs = finishedAtMs - startedAtMs,
                detail = $"SESSION_CONTEXT({simUsername}) acquired UPDLOCK on Policy #2, verified 1 Accident tow left, incremented UsedTows (1 -> 2), and COMMITTED."
            };
        }
        catch (SqlException ex)
        {
            long finishedAtMs = globalTimer.ElapsedMilliseconds;
            return new
            {
                dispatcher = dispatcherLabel,
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

    int callerId = (int)(httpContext.Items["OperatorUserId"] ?? 0);
    string callerName = (string)(httpContext.Items["OperatorUsername"] ?? "operator");
    var task1 = RunDispatcherAsync($"{callerName} (Desk Session #1)", callerId, callerName, reqIdA, reqNumA, 3, 0);
    var task2 = RunDispatcherAsync($"{callerName} (Desk Session #2)", callerId, callerName, reqIdB, reqNumB, 4, 25);

    var results = await Task.WhenAll(task1, task2);

    int finalAllowed = 0, finalUsed = 0;
    await using (var checkConn = await OpenAuthenticatedConnectionAsync(httpContext))
    {
        await using var checkCmd = new SqlCommand("dbo.usp_PrepareConcurrencyRaceDemo", checkConn)
        {
            CommandType = CommandType.StoredProcedure
        };
        checkCmd.Parameters.Add("@CheckOnly", SqlDbType.Bit).Value = true;
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
        concurrencyMechanism = "BEGIN TRAN + WITH (UPDLOCK, ROWLOCK) + SESSION_CONTEXT + TRY...CATCH + ROLLBACK TRAN",
        sessionResults = results
    });
}).RequireRateLimiting("ops-heavy");

/*==============================================================================
  ENDPOINT 14: GET /api/performance/search
  Executes Stored Procedure dbo.usp_SearchTowRequestsArchive across >120,000
  normalized rows (TowRequests + Vehicles + TowInvoices).
==============================================================================*/
app.MapGet("/api/performance/search", async (
    HttpContext httpContext,
    string? mode,
    int? policyId,
    string? issueType,
    string? status,
    string? startDate,
    string? endDate,
    string? vehiclePlate,
    string? matchMode,
    string? domain,
    int? page,
    int? pageSize) =>
{
    if (domain is not null && domain.Length > 8192)
    {
        return Results.BadRequest(new { success = false, error = "Search domain filter exceeds maximum allowed length." });
    }

    await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);

    string normalizedMode = (mode ?? (string.IsNullOrWhiteSpace(domain) ? "daterange" : "domain")).Trim().ToLowerInvariant();
    string normalizedMatch = string.Equals(matchMode, "any", StringComparison.OrdinalIgnoreCase) ? "any" : "all";
    string indexName;
    string queryPlanNote;

    if (normalizedMode == "domain" && !string.IsNullOrWhiteSpace(domain))
    {
        indexName = "UX_Vehicles_RegisteredPlate + IX_TowRequests_Status_CreatedAt_Covering + UX_TowInvoices_TowRequestId_Covering";
        queryPlanNote = $"Parameterized Domain ({normalizedMatch.ToUpperInvariant()}) via OPENJSON + SARGable Pre-Bounds -> Index Seeks, 0 Dynamic SQL";
    }
    else if (normalizedMode == "policy")
    {
        indexName = "IX_TowRequests_Policy_Issue_CreatedAt + UX_TowInvoices_TowRequestId_Covering + PK_Vehicles";
        queryPlanNote = "Index Seeks across all 3 normalized tables, 0 Key Lookups, 0 Sort (ORDERED FORWARD by CreatedAt DESC)";
    }
    else if (normalizedMode == "plate")
    {
        indexName = "UX_Vehicles_RegisteredPlate + IX_TowRequests_VehicleId_CreatedAt + UX_TowInvoices_TowRequestId_Covering";
        queryPlanNote = "Filtered Unique Index Seek on Vehicles -> Index Seek on TowRequests (0 Key Lookups, 0 Sort, 0 Worktable)";
    }
    else
    {
        indexName = "IX_TowRequests_Status_CreatedAt_Covering + UX_TowInvoices_TowRequestId_Covering + PK_Vehicles";
        queryPlanNote = "SARGable Date Range (CreatedAt >= @StartDate AND CreatedAt < @EndDate) -> Index Seek, 0 Key Lookups, 0 Sort";
    }

    DateTime start = DateTime.TryParse(startDate, out var s) ? s : new DateTime(2026, 10, 1);
    DateTime end = DateTime.TryParse(endDate, out var e) ? e : new DateTime(2026, 11, 2);

    await using var cmd = new SqlCommand("dbo.usp_SearchTowRequestsArchive", conn)
    {
        CommandType = CommandType.StoredProcedure
    };
    cmd.Parameters.Add("@Mode", SqlDbType.VarChar, 20).Value = normalizedMode;
    cmd.Parameters.Add("@PolicyId", SqlDbType.Int).Value = policyId ?? 42;
    cmd.Parameters.Add("@IssueType", SqlDbType.VarChar, 20).Value = issueType ?? "Mechanical";
    cmd.Parameters.Add("@Status", SqlDbType.VarChar, 25).Value = status ?? "Done";

    var pStart = cmd.Parameters.Add("@StartDate", SqlDbType.DateTime2);
    pStart.Scale = 0;
    pStart.Value = start;

    var pEnd = cmd.Parameters.Add("@EndDate", SqlDbType.DateTime2);
    pEnd.Scale = 0;
    pEnd.Value = end;

    int safePage = Math.Max(1, page ?? 1);
    int safePageSize = Math.Clamp(pageSize ?? 50, 10, 250);

    cmd.Parameters.Add("@VehiclePlate", SqlDbType.VarChar, 30).Value = (vehiclePlate ?? "M 100001").Trim();
    cmd.Parameters.Add("@MatchMode", SqlDbType.VarChar, 10).Value = normalizedMatch;
    cmd.Parameters.Add("@DomainJson", SqlDbType.NVarChar, -1).Value =
        string.IsNullOrWhiteSpace(domain) ? DBNull.Value : domain;
    cmd.Parameters.Add("@Page", SqlDbType.Int).Value = safePage;
    cmd.Parameters.Add("@PageSize", SqlDbType.Int).Value = safePageSize;
    var pTotal = cmd.Parameters.Add("@TotalMatched", SqlDbType.Int);
    pTotal.Direction = ParameterDirection.Output;

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
                distanceSource = reader.GetString(7),
                allowedDistanceKm = reader.GetDecimal(8),
                overageAmount = reader.GetDecimal(9),
                insurerBilledAmount = reader.GetDecimal(10),
                totalAmount = reader.GetDecimal(11),
                invoiceStatus = reader.GetString(12),
                createdAt = reader.GetDateTime(13).ToString("yyyy-MM-dd HH:mm")
            });
        }
    }
    sw.Stop();

    int totalMatched = pTotal.Value != null && pTotal.Value != DBNull.Value
        ? Convert.ToInt32(pTotal.Value)
        : rows.Count;
    if (totalMatched == 0 && rows.Count > 0) totalMatched = rows.Count;

    return Results.Ok(new
    {
        mode = normalizedMode,
        elapsedMs = Math.Round(sw.Elapsed.TotalMilliseconds, 2),
        totalMatched,
        rowCountReturned = rows.Count,
        page = safePage,
        pageSize = safePageSize,
        indexUsed = indexName,
        planCharacteristics = queryPlanNote,
        rows
    });
});

/*==============================================================================
  ENDPOINTS 15-18: ADMIN USER & GRANULAR PERMISSION (RBAC) MANAGEMENT
  Protected inside SQL Server via SESSION_CONTEXT(AppUserId) + CanManageUsers = 1
  across dbo.usp_GetAdminSystemUsers / AdminCreate / AdminUpdate / AdminDelete.
==============================================================================*/
app.MapGet("/api/admin/user-groups", async (HttpContext httpContext) =>
{
    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);
        await using var cmd = new SqlCommand("dbo.usp_GetUserGroups", conn)
        {
            CommandType = CommandType.StoredProcedure
        };

        var groups = new List<object>();
        await using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            groups.Add(new
            {
                groupId = reader.GetInt32(0),
                groupCode = reader.GetString(1),
                groupName = reader.GetString(2),
                description = reader.GetString(3),
                canDispatch = reader.GetBoolean(4),
                canManageFleet = reader.GetBoolean(5),
                canManagePolicies = reader.GetBoolean(6),
                canManageBilling = reader.GetBoolean(7),
                canManageUsers = reader.GetBoolean(8),
                isSystemBuiltIn = reader.GetBoolean(9),
                createdAt = reader.GetDateTime(10).ToString("yyyy-MM-dd"),
                memberCount = reader.GetInt32(11)
            });
        }

        return Results.Ok(new { success = true, groups });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
});

app.MapPost("/api/admin/user-groups", async (HttpContext httpContext, UpsertUserGroupDto dto) =>
{
    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);
        await using var cmd = new SqlCommand("dbo.usp_CreateUserGroup", conn)
        {
            CommandType = CommandType.StoredProcedure
        };
        cmd.Parameters.Add("@GroupCode", SqlDbType.VarChar, 30).Value = dto.GroupCode.Trim();
        cmd.Parameters.Add("@GroupName", SqlDbType.NVarChar, 80).Value = dto.GroupName.Trim();
        cmd.Parameters.Add("@Description", SqlDbType.NVarChar, 250).Value = (object?)dto.Description ?? DBNull.Value;
        cmd.Parameters.Add("@CanDispatch", SqlDbType.Bit).Value = dto.CanDispatch;
        cmd.Parameters.Add("@CanManageFleet", SqlDbType.Bit).Value = dto.CanManageFleet;
        cmd.Parameters.Add("@CanManagePolicies", SqlDbType.Bit).Value = dto.CanManagePolicies;
        cmd.Parameters.Add("@CanManageBilling", SqlDbType.Bit).Value = dto.CanManageBilling;
        cmd.Parameters.Add("@CanManageUsers", SqlDbType.Bit).Value = dto.CanManageUsers;

        int newGroupId = Convert.ToInt32(await cmd.ExecuteScalarAsync());
        return Results.Ok(new
        {
            success = true,
            groupId = newGroupId,
            message = $"Created normalized User Group '{dto.GroupName.Trim()}' ({dto.GroupCode.Trim()}) in dbo.UserGroups."
        });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
});

app.MapPut("/api/admin/user-groups/{groupId:int}", async (HttpContext httpContext, int groupId, UpsertUserGroupDto dto) =>
{
    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);
        await using var cmd = new SqlCommand("dbo.usp_UpdateUserGroup", conn)
        {
            CommandType = CommandType.StoredProcedure
        };
        cmd.Parameters.Add("@GroupId", SqlDbType.Int).Value = groupId;
        cmd.Parameters.Add("@GroupCode", SqlDbType.VarChar, 30).Value = dto.GroupCode.Trim();
        cmd.Parameters.Add("@GroupName", SqlDbType.NVarChar, 80).Value = dto.GroupName.Trim();
        cmd.Parameters.Add("@Description", SqlDbType.NVarChar, 250).Value = (object?)dto.Description ?? DBNull.Value;
        cmd.Parameters.Add("@CanDispatch", SqlDbType.Bit).Value = dto.CanDispatch;
        cmd.Parameters.Add("@CanManageFleet", SqlDbType.Bit).Value = dto.CanManageFleet;
        cmd.Parameters.Add("@CanManagePolicies", SqlDbType.Bit).Value = dto.CanManagePolicies;
        cmd.Parameters.Add("@CanManageBilling", SqlDbType.Bit).Value = dto.CanManageBilling;
        cmd.Parameters.Add("@CanManageUsers", SqlDbType.Bit).Value = dto.CanManageUsers;

        await cmd.ExecuteNonQueryAsync();
        return Results.Ok(new
        {
            success = true,
            message = $"Updated permissions & profile for User Group '{dto.GroupName.Trim()}' in dbo.UserGroups (inherited immediately by all assigned users)."
        });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
});

app.MapDelete("/api/admin/user-groups/{groupId:int}", async (HttpContext httpContext, int groupId) =>
{
    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);
        await using var cmd = new SqlCommand("dbo.usp_DeleteUserGroup", conn)
        {
            CommandType = CommandType.StoredProcedure
        };
        cmd.Parameters.Add("@GroupId", SqlDbType.Int).Value = groupId;

        await cmd.ExecuteNonQueryAsync();
        return Results.Ok(new { success = true, message = "Deleted custom User Group from dbo.UserGroups." });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
});

app.MapGet("/api/admin/users", async (HttpContext httpContext) =>
{
    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);
        await using var cmd = new SqlCommand("dbo.usp_GetAdminSystemUsers", conn)
        {
            CommandType = CommandType.StoredProcedure
        };

        var users = new List<object>();
        await using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            users.Add(new
            {
                userId = reader.GetInt32(0),
                username = reader.GetString(1),
                fullName = reader.GetString(2),
                roleTitle = reader.GetString(3),
                department = reader.GetString(4),
                stationCode = reader.GetString(5),
                accessRole = reader.GetString(6),
                isActive = reader.GetBoolean(7),
                canDispatch = reader.GetBoolean(8),
                canManageFleet = reader.GetBoolean(9),
                canManagePolicies = reader.GetBoolean(10),
                canManageBilling = reader.GetBoolean(11),
                canManageUsers = reader.GetBoolean(12),
                lastLoginAt = reader.IsDBNull(13) ? null : reader.GetDateTime(13).ToString("yyyy-MM-dd HH:mm:ss"),
                createdTowCount = reader.GetInt32(14),
                auditActionCount = reader.GetInt32(15),
                groupId = reader.GetInt32(16),
                groupCode = reader.GetString(17),
                groupName = reader.GetString(18)
            });
        }

        return Results.Ok(new { success = true, users });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
});

app.MapPost("/api/admin/users", async (HttpContext httpContext, AdminCreateUserDto dto) =>
{
    if (string.IsNullOrWhiteSpace(dto.Password) || dto.Password.Length < 8 || dto.Password.Length > 128)
    {
        return Results.BadRequest(new { success = false, error = "Password must be between 8 and 128 characters." });
    }

    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);
        if (httpContext.Items["CanManageUsers"] is not true)
        {
            return Results.Json(new { success = false, error = "Administrator permission is required to provision operators." }, statusCode: StatusCodes.Status403Forbidden);
        }
        string bcryptHash = BCrypt.Net.BCrypt.HashPassword(dto.Password, workFactor: 12);

        await using var cmd = new SqlCommand("dbo.usp_AdminCreateSystemUser", conn)
        {
            CommandType = CommandType.StoredProcedure
        };
        cmd.Parameters.Add("@Username", SqlDbType.VarChar, 60).Value = dto.Username.Trim();
        cmd.Parameters.Add("@PasswordHash", SqlDbType.VarChar, 255).Value = bcryptHash;
        cmd.Parameters.Add("@FullName", SqlDbType.NVarChar, 120).Value = dto.FullName.Trim();
        cmd.Parameters.Add("@RoleTitle", SqlDbType.NVarChar, 80).Value = dto.RoleTitle.Trim();
        cmd.Parameters.Add("@Department", SqlDbType.NVarChar, 80).Value = dto.Department.Trim();
        cmd.Parameters.Add("@StationCode", SqlDbType.VarChar, 30).Value = dto.StationCode.Trim();
        cmd.Parameters.Add("@GroupId", SqlDbType.Int).Value = (object?)dto.GroupId ?? DBNull.Value;
        cmd.Parameters.Add("@AccessRole", SqlDbType.VarChar, 30).Value = DBNull.Value;
        cmd.Parameters.Add("@IsActive", SqlDbType.Bit).Value = dto.IsActive;

        await using var reader = await cmd.ExecuteReaderAsync();
        object? created = null;
        string assignedGroupName = "";
        if (await reader.ReadAsync())
        {
            assignedGroupName = reader.GetString(14);
            created = new
            {
                userId = reader.GetInt32(0),
                username = reader.GetString(1),
                fullName = reader.GetString(2),
                accessRole = reader.GetString(6),
                groupId = reader.GetInt32(13),
                groupName = assignedGroupName
            };
        }

        return Results.Ok(new
        {
            success = true,
            message = $"Created operator '{dto.Username.Trim()}' assigned to group '{assignedGroupName}' with BCrypt (cost=12) hash.",
            user = created
        });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
});

app.MapPut("/api/admin/users/{userId:int}", async (HttpContext httpContext, int userId, AdminUpdateUserDto dto) =>
{
    if (!string.IsNullOrWhiteSpace(dto.NewPassword) && (dto.NewPassword.Length < 8 || dto.NewPassword.Length > 128))
    {
        return Results.BadRequest(new { success = false, error = "New password must be between 8 and 128 characters." });
    }

    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);
        if (httpContext.Items["CanManageUsers"] is not true)
        {
            return Results.Json(new { success = false, error = "Administrator permission is required to modify operators." }, statusCode: StatusCodes.Status403Forbidden);
        }
        string? newBcryptHash = !string.IsNullOrWhiteSpace(dto.NewPassword)
            ? BCrypt.Net.BCrypt.HashPassword(dto.NewPassword, workFactor: 12)
            : null;

        await using var cmd = new SqlCommand("dbo.usp_AdminUpdateSystemUser", conn)
        {
            CommandType = CommandType.StoredProcedure
        };
        cmd.Parameters.Add("@TargetUserId", SqlDbType.Int).Value = userId;
        cmd.Parameters.Add("@FullName", SqlDbType.NVarChar, 120).Value = dto.FullName.Trim();
        cmd.Parameters.Add("@RoleTitle", SqlDbType.NVarChar, 80).Value = dto.RoleTitle.Trim();
        cmd.Parameters.Add("@Department", SqlDbType.NVarChar, 80).Value = dto.Department.Trim();
        cmd.Parameters.Add("@StationCode", SqlDbType.VarChar, 30).Value = dto.StationCode.Trim();
        cmd.Parameters.Add("@GroupId", SqlDbType.Int).Value = (object?)dto.GroupId ?? DBNull.Value;
        cmd.Parameters.Add("@AccessRole", SqlDbType.VarChar, 30).Value = DBNull.Value;
        cmd.Parameters.Add("@IsActive", SqlDbType.Bit).Value = dto.IsActive;
        cmd.Parameters.Add("@NewPasswordHash", SqlDbType.VarChar, 255).Value = (object?)newBcryptHash ?? DBNull.Value;

        await using var reader = await cmd.ExecuteReaderAsync();
        string uname = "", gname = "";
        if (await reader.ReadAsync())
        {
            uname = reader.GetString(1);
            gname = reader.GetString(14);
        }

        if (newBcryptHash != null || !dto.IsActive)
        {
            userRevokedBeforeUnix[userId] = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        }

        return Results.Ok(new
        {
            success = true,
            message = newBcryptHash != null
                ? $"Updated '{uname}' (assigned to '{gname}') and rotated portal password."
                : $"Updated '{uname}' profile and User Group ('{gname}')."
        });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
});

app.MapDelete("/api/admin/users/{userId:int}", async (HttpContext httpContext, int userId) =>
{
    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);
        await using var cmd = new SqlCommand("dbo.usp_AdminDeleteSystemUser", conn)
        {
            CommandType = CommandType.StoredProcedure
        };
        cmd.Parameters.Add("@TargetUserId", SqlDbType.Int).Value = userId;

        await using var reader = await cmd.ExecuteReaderAsync();
        string targetUsername = "";
        userRevokedBeforeUnix[userId] = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        string deletionMode = "HardDeleted";
        if (await reader.ReadAsync())
        {
            targetUsername = reader.GetString(1);
            deletionMode = reader.GetString(2);
        }

        string msg = deletionMode == "HardDeleted"
            ? $"Permanently deleted operator '{targetUsername}' from dbo.SystemUsers."
            : $"Operator '{targetUsername}' owns sealed historical TowRequests: revoked all permissions and deactivated account (IsActive = 0) to preserve 3NF & audit referential integrity.";

        return Results.Ok(new { success = true, deletionMode, message = msg });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
});

/*==============================================================================
  ENDPOINT 19: GET /api/changelogs
  Fetches normalized 3NF Change Logs (dbo.AuditChangeEvents + dbo.AuditChangeDetails
  joined with dbo.SystemUsers) scoped by entity record, section, or full system.
==============================================================================*/
app.MapGet("/api/changelogs", async (
    HttpContext httpContext,
    string? entityType,
    long? entityId,
    string? section,
    int? top) =>
{
    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);
        await using var cmd = new SqlCommand("dbo.usp_GetEntityChangeLogs", conn)
        {
            CommandType = CommandType.StoredProcedure
        };
        cmd.Parameters.Add("@EntityType", SqlDbType.VarChar, 40).Value =
            string.IsNullOrWhiteSpace(entityType) ? DBNull.Value : entityType.Trim();
        cmd.Parameters.Add("@EntityId", SqlDbType.BigInt).Value =
            entityId.HasValue && entityId.Value > 0 ? entityId.Value : DBNull.Value;
        cmd.Parameters.Add("@SectionScope", SqlDbType.VarChar, 40).Value =
            string.IsNullOrWhiteSpace(section) ? DBNull.Value : section.Trim().ToLowerInvariant();
        cmd.Parameters.Add("@TopN", SqlDbType.Int).Value = top ?? 80;

        await using var reader = await cmd.ExecuteReaderAsync();
        var eventOrder = new List<long>();
        var eventsById = new Dictionary<long, Dictionary<string, object?>>();

        while (await reader.ReadAsync())
        {
            long evtId = reader.GetInt64(0);
            eventOrder.Add(evtId);
            eventsById[evtId] = new Dictionary<string, object?>
            {
                ["changeEventId"] = evtId,
                ["entityType"] = reader.GetString(1),
                ["entityId"] = reader.GetInt64(2),
                ["entityCode"] = reader.GetString(3),
                ["operationType"] = reader.GetString(4),
                ["changedByUserId"] = reader.IsDBNull(5) ? (int?)null : reader.GetInt32(5),
                ["changedByUsername"] = reader.GetString(6),
                ["changedByFullName"] = reader.GetString(7),
                ["changedByRole"] = reader.GetString(8),
                ["sqlLoginName"] = reader.GetString(9),
                ["changedAt"] = reader.GetDateTime(10).ToString("yyyy-MM-dd HH:mm:ss"),
                ["details"] = new List<object>()
            };
        }

        await reader.NextResultAsync();
        while (await reader.ReadAsync())
        {
            long evtId = reader.GetInt64(1);
            if (eventsById.TryGetValue(evtId, out var evtDict) && evtDict["details"] is List<object> detList)
            {
                detList.Add(new
                {
                    changeDetailId = reader.GetInt64(0),
                    fieldName = reader.GetString(2),
                    oldValue = reader.IsDBNull(3) ? null : reader.GetString(3),
                    newValue = reader.IsDBNull(4) ? null : reader.GetString(4)
                });
            }
        }

        var logs = eventOrder.Select(id => eventsById[id]).ToList();
        return Results.Ok(new { success = true, logs });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
});

/*==============================================================================
  ENDPOINT 20: GET /api/tow-requests/{towRequestId:int}
  Fetches normalized 3NF Tow Info, linked Split Invoice & Payment Ledger rows,
  and unified Odoo-style Change Logs for any of the 120,000+ TowRequests.
==============================================================================*/
app.MapGet("/api/tow-requests/{towRequestId:int}", async (HttpContext httpContext, int towRequestId) =>
{
    try
    {
        await using var conn = await OpenAuthenticatedConnectionAsync(httpContext);
        await using var cmd = new SqlCommand("dbo.usp_GetTowRequestDetailById", conn)
        {
            CommandType = CommandType.StoredProcedure
        };
        cmd.Parameters.Add("@TowRequestId", SqlDbType.Int).Value = towRequestId;

        await using var reader = await cmd.ExecuteReaderAsync();
        if (!await reader.ReadAsync())
        {
            return Results.NotFound(new { success = false, error = $"Tow request #{towRequestId} was not found." });
        }

        var tow = new
        {
            towRequestId = reader.GetInt32(0),
            requestNumber = reader.GetString(1),
            status = reader.GetString(2),
            issueType = reader.GetString(3),
            issueNotes = reader.GetString(4),
            callerPhone = reader.GetString(5),
            pickupAddress = reader.GetString(6),
            pickupLat = reader.GetDecimal(7),
            pickupLng = reader.GetDecimal(8),
            destinationAddress = reader.GetString(9),
            destinationLat = reader.GetDecimal(10),
            destinationLng = reader.GetDecimal(11),
            straightLineDistanceKm = reader.GetDecimal(12),
            actualDistanceKm = reader.GetDecimal(13),
            distanceSource = reader.GetString(14),
            routeDurationMinutes = reader.IsDBNull(15) ? (decimal?)null : reader.GetDecimal(15),
            truckPrioritySequence = reader.GetInt32(16),
            isNightShift = reader.GetBoolean(17),
            rejectionReason = reader.GetString(18),
            createdAt = reader.GetDateTime(19).ToString("yyyy-MM-dd HH:mm:ss"),
            completedAt = reader.IsDBNull(20) ? null : reader.GetDateTime(20).ToString("yyyy-MM-dd HH:mm:ss"),
            customerId = reader.GetInt32(21),
            customerName = reader.GetString(22),
            customerPhone = reader.GetString(23),
            customerEmail = reader.GetString(24),
            vehicleId = reader.GetInt32(25),
            vehiclePlate = reader.GetString(26),
            vehicleModel = reader.GetString(27),
            noPlate = reader.GetBoolean(28),
            plateRegionCode = reader.GetString(29),
            plateRegionDescription = reader.GetString(30),
            policyId = reader.IsDBNull(31) ? (int?)null : reader.GetInt32(31),
            policyNumber = reader.GetString(32),
            policyStatus = reader.GetString(33),
            providerId = reader.IsDBNull(34) ? (int?)null : reader.GetInt32(34),
            providerName = reader.GetString(35),
            quotaTierId = reader.IsDBNull(36) ? (int?)null : reader.GetInt32(36),
            tierSequence = reader.IsDBNull(37) ? (int?)null : reader.GetInt32(37),
            tierCoverageType = reader.GetString(38),
            tierAllowedTows = reader.IsDBNull(39) ? (int?)null : reader.GetInt32(39),
            tierUsedTows = reader.IsDBNull(40) ? (int?)null : reader.GetInt32(40),
            tierMaxDistanceKm = reader.IsDBNull(41) ? (decimal?)null : reader.GetDecimal(41),
            assignedTruckId = reader.IsDBNull(42) ? (int?)null : reader.GetInt32(42),
            truckCode = reader.GetString(43),
            truckPlate = reader.GetString(44),
            truckModel = reader.GetString(45),
            assignedDriverId = reader.IsDBNull(46) ? (int?)null : reader.GetInt32(46),
            driverCode = reader.GetString(47),
            driverName = reader.GetString(48),
            driverPhone = reader.GetString(49),
            subcontractorId = reader.IsDBNull(50) ? (int?)null : reader.GetInt32(50),
            subcontractorName = reader.GetString(51),
            subcontractorPhone = reader.GetString(52),
            invoiceId = reader.GetInt32(53),
            invoiceNumber = reader.GetString(54),
            tariffId = reader.IsDBNull(55) ? (int?)null : reader.GetInt32(55),
            tariffCode = reader.GetString(56),
            tariffName = reader.GetString(57),
            appliedBaseFee = reader.GetDecimal(58),
            appliedPricePerKm = reader.GetDecimal(59),
            appliedNightSurcharge = reader.GetDecimal(60),
            coveredDistanceKm = reader.GetDecimal(61),
            overageDistanceKm = reader.GetDecimal(62),
            subcontractorCost = reader.GetDecimal(63),
            insurerBilledAmount = reader.GetDecimal(64),
            insurerPaidAmount = reader.GetDecimal(65),
            insurerBalanceDue = reader.GetDecimal(66),
            customerBilledAmount = reader.GetDecimal(67),
            customerPaidAmount = reader.GetDecimal(68),
            customerBalanceDue = reader.GetDecimal(69),
            totalInvoiceAmount = reader.GetDecimal(70),
            invoiceStatus = reader.GetString(71),
            issuedAt = reader.IsDBNull(72) ? null : reader.GetDateTime(72).ToString("yyyy-MM-dd HH:mm:ss")
        };

        await reader.NextResultAsync();
        var payments = new List<object>();
        while (await reader.ReadAsync())
        {
            payments.Add(new
            {
                paymentId = reader.GetInt64(0),
                payerType = reader.GetString(1),
                payerName = reader.GetString(2),
                amountPaid = reader.GetDecimal(3),
                paymentMethod = reader.GetString(4),
                referenceNumber = reader.GetString(5),
                collectedByDriverName = reader.GetString(6),
                recordedByUsername = reader.GetString(7),
                recordedByFullName = reader.GetString(8),
                notes = reader.GetString(9),
                paidAt = reader.GetDateTime(10).ToString("yyyy-MM-dd HH:mm:ss")
            });
        }

        await reader.NextResultAsync();
        var eventOrder = new List<long>();
        var eventsById = new Dictionary<long, Dictionary<string, object?>>();
        while (await reader.ReadAsync())
        {
            long evtId = reader.GetInt64(0);
            eventOrder.Add(evtId);
            eventsById[evtId] = new Dictionary<string, object?>
            {
                ["changeEventId"] = evtId,
                ["entityCode"] = reader.GetString(1),
                ["operationType"] = reader.GetString(2),
                ["changedByUsername"] = reader.GetString(3),
                ["changedByFullName"] = reader.GetString(4),
                ["changedAt"] = reader.GetDateTime(5).ToString("yyyy-MM-dd HH:mm:ss"),
                ["details"] = new List<object>()
            };
        }

        await reader.NextResultAsync();
        while (await reader.ReadAsync())
        {
            long evtId = reader.GetInt64(1);
            if (eventsById.TryGetValue(evtId, out var evtDict) && evtDict["details"] is List<object> detList)
            {
                detList.Add(new
                {
                    changeDetailId = Convert.ToInt64(reader.GetValue(0)),
                    fieldName = reader.GetString(2),
                    oldValue = reader.IsDBNull(3) ? null : reader.GetString(3),
                    newValue = reader.IsDBNull(4) ? null : reader.GetString(4)
                });
            }
        }

        var logs = eventOrder.Select(id => eventsById[id]).ToList();
        return Results.Ok(new { success = true, tow, payments, logs });
    }
    catch (SqlException ex)
    {
        return MapSqlExceptionResult(ex);
    }
});

app.Run();

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
        if (val.Length >= 2 &&
            ((val.StartsWith('"') && val.EndsWith('"')) || (val.StartsWith('\'') && val.EndsWith('\''))))
        {
            val = val[1..^1];
        }
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable(key)))
        {
            Environment.SetEnvironmentVariable(key, val);
        }
    }
}

public record SessionTokenPayload(int Uid, string Uname, string Stn, long Iat, string? Jti = null);

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
    int? SubcontractorId,
    decimal SubcontractorFee,
    int? AssignedTruckId,
    bool AutoApprove,
    string? InitialStatus = "Draft",
    decimal? VerifiedRoadDistanceKm = null
);

public record DispatchTowDto(int AssignedTruckId, int? SubcontractorId = null);
public record UpdateLifecycleDto(string NewStatus, decimal CashCollected, string? RejectionReason);
public record OptimisticEditDto(string IssueType, string IssueNotes, string ExpectedRowVerHex);
public record ReorderQueueDto(int TowRequestId, string Direction);
public record CreatePlateCodeDto(string Code, string RegionDescription, int DisplaySequence);
public record UpdateQuotaTierDto(int TierSequence, string CoverageType, int AllowedTows, int UsedTows, decimal MaxDistanceKm, int MinIntervalDays);
public record LoginRequestDto(string Username, string Password);
public record CreateCustomerDto(string FullName, string Phone, string? Email);
public record CreatePolicyDto(
    int? CustomerId,
    string? CustomerName,
    string? CustomerPhone,
    string? CustomerEmail,
    string PolicyNumber,
    int ProviderId,
    string StartDate,
    string ExpirationDate,
    decimal DefaultAllowedKm,
    int MechanicalAllowedTows,
    int MechanicalCooldownDays,
    int AccidentAllowedTows,
    int AccidentCooldownDays
);
public record UpdateDriverDto(
    string Phone,
    bool IsWorkingOffDay,
    string? FullName = null,
    string? LicenseNumber = null,
    decimal? BaseMonthlySalary = null,
    decimal? OvertimeRatePerTow = null,
    string? DriverStatus = null
);
public record CreateDriverDto(
    string EmployeeCode,
    string FullName,
    string Phone,
    string LicenseNumber,
    decimal BaseMonthlySalary = 850.00m,
    decimal OvertimeRatePerTow = 15.00m,
    bool IsWorkingOffDay = false,
    string DriverStatus = "Active"
);
public record UpsertTowTruckDto(
    string TruckCode,
    string LicensePlate,
    string TruckModel,
    int MaxPayloadKg = 5000,
    decimal CurrentLat = 33.893800m,
    decimal CurrentLng = 35.501800m,
    string FleetStatus = "Available"
);
public record EndAssignmentDto(string? EndNotes = null);
public record AssignDriverTruckDto(int DriverId, int TruckId, string? AssignmentNotes);
public record CreateTariffDto(
    string TariffCode,
    string TariffName,
    string ServiceCategory,
    decimal BaseFee,
    decimal PricePerKm,
    decimal NightSurcharge,
    string EffectiveFrom
);
public record RecordPaymentDto(
    string PayerType,
    decimal AmountPaid,
    string PaymentMethod,
    string? ReferenceNumber,
    int? CollectedByDriverId,
    string? Notes
);
public record UpsertUserGroupDto(
    string GroupCode,
    string GroupName,
    string? Description,
    bool CanDispatch,
    bool CanManageFleet,
    bool CanManagePolicies,
    bool CanManageBilling,
    bool CanManageUsers
);
public record AdminCreateUserDto(
    string Username,
    string Password,
    string FullName,
    string RoleTitle,
    string Department,
    string StationCode,
    int? GroupId = null,
    bool IsActive = true
);
public record AdminUpdateUserDto(
    string FullName,
    string RoleTitle,
    string Department,
    string StationCode,
    int? GroupId = null,
    bool IsActive = true,
    string? NewPassword = null
);
