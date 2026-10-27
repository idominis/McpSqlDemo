using Microsoft.Data.SqlClient;
using Xunit;

[Trait("Category", "Integration")]
[Trait("Category", "Security")]
public sealed class LeastPrivilegeSqlAuthenticationIntegrationTests
{
    private const string ExpectedPrincipal = "mcp_app_reader";

    [LeastPrivilegeSqlFact]
    public async Task ActualMcpConnection_IsDedicatedReadOnlySqlIdentity()
    {
        var configuredConnectionString = Environment.GetEnvironmentVariable("MCP_SQL_CONNECTION")!;
        SqlConnectionStringBuilder connectionStringBuilder;

        try
        {
            connectionStringBuilder = new SqlConnectionStringBuilder(configuredConnectionString);
        }
        catch (ArgumentException)
        {
            Assert.Fail(
                "MCP_SQL_CONNECTION is malformed. Connection details were intentionally omitted.");
            return;
        }

        Assert.False(
            connectionStringBuilder.IntegratedSecurity,
            "The opted-in test requires the actual SQL-authenticated mcp_app_reader connection, not Windows Integrated Security.");
        Assert.True(
            connectionStringBuilder.Authentication is SqlAuthenticationMethod.NotSpecified or SqlAuthenticationMethod.SqlPassword,
            "The opted-in test requires SQL password authentication, not Windows, Microsoft Entra, or another authentication mode.");
        Assert.True(
            string.Equals(connectionStringBuilder.UserID, ExpectedPrincipal, StringComparison.OrdinalIgnoreCase),
            $"The opted-in connection must specify User ID={ExpectedPrincipal}. Connection details were intentionally omitted.");

        var settings = SecuritySettings.FromEnvironment();
        connectionStringBuilder.ConnectTimeout = settings.ConnectionTimeoutSeconds;

        EffectiveSecurityContext context;
        try
        {
            await using var connection = new SqlConnection(connectionStringBuilder.ConnectionString);
            await connection.OpenAsync();
            context = await ReadSecurityContextAsync(connection, settings.CommandTimeoutSeconds);
        }
        catch (SqlException exception)
        {
            Assert.Fail(
                "Could not verify the least-privilege MCP SQL connection. " +
                $"SQL error number {exception.Number}, state {exception.State}, class {exception.Class}. " +
                "Verify the reviewed login/user setup, TLS settings, secret injection, and dbo.Shipments. " +
                "Connection details and the server message were intentionally omitted.");
            return;
        }
        catch (InvalidOperationException exception)
        {
            Assert.Fail(
                "Could not verify the least-privilege MCP SQL connection. " +
                $"Failure type: {exception.GetType().Name}. Connection details were intentionally omitted.");
            return;
        }

        Assert.True(
            string.Equals(context.DatabaseName, "McpSqlDemo", StringComparison.OrdinalIgnoreCase),
            "MCP_SQL_CONNECTION must target the McpSqlDemo database.");
        AssertPrincipal(ExpectedPrincipal, context.OriginalLogin, "original login");
        AssertPrincipal(ExpectedPrincipal, context.ServerLogin, "current server login");
        AssertPrincipal(ExpectedPrincipal, context.DatabasePrincipal, "database principal");

        Assert.Equal(0, context.IsSysAdmin);
        Assert.Equal(0, context.IsDbOwner);
        Assert.Equal(0, context.IsDbDataReader);
        Assert.Equal(1, context.Select);
        Assert.Equal(0, context.Insert);
        Assert.Equal(0, context.Update);
        Assert.Equal(0, context.Delete);
        Assert.Equal(0, context.Alter);
    }

    private static void AssertPrincipal(string expected, string actual, string description) =>
        Assert.True(
            string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase),
            $"Expected the effective {description} to be {expected}, but it was '{actual}'. " +
            "The test refuses privileged, dbo, and impersonated connections.");

    private static async Task<EffectiveSecurityContext> ReadSecurityContextAsync(
        SqlConnection connection,
        int commandTimeoutSeconds)
    {
        const string sql = """
            SELECT
                DB_NAME(),
                ORIGINAL_LOGIN(),
                SUSER_SNAME(),
                USER_NAME(),
                IS_SRVROLEMEMBER(N'sysadmin'),
                IS_MEMBER(N'db_owner'),
                IS_MEMBER(N'db_datareader'),
                HAS_PERMS_BY_NAME(N'dbo.Shipments', N'OBJECT', N'SELECT'),
                HAS_PERMS_BY_NAME(N'dbo.Shipments', N'OBJECT', N'INSERT'),
                HAS_PERMS_BY_NAME(N'dbo.Shipments', N'OBJECT', N'UPDATE'),
                HAS_PERMS_BY_NAME(N'dbo.Shipments', N'OBJECT', N'DELETE'),
                HAS_PERMS_BY_NAME(N'dbo.Shipments', N'OBJECT', N'ALTER');
            """;

        await using var command = new SqlCommand(sql, connection)
        {
            CommandTimeout = commandTimeoutSeconds
        };
        await using var reader = await command.ExecuteReaderAsync();

        if (!await reader.ReadAsync())
            throw new InvalidOperationException("The SQL security-context query returned no row.");

        return new EffectiveSecurityContext(
            reader.GetString(0),
            reader.GetString(1),
            reader.GetString(2),
            reader.GetString(3),
            ReadRequiredPermission(reader, 4),
            ReadRequiredPermission(reader, 5),
            ReadRequiredPermission(reader, 6),
            ReadRequiredPermission(reader, 7),
            ReadRequiredPermission(reader, 8),
            ReadRequiredPermission(reader, 9),
            ReadRequiredPermission(reader, 10),
            ReadRequiredPermission(reader, 11));
    }

    private static int ReadRequiredPermission(SqlDataReader reader, int ordinal)
    {
        if (reader.IsDBNull(ordinal))
            throw new InvalidOperationException("SQL Server returned an unknown security result.");

        return reader.GetInt32(ordinal);
    }

    private sealed record EffectiveSecurityContext(
        string DatabaseName,
        string OriginalLogin,
        string ServerLogin,
        string DatabasePrincipal,
        int IsSysAdmin,
        int IsDbOwner,
        int IsDbDataReader,
        int Select,
        int Insert,
        int Update,
        int Delete,
        int Alter);
}

