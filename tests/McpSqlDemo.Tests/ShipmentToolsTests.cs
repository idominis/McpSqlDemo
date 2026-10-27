using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Logging;
using ModelContextProtocol;
using Xunit;

public sealed class ShipmentToolsTests
{
    private static readonly NullLoggerFactory LoggerFactory = NullLoggerFactory.Instance;

    [Theory]
    [InlineData(1)]
    [InlineData(1_000_000)]
    public async Task GetShipmentById_WithValidId_ReturnsShipmentAndForwardsToken(int shipmentId)
    {
        var expected = new Shipment(shipmentId, $"SHP-{shipmentId}", "Pending", 10.5m);
        var repository = new FakeShipmentRepository { ShipmentById = expected };
        using var executionPolicy = CreateExecutionPolicy();
        using var cancellation = new CancellationTokenSource();

        var actual = await ShipmentTools.GetShipmentById(
            repository, executionPolicy, LoggerFactory, shipmentId, cancellation.Token);

        Assert.Equal(expected, actual);
        Assert.Equal(1, repository.GetByIdCallCount);
        Assert.Equal(shipmentId, repository.RequestedId);
        Assert.True(repository.ReceivedCancellationToken.CanBeCanceled);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(0)]
    [InlineData(1_000_001)]
    public async Task GetShipmentById_WithInvalidId_ThrowsWithoutCallingRepository(int shipmentId)
    {
        var repository = new FakeShipmentRepository();
        using var executionPolicy = CreateExecutionPolicy();

        var exception = await Assert.ThrowsAsync<McpException>(() =>
            ShipmentTools.GetShipmentById(
                repository, executionPolicy, LoggerFactory, shipmentId, CancellationToken.None));

        Assert.Equal("shipmentId must be between 1 and 1,000,000.", exception.Message);
        Assert.Equal(0, repository.GetByIdCallCount);
    }

    [Fact]
    public async Task GetShipmentById_WhenShipmentIsMissing_ThrowsSafeNotFoundError()
    {
        var repository = new FakeShipmentRepository();
        using var executionPolicy = CreateExecutionPolicy();

        var exception = await Assert.ThrowsAsync<McpException>(() =>
            ShipmentTools.GetShipmentById(repository, executionPolicy, LoggerFactory, 42, CancellationToken.None));

        Assert.Equal("Shipment with ID 42 was not found.", exception.Message);
        Assert.Equal(1, repository.GetByIdCallCount);
    }

    [Theory]
    [InlineData("Pending", "Pending")]
    [InlineData("pending", "Pending")]
    [InlineData("  loading  ", "Loading")]
    [InlineData(" COMPLETED\t", "Completed")]
    public async Task GetShipmentsByStatus_WithValidStatus_NormalizesAndReturnsResults(
        string status, string expectedCanonicalStatus)
    {
        Shipment[] expected = [new(7, "SHP-007", expectedCanonicalStatus, 15m)];
        var repository = new FakeShipmentRepository { ShipmentsByStatus = expected };
        using var executionPolicy = CreateExecutionPolicy();
        using var cancellation = new CancellationTokenSource();

        var actual = await ShipmentTools.GetShipmentsByStatus(
            repository, executionPolicy, LoggerFactory, status, cancellation.Token);

        Assert.Same(expected, actual);
        Assert.Equal(1, repository.GetByStatusCallCount);
        Assert.Equal(expectedCanonicalStatus, repository.RequestedStatus);
        Assert.True(repository.ReceivedCancellationToken.CanBeCanceled);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("InTransit")]
    public async Task GetShipmentsByStatus_WithInvalidStatus_ThrowsWithoutCallingRepository(string? status)
    {
        var repository = new FakeShipmentRepository();
        using var executionPolicy = CreateExecutionPolicy();

        var exception = await Assert.ThrowsAsync<McpException>(() =>
            ShipmentTools.GetShipmentsByStatus(
                repository, executionPolicy, LoggerFactory, status!, CancellationToken.None));

        Assert.Equal("status must be one of: Pending, Loading, Completed.", exception.Message);
        Assert.Equal(0, repository.GetByStatusCallCount);
    }

    [Fact]
    public async Task ListShipments_ReturnsRepositoryResultsAndForwardsToken()
    {
        Shipment[] expected =
        [
            new(1, "SHP-001", "Pending", 12m),
            new(2, "SHP-002", "Completed", 25m)
        ];
        var repository = new FakeShipmentRepository { Shipments = expected };
        using var executionPolicy = CreateExecutionPolicy();
        using var cancellation = new CancellationTokenSource();

        var actual = await ShipmentTools.ListShipments(
            repository, executionPolicy, LoggerFactory, cancellation.Token);

        Assert.Same(expected, actual);
        Assert.Equal(1, repository.ListCallCount);
        Assert.True(repository.ReceivedCancellationToken.CanBeCanceled);
    }

    [Fact]
    public async Task GetShipmentsByStatus_WithOversizedInput_RejectsBeforeCallingRepository()
    {
        var repository = new FakeShipmentRepository();
        using var executionPolicy = CreateExecutionPolicy();
        var oversizedStatus = new string('x', 51);

        var exception = await Assert.ThrowsAsync<McpException>(() =>
            ShipmentTools.GetShipmentsByStatus(
                repository, executionPolicy, LoggerFactory, oversizedStatus, CancellationToken.None));

        Assert.Equal("status must be one of: Pending, Loading, Completed.", exception.Message);
        Assert.Equal(0, repository.GetByStatusCallCount);
    }

    [Fact]
    public async Task GetShipmentsByStatus_WithControlCharacters_DoesNotLogRawInput()
    {
        const string untrustedStatus = "Pending\r\nforged-log-entry";
        var repository = new FakeShipmentRepository();
        using var executionPolicy = CreateExecutionPolicy();
        var messages = new List<string>();
        using var loggerFactory = Microsoft.Extensions.Logging.LoggerFactory.Create(
            builder => builder.AddProvider(new RecordingLoggerProvider(messages)));

        await Assert.ThrowsAsync<McpException>(() =>
            ShipmentTools.GetShipmentsByStatus(
                repository, executionPolicy, loggerFactory, untrustedStatus, CancellationToken.None));

        Assert.Equal(0, repository.GetByStatusCallCount);
        Assert.DoesNotContain(messages, message => message.Contains(untrustedStatus, StringComparison.Ordinal));
        Assert.Contains(messages, message => message.Contains("InvalidInput", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ListShipments_WhenRepositoryThrowsUnexpectedException_ReturnsSafeError()
    {
        const string internalDetail = "sensitive-internal-detail";
        var repository = new FakeShipmentRepository
        {
            ListHandler = _ => throw new InvalidOperationException(internalDetail)
        };
        using var executionPolicy = CreateExecutionPolicy();

        var exception = await Assert.ThrowsAsync<McpException>(() =>
            ShipmentTools.ListShipments(repository, executionPolicy, LoggerFactory, CancellationToken.None));

        Assert.Equal("The shipment operation failed. Please try again later.", exception.Message);
        Assert.DoesNotContain(internalDetail, exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ListShipments_WhenDeadlineExpires_ReturnsSafeTimeoutError()
    {
        var repository = new FakeShipmentRepository
        {
            ListHandler = async ct =>
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, ct);
                return [];
            }
        };
        using var executionPolicy = CreateExecutionPolicy(deadline: TimeSpan.FromMilliseconds(50));

        var exception = await Assert.ThrowsAsync<McpException>(() =>
            ShipmentTools.ListShipments(repository, executionPolicy, LoggerFactory, CancellationToken.None));

        Assert.Equal("The shipment operation timed out. Please try again later.", exception.Message);
    }

    [Fact]
    public async Task ListShipments_WhenCallerCancels_PreservesCallerCancellation()
    {
        var repository = new FakeShipmentRepository
        {
            ListHandler = async ct =>
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, ct);
                return [];
            }
        };
        using var executionPolicy = CreateExecutionPolicy(deadline: TimeSpan.FromSeconds(5));
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));

        var exception = await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            ShipmentTools.ListShipments(repository, executionPolicy, LoggerFactory, cancellation.Token));

        Assert.Equal(cancellation.Token, exception.CancellationToken);
    }

    [Fact]
    public async Task ConcurrencyLimit_AllowsOnlyOneRepositoryExecutionAtATime()
    {
        var firstCallEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFirstCall = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var invocation = 0;
        var activeCalls = 0;
        var maximumActiveCalls = 0;
        var repository = new FakeShipmentRepository
        {
            ListHandler = async ct =>
            {
                var currentInvocation = Interlocked.Increment(ref invocation);
                var active = Interlocked.Increment(ref activeCalls);
                UpdateMaximum(ref maximumActiveCalls, active);
                try
                {
                    if (currentInvocation == 1)
                    {
                        firstCallEntered.SetResult();
                        await releaseFirstCall.Task.WaitAsync(ct);
                    }

                    return [];
                }
                finally
                {
                    Interlocked.Decrement(ref activeCalls);
                }
            }
        };
        using var executionPolicy = CreateExecutionPolicy(deadline: TimeSpan.FromSeconds(5), maxConcurrency: 1);

        var firstCall = ShipmentTools.ListShipments(
            repository, executionPolicy, LoggerFactory, CancellationToken.None);
        await firstCallEntered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        var secondCall = ShipmentTools.ListShipments(
            repository, executionPolicy, LoggerFactory, CancellationToken.None);

        await Task.Delay(100);
        Assert.Equal(1, Volatile.Read(ref invocation));

        releaseFirstCall.SetResult();
        await Task.WhenAll(firstCall, secondCall);

        Assert.Equal(2, invocation);
        Assert.Equal(1, maximumActiveCalls);
    }

    [Fact]
    public async Task ExecutionPolicy_ReleasesPermitAfterExceptionAndCancellation()
    {
        using var executionPolicy = CreateExecutionPolicy(deadline: TimeSpan.FromSeconds(5), maxConcurrency: 1);

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            executionPolicy.ExecuteAsync<int>(
                _ => throw new InvalidOperationException("expected test failure"), CancellationToken.None));

        var afterException = await executionPolicy.ExecuteAsync(
            _ => Task.FromResult(1), CancellationToken.None);
        Assert.Equal(1, afterException);

        using var cancellation = new CancellationTokenSource();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            executionPolicy.ExecuteAsync<int>(ct =>
            {
                cancellation.Cancel();
                return Task.FromCanceled<int>(ct);
            }, cancellation.Token));

        var afterCancellation = await executionPolicy.ExecuteAsync(
            _ => Task.FromResult(2), CancellationToken.None);
        Assert.Equal(2, afterCancellation);
    }

    private static ShipmentToolExecutionPolicy CreateExecutionPolicy(
        TimeSpan? deadline = null,
        int maxConcurrency = 4) =>
        new(new SecuritySettings(5, 10, deadline ?? TimeSpan.FromSeconds(5), maxConcurrency));

    private static void UpdateMaximum(ref int maximum, int candidate)
    {
        int observed;
        do
        {
            observed = Volatile.Read(ref maximum);
            if (candidate <= observed)
                return;
        }
        while (Interlocked.CompareExchange(ref maximum, candidate, observed) != observed);
    }

    private sealed class RecordingLoggerProvider : ILoggerProvider
    {
        private readonly List<string> _messages;

        public RecordingLoggerProvider(List<string> messages)
        {
            _messages = messages;
        }

        public ILogger CreateLogger(string categoryName) => new RecordingLogger(_messages);

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
