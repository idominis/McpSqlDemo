using System.Globalization;
using Microsoft.Data.SqlClient;

public sealed class SecuritySettings
{
    private const int DefaultConnectionTimeoutSeconds = 5;
    private const int DefaultCommandTimeoutSeconds = 10;
    private const int DefaultToolDeadlineSeconds = 15;
    private const int DefaultMaxConcurrentTools = 4;

    public SecuritySettings(
        int connectionTimeoutSeconds,
        int commandTimeoutSeconds,
        TimeSpan toolExecutionDeadline,
        int maxConcurrentTools)
    {
        if (connectionTimeoutSeconds is < 1 or > 30)
            throw new ArgumentOutOfRangeException(nameof(connectionTimeoutSeconds));
        if (commandTimeoutSeconds is < 1 or > 120)
            throw new ArgumentOutOfRangeException(nameof(commandTimeoutSeconds));
        if (toolExecutionDeadline < TimeSpan.FromMilliseconds(10) ||
            toolExecutionDeadline > TimeSpan.FromSeconds(120))
            throw new ArgumentOutOfRangeException(nameof(toolExecutionDeadline));
        if (maxConcurrentTools is < 1 or > 16)
            throw new ArgumentOutOfRangeException(nameof(maxConcurrentTools));

        ConnectionTimeoutSeconds = connectionTimeoutSeconds;
        CommandTimeoutSeconds = commandTimeoutSeconds;
        ToolExecutionDeadline = toolExecutionDeadline;
        MaxConcurrentTools = maxConcurrentTools;
    }

    public int ConnectionTimeoutSeconds { get; }
    public int CommandTimeoutSeconds { get; }
    public TimeSpan ToolExecutionDeadline { get; }
    public int MaxConcurrentTools { get; }

    public static SecuritySettings FromEnvironment() => new(
        ReadBoundedInteger("MCP_SQL_CONNECTION_TIMEOUT_SECONDS", DefaultConnectionTimeoutSeconds, 1, 30),
        ReadBoundedInteger("MCP_SQL_COMMAND_TIMEOUT_SECONDS", DefaultCommandTimeoutSeconds, 1, 120),
        TimeSpan.FromSeconds(ReadBoundedInteger(
            "MCP_TOOL_EXECUTION_DEADLINE_SECONDS", DefaultToolDeadlineSeconds, 1, 120)),
        ReadBoundedInteger("MCP_TOOL_MAX_CONCURRENCY", DefaultMaxConcurrentTools, 1, 16));

    private static int ReadBoundedInteger(string name, int defaultValue, int minimum, int maximum)
    {
        var value = Environment.GetEnvironmentVariable(name);
        return int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed)
            ? Math.Clamp(parsed, minimum, maximum)
            : defaultValue;
    }
}

public sealed class ShipmentToolExecutionPolicy : IDisposable
{
    private readonly SemaphoreSlim _semaphore;
    private readonly TimeSpan _deadline;

    public ShipmentToolExecutionPolicy(SecuritySettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        _semaphore = new SemaphoreSlim(settings.MaxConcurrentTools, settings.MaxConcurrentTools);
        _deadline = settings.ToolExecutionDeadline;
    }

    public async Task<T> ExecuteAsync<T>(
        Func<CancellationToken, Task<T>> operation,
        CancellationToken callerCancellationToken)
    {
        ArgumentNullException.ThrowIfNull(operation);

        using var deadlineCancellation = CancellationTokenSource.CreateLinkedTokenSource(callerCancellationToken);
        deadlineCancellation.CancelAfter(_deadline);

        var permitAcquired = false;
        try
        {
            await _semaphore.WaitAsync(deadlineCancellation.Token).ConfigureAwait(false);
            permitAcquired = true;

            var result = await operation(deadlineCancellation.Token).ConfigureAwait(false);
            deadlineCancellation.Token.ThrowIfCancellationRequested();
            return result;
        }
        catch (OperationCanceledException) when (callerCancellationToken.IsCancellationRequested)
        {
            throw new OperationCanceledException(callerCancellationToken);
        }
        catch (OperationCanceledException) when (deadlineCancellation.IsCancellationRequested)
        {
            throw new ShipmentToolDeadlineExceededException();
        }
        catch (SqlException exception) when (callerCancellationToken.IsCancellationRequested)
        {
            throw new OperationCanceledException("The operation was canceled.", exception, callerCancellationToken);
        }
        catch (SqlException exception) when (deadlineCancellation.IsCancellationRequested)
        {
            throw new ShipmentToolDeadlineExceededException(exception);
        }
        catch (SqlException exception)
        {
            throw ShipmentDatabaseException.FromSqlException(exception);
        }
        finally
        {
            if (permitAcquired)
                _semaphore.Release();
        }
    }

    public void Dispose() => _semaphore.Dispose();
}

internal sealed class ShipmentDatabaseException : Exception
{
    internal const int CommandTimeoutSqlNumber = -2;

    private ShipmentDatabaseException(
        int number,
        byte state = 0,
        byte errorClass = 0,
        Exception? innerException = null)
        : base("The shipment database operation failed.", innerException)
    {
        Number = number;
        State = state;
        Class = errorClass;
    }

    public int Number { get; }
    public byte State { get; }
    public byte Class { get; }
    public bool IsCommandTimeout => Number == CommandTimeoutSqlNumber;

    internal static ShipmentDatabaseException FromSqlDiagnostics(
        int number,
        byte state = 0,
        byte errorClass = 0,
        Exception? innerException = null) =>
        new(number, state, errorClass, innerException);

    internal static ShipmentDatabaseException FromSqlException(SqlException exception) =>
        FromSqlDiagnostics(exception.Number, exception.State, exception.Class, exception);
}

internal sealed class ShipmentToolDeadlineExceededException : Exception
{
    public ShipmentToolDeadlineExceededException()
    {
    }

    public ShipmentToolDeadlineExceededException(Exception innerException)
        : base("The shipment tool execution deadline was exceeded.", innerException)
    {
    }
}
