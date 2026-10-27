using Xunit;

[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
internal sealed class McpStdioFactAttribute : FactAttribute
{
    internal const string OptInVariable = "MCP_SQL_RUN_STDIO_INTEGRATION";

    public McpStdioFactAttribute()
    {
        if (!string.Equals(
                Environment.GetEnvironmentVariable(OptInVariable),
                "1",
                StringComparison.Ordinal))
        {
            Skip = $"Set {OptInVariable}=1 to run the MCP stdio integration test.";
        }
        else if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("MCP_SQL_CONNECTION")))
        {
            Skip = "MCP_SQL_CONNECTION is not set; the MCP stdio integration test was not run.";
        }
    }
}
