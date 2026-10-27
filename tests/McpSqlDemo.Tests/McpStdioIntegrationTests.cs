using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using Xunit;

[Trait("Category", "Integration")]
public sealed class McpStdioIntegrationTests
{
    private static readonly TimeSpan TestTimeout = TimeSpan.FromSeconds(30);

    [McpStdioFact]
    public async Task ListShipments_ThroughStdio_ReturnsValidShipmentData()
    {
        var connectionString = Environment.GetEnvironmentVariable("MCP_SQL_CONNECTION")!;
        var serverAssemblyPath = typeof(ShipmentTools).Assembly.Location;
        var diagnostics = new SanitizedServerDiagnostics();
        var environment = StdioClientTransportOptions.GetDefaultEnvironmentVariables();
        environment["MCP_SQL_CONNECTION"] = connectionString;

        var transport = new StdioClientTransport(
            new StdioClientTransportOptions
            {
                Name = "mcp-sql-demo-integration-test",
                Command = "dotnet",
                Arguments = [serverAssemblyPath],
                WorkingDirectory = Path.GetDirectoryName(serverAssemblyPath),
                InheritEnvironmentVariables = false,
                EnvironmentVariables = environment,
                ShutdownTimeout = TimeSpan.FromSeconds(5),
                StandardErrorLines = diagnostics.Observe
            },
            NullLoggerFactory.Instance);

        McpClient? client = null;
        string? failure = null;
        var stage = "client initialization";

        using var timeout = new CancellationTokenSource(TestTimeout);
        try
        {
            client = await McpClient.CreateAsync(
                transport,
                loggerFactory: NullLoggerFactory.Instance,
                cancellationToken: timeout.Token);

            stage = "list_shipments invocation";
            var result = await client.CallToolAsync(
                "list_shipments",
                arguments: null,
                progress: null,
                options: null,
                cancellationToken: timeout.Token);

            failure = ValidateResult(result);
        }
        catch (OperationCanceledException) when (timeout.IsCancellationRequested)
        {
            failure = $"MCP stdio integration test timed out during {stage}.";
        }
        catch (Exception exception)
        {
            failure = $"MCP stdio integration test failed during {stage} " +
                $"with exception type {exception.GetType().Name}.";
        }
        finally
        {
            try
            {
                if (client is not null)
                    await client.DisposeAsync();
            }
            catch (Exception exception)
            {
                failure ??= "MCP stdio integration test failed while terminating the child process " +
                    $"with exception type {exception.GetType().Name}.";
            }
        }

        Assert.True(failure is null, $"{failure} Sanitized server diagnostics: {diagnostics.Summary}.");
    }

    private static string? ValidateResult(CallToolResult result)
    {
        if (result.IsError == true)
            return "The list_shipments MCP tool returned an error result.";

        var textBlocks = result.Content.OfType<TextContentBlock>().ToArray();
        if (textBlocks.Length != 1)
            return "The list_shipments MCP tool did not return exactly one text payload.";

        Shipment[]? shipments;
        try
        {
            shipments = JsonSerializer.Deserialize<Shipment[]>(
                textBlocks[0].Text,
                new JsonSerializerOptions(JsonSerializerDefaults.Web));
        }
        catch (JsonException)
        {
            return "The list_shipments MCP tool returned a payload that was not valid shipment JSON.";
        }

        if (shipments is null || shipments.Length == 0 || shipments.Length > 20)
            return "The list_shipments MCP tool returned an invalid shipment count.";
        if (!shipments.SequenceEqual(shipments.OrderBy(shipment => shipment.Id)))
            return "The list_shipments MCP tool returned shipments out of ID order.";
        if (shipments.Any(shipment =>
                shipment.Id <= 0 ||
                string.IsNullOrWhiteSpace(shipment.Reference) ||
                string.IsNullOrWhiteSpace(shipment.Status) ||
                shipment.Quantity < 0))
        {
            return "The list_shipments MCP tool returned invalid shipment fields.";
        }

        return null;
    }

    private sealed class SanitizedServerDiagnostics
    {
        private readonly ConcurrentDictionary<string, int> _events = new(StringComparer.Ordinal);
        private int _otherLineCount;

        public string Summary
        {
            get
            {
                var events = _events
                    .OrderBy(entry => entry.Key, StringComparer.Ordinal)
                    .Select(entry => $"{entry.Key}={entry.Value}")
                    .ToList();
                events.Add($"other-stderr-lines={Volatile.Read(ref _otherLineCount)}");
                return string.Join(", ", events);
            }
        }

        public void Observe(string line)
        {
            var eventName = line switch
            {
                _ when line.Contains("Tool call started", StringComparison.Ordinal) => "tool-started",
                _ when line.Contains("Tool call completed", StringComparison.Ordinal) => "tool-completed",
                _ when line.Contains("DatabaseFailure", StringComparison.Ordinal) => "database-failure",
                _ when line.Contains("DeadlineExceeded", StringComparison.Ordinal) => "deadline-exceeded",
                _ when line.Contains("UnexpectedFailure", StringComparison.Ordinal) => "unexpected-failure",
                _ => null
            };

            if (eventName is null)
                Interlocked.Increment(ref _otherLineCount);
            else
                _events.AddOrUpdate(eventName, 1, static (_, count) => count + 1);
        }
    }
}
