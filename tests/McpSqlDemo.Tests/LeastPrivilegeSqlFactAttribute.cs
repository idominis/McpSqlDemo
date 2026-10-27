using Xunit;

[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
internal sealed class LeastPrivilegeSqlFactAttribute : FactAttribute
{
    internal const string OptInVariable = "MCP_SQL_VERIFY_LEAST_PRIVILEGE";

    public LeastPrivilegeSqlFactAttribute()
    {
        if (!string.Equals(
                Environment.GetEnvironmentVariable(OptInVariable),
                "1",
                StringComparison.Ordinal))
        {
            Skip = $"Set {OptInVariable}=1 to verify the actual MCP SQL login.";
        }
        else if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("MCP_SQL_CONNECTION")))
        {
            Skip = "MCP_SQL_CONNECTION is not set; the least-privilege SQL-login test was not run.";
        }
    }
}

