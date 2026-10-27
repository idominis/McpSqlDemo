using Microsoft.Data.SqlClient;
using Xunit;

[Trait("Category", "Integration")]
public sealed class DatabasePermissionIntegrationTests
{
    private const string ReaderUser = "mcp_demo_reader";

    [LocalDbFact]
    public async Task McpDemoReader_HasReadOnlyAccessToShipments()
    {
        var connectionString = Environment.GetEnvironmentVariable("MCP_SQL_CONNECTION")!;
        await using var connection = new SqlConnection(connectionString);
        await connection.OpenAsync();

        await VerifyDatabaseAndUserAsync(connection);

        var impersonated = false;
        try
        {
            try
            {
                await using var executeAs = new SqlCommand(
                    "EXECUTE AS USER = 'mcp_demo_reader';",
                    connection);
                await executeAs.ExecuteNonQueryAsync();
                impersonated = true;
            }
            catch (SqlException exception)
            {
                Assert.Fail(
                    $"Could not impersonate database user '{ReaderUser}' in database " +
                    $"'McpSqlDemo'. The test requires EXECUTE AS USER permission. " +
                    $"SQL Server reported: {exception.Message}");
            }

            var permissions = await ReadShipmentsPermissionsAsync(connection);

            Assert.Equal(1, permissions.Select);
            Assert.Equal(0, permissions.Insert);
            Assert.Equal(0, permissions.Update);
            Assert.Equal(0, permissions.Delete);
            Assert.Equal(0, permissions.Alter);
        }
        finally
        {
            if (impersonated)
            {
                await using var revert = new SqlCommand("REVERT;", connection);
                await revert.ExecuteNonQueryAsync();
            }
        }
    }

    private static async Task VerifyDatabaseAndUserAsync(SqlConnection connection)
    {
        const string sql = """
            SELECT
                DB_NAME(),
                CASE WHEN EXISTS (
                    SELECT 1
                    FROM sys.database_principals
                    WHERE name = N'mcp_demo_reader'
                      AND type IN ('S', 'U', 'G', 'E', 'X')
                ) THEN 1 ELSE 0 END;
            """;

        await using var command = new SqlCommand(sql, connection);
        await using var reader = await command.ExecuteReaderAsync();
        Assert.True(await reader.ReadAsync(), "The database identity query returned no row.");

        var databaseName = reader.GetString(0);
        Assert.True(
            string.Equals(databaseName, "McpSqlDemo", StringComparison.OrdinalIgnoreCase),
            $"MCP_SQL_CONNECTION must target the McpSqlDemo database, but it targets '{databaseName}'.");
        Assert.True(
            reader.GetInt32(1) == 1,
            $"Database user '{ReaderUser}' does not exist in the McpSqlDemo database.");
    }

    private static async Task<ShipmentsPermissions> ReadShipmentsPermissionsAsync(SqlConnection connection)
    {
        const string sql = """
            SELECT
                HAS_PERMS_BY_NAME(N'dbo.Shipments', N'OBJECT', N'SELECT'),
                HAS_PERMS_BY_NAME(N'dbo.Shipments', N'OBJECT', N'INSERT'),
                HAS_PERMS_BY_NAME(N'dbo.Shipments', N'OBJECT', N'UPDATE'),
                HAS_PERMS_BY_NAME(N'dbo.Shipments', N'OBJECT', N'DELETE'),
                HAS_PERMS_BY_NAME(N'dbo.Shipments', N'OBJECT', N'ALTER');
            """;

        await using var command = new SqlCommand(sql, connection);
        await using var reader = await command.ExecuteReaderAsync();
        Assert.True(await reader.ReadAsync(), "The permissions query returned no row.");

        return new ShipmentsPermissions(
            reader.GetInt32(0),
            reader.GetInt32(1),
            reader.GetInt32(2),
            reader.GetInt32(3),
            reader.GetInt32(4));
    }

    private sealed record ShipmentsPermissions(
        int Select,
        int Insert,
        int Update,
        int Delete,
        int Alter);
}
