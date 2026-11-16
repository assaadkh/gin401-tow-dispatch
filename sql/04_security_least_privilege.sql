/*==============================================================================
  GIN401 - LAB PROJECT: ROADSIDE ASSISTANCE & TOWING CAD DISPATCH SYSTEM
  Script 04: Security — Least-Privilege Login, User & EXECUTE-Only Role
  DBMS: Microsoft SQL Server

  Security Architecture (Doctor Requirement #5 + 3NF UserGroups RBAC):
  - Passwords in dbo.SystemUsers are hashed with bcrypt (cost=12); separate
    PasswordSalt column has been eliminated. Permissions are normalized into
    dbo.UserGroups (SystemUsers.GroupId FK).
  - Application connects via dedicated login [tow_cad_app_login] / database user
    [tow_cad_app_user] in role [db_tow_dispatcher_role] (NOT sa / NOT sysadmin /
    NOT db_owner).
  - [db_tow_dispatcher_role] is granted EXECUTE permissions ONLY on the 35
    authorized stored procedures in schema [dbo].
  - Zero direct SELECT, INSERT, UPDATE, or DELETE permissions are granted on
    base tables or views, preventing ad-hoc table reads/mutations or SQL injection
    bypass while preserving unbroken dbo ownership chaining inside stored procedures.
==============================================================================*/
USE [master];
GO

-- 1. Verify SQL Server Mixed Mode Authentication Status (Configure Mixed Mode explicitly in SSMS + restart MSSQLSERVER if Windows-only)
IF CAST(SERVERPROPERTY('IsIntegratedSecurityOnly') AS INT) = 1
BEGIN
    RAISERROR('WARNING: SQL Server is currently in Windows-Only Authentication mode (IsIntegratedSecurityOnly = 1). Enable "SQL Server and Windows Authentication mode" in SSMS Server Properties -> Security and restart the SQL Server service so [tow_cad_app_login] can authenticate.', 10, 1) WITH NOWAIT;
END
ELSE
BEGIN
    PRINT 'Verified: SQL Server Mixed Mode Authentication is active (IsIntegratedSecurityOnly = 0).';
END
GO

-- 2. Create or Sync Dedicated Application Login (No sysadmin / server-level roles)
-- Password is supplied at deployment time via sqlcmd -v APP_DB_PASSWORD="..."
-- and read at runtime strictly from backend/.env.
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'tow_cad_app_login')
BEGIN
    CREATE LOGIN [tow_cad_app_login]
        WITH PASSWORD = N'$(APP_DB_PASSWORD)',
             DEFAULT_DATABASE = [GIN401_TowDispatch],
             CHECK_EXPIRATION = OFF,
             CHECK_POLICY = OFF;
END
ELSE
BEGIN
    ALTER LOGIN [tow_cad_app_login]
        WITH PASSWORD = N'$(APP_DB_PASSWORD)',
             DEFAULT_DATABASE = [GIN401_TowDispatch],
             CHECK_EXPIRATION = OFF,
             CHECK_POLICY = OFF;
END
GO

USE [GIN401_TowDispatch];
GO

-- 3. Create or Re-link Database User Mapped to [tow_cad_app_login]
-- (Note: Script 01 drops & recreates GIN401_TowDispatch, so re-creating/mapping
-- [tow_cad_app_user] ensures zero orphaned SID mismatches.)
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'tow_cad_app_user')
BEGIN
    CREATE USER [tow_cad_app_user] FOR LOGIN [tow_cad_app_login] WITH DEFAULT_SCHEMA = [dbo];
END
ELSE
BEGIN
    ALTER USER [tow_cad_app_user] WITH LOGIN = [tow_cad_app_login], DEFAULT_SCHEMA = [dbo];
END
GO

-- 4. Create Custom Least-Privilege Database Role [db_tow_dispatcher_role]
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'db_tow_dispatcher_role' AND type = 'R')
BEGIN
    CREATE ROLE [db_tow_dispatcher_role] AUTHORIZATION [dbo];
END
GO

-- 5. Clean-slate revoke any legacy/direct object permissions on role or user
DECLARE @RevokeSql NVARCHAR(MAX) = N'';
SELECT @RevokeSql = @RevokeSql +
    N'REVOKE ' + dp.permission_name COLLATE DATABASE_DEFAULT +
    N' ON OBJECT::' + QUOTENAME(SCHEMA_NAME(o.schema_id)) + N'.' + QUOTENAME(o.name) +
    N' FROM ' + QUOTENAME(pr.name) + N';' + CHAR(13) + CHAR(10)
FROM sys.database_permissions AS dp
INNER JOIN sys.objects AS o ON dp.major_id = o.object_id
INNER JOIN sys.database_principals AS pr ON dp.grantee_principal_id = pr.principal_id
WHERE pr.name IN (N'db_tow_dispatcher_role', N'tow_cad_app_user')
  AND dp.class = 1;

IF LEN(@RevokeSql) > 0
    EXEC sys.sp_executesql @RevokeSql;
GO

-- 6. Explicitly DENY destructive & direct table operations on sensitive tables as defense-in-depth
-- Note: Do NOT put DENY SELECT/INSERT/UPDATE on tables accessed via ownership chaining if DENY overrides
-- No — wait: in SQL Server, unbroken ownership chaining bypasses permission checks (including DENY on chained tables
-- when the caller only invokes a dbo stored procedure), EXCEPT we don't even need DENY when zero GRANT exists
-- because absence of GRANT already denies all direct SELECT/INSERT/UPDATE/DELETE by default!
-- Keeping zero table GRANTs guarantees HAS_PERMS_BY_NAME('dbo.TowRequests', 'OBJECT', 'SELECT') = 0
-- AND guarantees 100% clean ownership chaining inside dbo.usp_* stored procedures.

-- 7. Grant EXECUTE ONLY on the 38 Authorized Stored Procedures
GRANT EXECUTE ON OBJECT::dbo.usp_ClearDispatcherSessionContext TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_GetSystemUserForAuth          TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_SetDispatcherSessionContext   TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_GetDashboardSnapshot          TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_CheckPolicyAndPreviewTariff   TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_CreateCustomer                TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_UpdateCustomer                TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_CreateCustomerVehicle         TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_CreateInsuranceProvider       TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_UpdateInsuranceProvider       TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_CreatePolicyWithTiers         TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_UpsertQuotaTier               TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_AddPlateCode                  TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_CreateDriver                  TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_UpdateDriverContact           TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_CreateTowTruck                TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_UpdateTowTruck                TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_AssignDriverToTruck           TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_EndDriverTruckAssignment      TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_CreateTariff                  TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_RecordInvoicePayment          TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_CreateTowRequest              TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_ApproveAndDispatchTow         TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_UpdateTowLifecycleStatus      TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_UpdateDraftTowOptimistic      TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_ReorderTruckJobQueue          TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_PrepareConcurrencyRaceDemo    TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_SearchTowRequestsArchive      TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_GetUserGroups                 TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_CreateUserGroup               TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_UpdateUserGroup               TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_DeleteUserGroup               TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_GetAdminSystemUsers           TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_AdminCreateSystemUser         TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_AdminUpdateSystemUser         TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_AdminDeleteSystemUser         TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_GetEntityChangeLogs           TO [db_tow_dispatcher_role];
GRANT EXECUTE ON OBJECT::dbo.usp_GetTowRequestDetailById       TO [db_tow_dispatcher_role];
GO

-- 8. Add application user to [db_tow_dispatcher_role]
ALTER ROLE [db_tow_dispatcher_role] ADD MEMBER [tow_cad_app_user];
GO

-- 9. Verify Effective Permissions Matrix for [db_tow_dispatcher_role]
SELECT
    pr.name AS RoleName,
    dp.state_desc AS PermissionState,
    dp.permission_name AS PermissionName,
    SCHEMA_NAME(o.schema_id) + '.' + o.name AS AuthorizedObject,
    o.type_desc AS ObjectType
FROM sys.database_permissions AS dp
INNER JOIN sys.database_principals AS pr ON dp.grantee_principal_id = pr.principal_id
INNER JOIN sys.objects AS o ON dp.major_id = o.object_id
WHERE pr.name = N'db_tow_dispatcher_role'
ORDER BY o.name ASC;
GO

PRINT '04_security_least_privilege.sql completed successfully (EXECUTE-only dispatcher role active).';
GO
