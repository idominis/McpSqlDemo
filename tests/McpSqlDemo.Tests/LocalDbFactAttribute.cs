using Xunit;

[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
internal sealed class LocalDbFactAttribute : FactAttribute
{
    internal const string SkipReason =
        "MCP_SQL_CONNECTION is not set; the read-only SQL Server integration test was not run.";

    public LocalDbFactAttribute()
    {
        if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("MCP_SQL_CONNECTION")))
        {
            Skip = SkipReason;
        }
    }
}
