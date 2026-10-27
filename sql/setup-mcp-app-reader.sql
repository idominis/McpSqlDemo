-- Phase 5C.2: database-side setup for the dedicated MCP SQL login.
--
-- REVIEW BEFORE RUNNING. Run manually in SSMS using an administrative Windows
-- identity, only after creating the SQL login [mcp_app_reader] through the SSMS
-- login dialog as described in README.md. This script intentionally contains no
-- password and never creates or alters a server login.
--
-- The script is idempotent. It uses fixed identifiers and no dynamic SQL.

SET NOCOUNT ON;
SET XACT_ABORT ON;
GO

USE [McpSqlDemo];
GO

IF OBJECT_ID(N'dbo.Shipments', N'U') IS NULL
    THROW 51000, 'Required table dbo.Shipments does not exist.', 1;

IF CONVERT(int, SERVERPROPERTY(N'IsIntegratedSecurityOnly')) = 1
    THROW 51001, 'This instance is Windows-authentication-only. Do not attempt SQL-login setup.', 1;

IF NOT EXISTS (
    SELECT 1
    FROM master.sys.server_principals
    WHERE name = N'mcp_app_reader'
      AND type = N'S')
    THROW 51002, 'Create the SQL login mcp_app_reader manually in SSMS before running this script.', 1;

IF IS_SRVROLEMEMBER(N'sysadmin', N'mcp_app_reader') <> 0
    THROW 51003, 'The mcp_app_reader login must not be a sysadmin.', 1;

IF EXISTS (
    SELECT 1
    FROM master.sys.databases
    WHERE name = N'McpSqlDemo'
      AND owner_sid = SUSER_SID(N'mcp_app_reader'))
    THROW 51009, 'The mcp_app_reader login must not own the McpSqlDemo database.', 1;

IF EXISTS (
    SELECT 1
    FROM master.sys.server_role_members AS membership
    INNER JOIN master.sys.server_principals AS member_principal
        ON member_principal.principal_id = membership.member_principal_id
    WHERE member_principal.name = N'mcp_app_reader')
    THROW 51004, 'The mcp_app_reader login must not belong to a fixed or user-defined server role.', 1;
GO

IF DATABASE_PRINCIPAL_ID(N'mcp_app_reader') IS NULL
BEGIN
    CREATE USER [mcp_app_reader] FOR LOGIN [mcp_app_reader];
END;
ELSE IF NOT EXISTS (
    SELECT 1
    FROM sys.database_principals AS database_principal
    INNER JOIN master.sys.server_principals AS server_principal
        ON server_principal.sid = database_principal.sid
    WHERE database_principal.name = N'mcp_app_reader'
      AND database_principal.type = N'S'
      AND server_principal.name = N'mcp_app_reader'
      AND server_principal.type = N'S')
BEGIN
    THROW 51005, 'Existing database principal mcp_app_reader is not mapped to the expected SQL login.', 1;
END;

IF EXISTS (
    SELECT 1
    FROM sys.database_role_members AS membership
    INNER JOIN sys.database_principals AS member_principal
        ON member_principal.principal_id = membership.member_principal_id
    WHERE member_principal.name = N'mcp_app_reader')
    THROW 51006, 'The mcp_app_reader user must not belong to a database role.', 1;

IF EXISTS (
    SELECT 1
    FROM sys.schemas AS schema_entry
    WHERE schema_entry.principal_id = DATABASE_PRINCIPAL_ID(N'mcp_app_reader'))
    THROW 51007, 'The mcp_app_reader user must not own a schema.', 1;

-- Fail closed if a previous setup added permissions outside this one object.
IF EXISTS (
    SELECT 1
    FROM sys.database_permissions AS permission_entry
    WHERE permission_entry.grantee_principal_id = DATABASE_PRINCIPAL_ID(N'mcp_app_reader')
      AND NOT (
    (
        permission_entry.class = 0
        AND permission_entry.major_id = 0
        AND permission_entry.permission_name = N'CONNECT'
        AND permission_entry.state = 'G'
    )
    OR
    (
        permission_entry.class = 1
        AND permission_entry.major_id = OBJECT_ID(N'dbo.Shipments')
        AND permission_entry.minor_id = 0
        AND permission_entry.permission_name IN
            (N'SELECT', N'INSERT', N'UPDATE', N'DELETE', N'ALTER')
    )
)
    THROW 51008, 'The mcp_app_reader user has permissions outside the approved dbo.Shipments permission set.', 1;

GRANT SELECT ON OBJECT::dbo.Shipments TO [mcp_app_reader];
DENY INSERT, UPDATE, DELETE, ALTER ON OBJECT::dbo.Shipments TO [mcp_app_reader];
GO

