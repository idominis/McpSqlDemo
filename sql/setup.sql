-- Execute locally in SSMS as a login with permission to create this demo database.
IF DB_ID(N'McpSqlDemo') IS NULL EXEC(N'CREATE DATABASE McpSqlDemo');
GO
USE McpSqlDemo;
GO
IF OBJECT_ID(N'dbo.Shipments', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.Shipments (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        Reference NVARCHAR(50) NOT NULL UNIQUE,
        Status NVARCHAR(30) NOT NULL,
        Quantity DECIMAL(18,2) NOT NULL
    );
END;
GO
IF NOT EXISTS (SELECT 1 FROM dbo.Shipments)
BEGIN
    INSERT dbo.Shipments (Reference, Status, Quantity) VALUES
    (N'SHP-001', N'Pending', 1250.00),
    (N'SHP-002', N'Loading', 820.50),
    (N'SHP-003', N'Completed', 3100.00);
END;
GO
-- Phase 5C.2 least-privilege access is a separate, manual administrative step.
-- Review README.md and sql/setup-mcp-app-reader.sql; do not place passwords here.
