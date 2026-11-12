/*==============================================================================
  GIN401 - LAB PROJECT: ROADSIDE ASSISTANCE & TOWING CAD DISPATCH SYSTEM
  Script 04: Security — Least-Privilege Login, User & Role Configuration
  DBMS: Microsoft SQL Server
==============================================================================*/
USE [master];
GO

-- 1. Enable Mixed Mode Authentication on SQL Server instance (if not already enabled)
EXEC xp_instance_regwrite
    N'HKEY_LOCAL_MACHINE',
    N'Software\Microsoft\MSSQLServer\MSSQLServer',
    N'LoginMode',
    REG_DWORD,
    2;
GO

-- 2. Create Dedicated Application Login (No sysadmin / server-level roles)
-- Note: Password is provided at deployment time; application reads credentials
-- strictly from environment variables (.env), never hardcoded in C# source code.
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'tow_cad_app_login')
BEGIN
    CREATE LOGIN [tow_cad_app_login]
        WITH PASSWORD = N'$(APP_DB_PASSWORD)',
             DEFAULT_DATABASE = [GIN401_TowDispatch],
             CHECK_EXPIRATION = OFF,
             CHECK_POLICY = OFF;
END
GO

USE [GIN401_TowDispatch];
GO

-- 3. Create Database User Mapped to the Application Login
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'tow_cad_app_user')
BEGIN
    CREATE USER [tow_cad_app_user] FOR LOGIN [tow_cad_app_login];
END
GO

-- 4. Create Custom Least-Privilege Database Role
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'db_tow_dispatcher_role' AND type = 'R')
BEGIN
    CREATE ROLE [db_tow_dispatcher_role];
END
GO

-- 5. Grant ONLY the Minimum Required Permissions to db_tow_dispatcher_role
-- Read access on lookup & operational tables/views
GRANT SELECT ON dbo.InsuranceProviders TO [db_tow_dispatcher_role];
GRANT SELECT, INSERT, UPDATE ON dbo.PlateCodes TO [db_tow_dispatcher_role];
GRANT SELECT, INSERT, UPDATE ON dbo.Customers TO [db_tow_dispatcher_role];
GRANT SELECT, INSERT, UPDATE ON dbo.InsurancePolicies TO [db_tow_dispatcher_role];
GRANT SELECT, INSERT, UPDATE ON dbo.PolicyQuotaTiers TO [db_tow_dispatcher_role];
GRANT SELECT, UPDATE ON dbo.TowTrucks TO [db_tow_dispatcher_role];
GRANT SELECT, INSERT, UPDATE ON dbo.TowRequests TO [db_tow_dispatcher_role];
GRANT SELECT, INSERT ON dbo.TowAuditLogs TO [db_tow_dispatcher_role];
GRANT SELECT, UPDATE ON dbo.SystemUsers TO [db_tow_dispatcher_role];
GRANT SELECT ON dbo.vw_FleetPriorityQueueAndRankings TO [db_tow_dispatcher_role];
GRANT SELECT ON dbo.vw_DriverPayrollAndCashReport TO [db_tow_dispatcher_role];

-- Execute rights on T-SQL Functions & Stored Procedures
GRANT EXECUTE ON dbo.fn_CalculateRoadDistanceKm TO [db_tow_dispatcher_role];
GRANT SELECT  ON dbo.tvf_CheckPolicyEligibility TO [db_tow_dispatcher_role];
GRANT EXECUTE ON dbo.usp_ApproveAndDispatchTow TO [db_tow_dispatcher_role];
GRANT EXECUTE ON dbo.usp_CreateTowRequest TO [db_tow_dispatcher_role];
GRANT EXECUTE ON dbo.usp_UpdateTowLifecycleStatus TO [db_tow_dispatcher_role];
GRANT EXECUTE ON dbo.usp_UpdateDraftTowOptimistic TO [db_tow_dispatcher_role];
GRANT EXECUTE ON dbo.usp_ReorderTruckJobQueue TO [db_tow_dispatcher_role];

-- Explicitly DENY destructive operations (DELETE on tickets/audit logs)
DENY DELETE ON dbo.TowRequests TO [db_tow_dispatcher_role];
DENY DELETE, UPDATE ON dbo.TowAuditLogs TO [db_tow_dispatcher_role];
DENY DELETE ON dbo.InsurancePolicies TO [db_tow_dispatcher_role];
DENY DELETE ON dbo.PolicyQuotaTiers TO [db_tow_dispatcher_role];

-- Add application user to the least-privilege role
ALTER ROLE [db_tow_dispatcher_role] ADD MEMBER [tow_cad_app_user];
GO

PRINT '04_security_least_privilege.sql completed successfully.';
GO
