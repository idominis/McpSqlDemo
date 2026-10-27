using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using ModelContextProtocol;
using Xunit;

public sealed class ShipmentRepositoryValidationTests
{
    [Theory]
    [InlineData(-1)]
    [InlineData(0)]
    [InlineData(1_000_001)]
    public async Task GetByIdAsync_WithInvalidId_RejectsBeforeOpeningConnection(int shipmentId)
    {
        var repository = CreateRepository();

        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() =>
            repository.GetByIdAsync(shipmentId, CancellationToken.None));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("InTransit")]
    [InlineData("Pending' OR 1=1--")]
    [InlineData("Completed'; DROP TABLE dbo.Shipments;--")]
    public async Task GetByStatusAsync_WithInvalidStatus_RejectsBeforeOpeningConnection(string? status)
    {
        var repository = CreateRepository();

        await Assert.ThrowsAsync<ArgumentException>(() =>
            repository.GetByStatusAsync(status!, CancellationToken.None));
    }

    [Fact]
    public async Task GetByStatusAsync_WithOversizedStatus_RejectsBeforeOpeningConnection()
    {
        var repository = CreateRepository();

        await Assert.ThrowsAsync<ArgumentException>(() =>
            repository.GetByStatusAsync(new string('x', 51), CancellationToken.None));
    }

    [Fact]
    public async Task ListShipments_WithMalformedConnectionString_ReturnsSanitizedErrorWithoutLoggingDetails()
    {
        const string sensitiveInput =
            "Server=private-host;Password=do-not-leak;Invalid Sensitive Keyword=sensitive-config-value";
        var parseException = Assert.Throws<ArgumentException>(
            () => new SqlConnectionStringBuilder(sensitiveInput));
        var messages = new List<string>();
        using var loggerFactory = Microsoft.Extensions.Logging.LoggerFactory.Create(
            builder => builder.AddProvider(new RecordingLoggerProvider(messages)));
        var repository = new ShipmentRepository(
            loggerFactory.CreateLogger<ShipmentRepository>(),
            new SecuritySettings(5, 10, TimeSpan.FromSeconds(15), 4),
            sensitiveInput);
        using var executionPolicy = new ShipmentToolExecutionPolicy(
            new SecuritySettings(5, 10, TimeSpan.FromSeconds(15), 4));

        var exception = await Assert.ThrowsAsync<McpException>(() =>
            ShipmentTools.ListShipments(
                repository, executionPolicy, loggerFactory, CancellationToken.None));

        Assert.Equal("The shipment operation failed. Please try again later.", exception.Message);
        Assert.DoesNotContain(sensitiveInput, exception.Message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(parseException.Message, exception.Message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(messages, message =>
            message.Contains(sensitiveInput, StringComparison.OrdinalIgnoreCase) ||
            message.Contains(parseException.Message, StringComparison.OrdinalIgnoreCase) ||
            message.Contains("private-host", StringComparison.OrdinalIgnoreCase) ||
            message.Contains("do-not-leak", StringComparison.OrdinalIgnoreCase));
        Assert.Contains(messages, message =>
            message.Contains("UnexpectedFailure", StringComparison.Ordinal));
    }

    private static ShipmentRepository CreateRepository() =>
        new(
            NullLogger<ShipmentRepository>.Instance,
            new SecuritySettings(5, 10, TimeSpan.FromSeconds(15), 4));

    private sealed class RecordingLoggerProvider(List<string> messages) : ILoggerProvider
    {
        public ILogger CreateLogger(string categoryName) => new RecordingLogger(messages);

        public void Dispose()
        {
        }

        private sealed class RecordingLogger(List<string> messages) : ILogger
        {
            public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

            public bool IsEnabled(LogLevel logLevel) => true;

            public void Log<TState>(
                LogLevel logLevel,
                EventId eventId,
                TState state,
                Exception? exception,
                Func<TState, Exception?, string> formatter)
            {
                lock (messages)
                    messages.Add(formatter(state, exception));
            }
        }
    }
}
