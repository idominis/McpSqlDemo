using Microsoft.Data.SqlClient;
using Xunit;
using Xunit.Abstractions;

[Trait("Category", "Integration")]
public sealed class EffectiveSqlIdentityIntegrationTests
{
    private readonly ITestOutputHelper _output;

    public EffectiveSqlIdentityIntegrationTests(ITestOutputHelper output)
    {
        _output = output;
    }

    [LocalDbFact]
    public async Task ConfiguredConnection_ReportsEffectiveSqlIdentityAndPermissions()
    {
        EffectiveSqlIdentity identity;
        try
        {
            identity = await ReadEffectiveIdentityAsync();
        }
        catch (SqlException exception)
        {
            Assert.Fail(
                "Could not inspect the effective SQL identity for the configured MCP_SQL_CONNECTION. " +
                $"SQL error number {exception.Number}, state {exception.State}, class {exception.Class}. " +
                "Verify SQL Server availability, TLS configuration, credentials, database access, and dbo.Shipments. " +
                "Connection details were intentionally omitted.");
            return;
        }
        catch (ArgumentException)
        {
            Assert.Fail(
                "Could not inspect the effective SQL identity because MCP_SQL_CONNECTION is malformed. " +
                "Connection details were intentionally omitted.");
            return;
        }
        catch (InvalidOperationException exception)
        {
            Assert.Fail(
                "Could not inspect the effective SQL identity because the SQL connection could not be used. " +
                $"Failure type: {exception.GetType().Name}. Connection details were intentionally omitted.");
            return;
        }

        _output.WriteLine("Effective SQL identity used by MCP_SQL_CONNECTION (no impersonation):");
        _output.WriteLine($"  Database: {identity.DatabaseName}");
        _output.WriteLine($"  Original login: {identity.OriginalLogin}");
        _output.WriteLine($"  Current server login: {identity.ServerLogin}");
        _output.WriteLine($"  Database principal: {identity.DatabasePrincipal}");
        _output.WriteLine("Effective permissions on dbo.Shipments:");
        _output.WriteLine($"  SELECT: {FormatPermission(identity.Select)}");
        _output.WriteLine($"  INSERT: {FormatPermission(identity.Insert)}");
        _output.WriteLine($"  UPDATE: {FormatPermission(identity.Update)}");
        _output.WriteLine($"  DELETE: {FormatPermission(identity.Delete)}");
        _output.WriteLine($"  ALTER: {FormatPermission(identity.Alter)}");

        Assert.True(
            string.Equals(identity.DatabaseName, "McpSqlDemo", StringComparison.OrdinalIgnoreCase),
            $"MCP_SQL_CONNECTION must target the McpSqlDemo database, but it targets '{identity.DatabaseName}'.");
    }

    private static async Task<EffectiveSqlIdentity> ReadEffectiveIdentityAsync()
    {
        var configuredConnectionString = Environment.GetEnvironmentVariable("MCP_SQL_CONNECTION")!;
        var settings = SecuritySettings.FromEnvironment();
        var connectionStringBuilder = new SqlConnectionStringBuilder(configuredConnectionString)
        {
            ConnectTimeout = settings.ConnectionTimeoutSeconds
        };

        await using var connection = new SqlConnection(connectionStringBuilder.ConnectionString);
        await connection.OpenAsync();

        const string sql = """
            SELECT
                DB_NAME(),
                ORIGINAL_LOGIN(),
                SUSER_SNAME(),
                USER_NAME(),
                HAS_PERMS_BY_NAME(N'dbo.Shipments', N'OBJECT', N'SELECT'),
                HAS_PERMS_BY_NAME(N'dbo.Shipments', N'OBJECT', N'INSERT'),
                HAS_PERMS_BY_NAME(N'dbo.Shipments', N'OBJECT', N'UPDATE'),
                HAS_PERMS_BY_NAME(N'dbo.Shipments', N'OBJECT', N'DELETE'),
                HAS_PERMS_BY_NAME(N'dbo.Shipments', N'OBJECT', N'ALTER');
            """;

        await using var command = new SqlCommand(sql, connection)
        {
            CommandTimeout = settings.CommandTimeoutSeconds
        };
        await using var reader = await command.ExecuteReaderAsync();

        if (!await reader.ReadAsync())
            throw new InvalidOperationException("The SQL identity query returned no row.");

        return new EffectiveSqlIdentity(
            reader.GetString(0),
            reader.GetString(1),
            reader.GetString(2),
            reader.GetString(3),
            ReadPermission(reader, 4),
            ReadPermission(reader, 5),
            ReadPermission(reader, 6),
            ReadPermission(reader, 7),
            ReadPermission(reader, 8));
    }

    private static int? ReadPermission(SqlDataReader reader, int ordinal) =>
        reader.IsDBNull(ordinal) ? null : reader.GetInt32(ordinal);

    private static string FormatPermission(int? value) => value switch
    {
        1 => "Granted",
        0 => "Denied",
        _ => "Unknown"
    };

    private sealed record EffectiveSqlIdentity(
        string DatabaseName,
        string OriginalLogin,
        string ServerLogin,
        string DatabasePrincipal,
        int? Select,
        int? Insert,
        int? Update,
        int? Delete,
        int? Alter);
}
