using System.ComponentModel;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Logging;
using ModelContextProtocol;
using ModelContextProtocol.Server;

[McpServerToolType]
public static class ShipmentTools
{
    [McpServerTool(Name = "get_shipment_by_id", ReadOnly = true, Destructive = false),
     Description("Read a demo shipment by numeric ID. Read-only access to the local demo database.")]
    public static async Task<Shipment?> GetShipmentById(
        IShipmentRepository repository,
        ShipmentToolExecutionPolicy executionPolicy,
        ILoggerFactory loggerFactory,
        [Description("The demo shipment ID, between 1 and 1000000")] int shipmentId,
        CancellationToken cancellationToken)
    {
        var logger = loggerFactory.CreateLogger("ShipmentTools");
        logger.LogInformation("Tool call started for {ToolName} with shipment ID {ShipmentId}",
            nameof(GetShipmentById), shipmentId);

        if (shipmentId is < 1 or > 1_000_000)
        {
            logger.LogWarning("Tool call failed for {ToolName} with failure type {FailureType}",
                nameof(GetShipmentById), "InvalidInput");
            throw new McpException("shipmentId must be between 1 and 1,000,000.");
        }

        Shipment? shipment;
        try
        {
            shipment = await executionPolicy.ExecuteAsync(
                ct => repository.GetByIdAsync(shipmentId, ct), cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            logger.LogInformation("Tool call canceled for {ToolName}", nameof(GetShipmentById));
            throw;
        }
        catch (ShipmentToolDeadlineExceededException)
        {
            logger.LogWarning("Tool call failed for {ToolName} with failure type {FailureType}",
                nameof(GetShipmentById), "DeadlineExceeded");
            throw new McpException("The shipment operation timed out. Please try again later.");
        }
        catch (SqlException exception)
        {
            LogDatabaseFailure(logger, nameof(GetShipmentById), exception);
            throw new McpException("The shipment database operation failed. Please try again later.");
        }
        catch (Exception exception)
        {
            LogUnexpectedFailure(logger, nameof(GetShipmentById), exception);
            throw new McpException("The shipment operation failed. Please try again later.");
        }

        logger.LogInformation("Tool call completed for {ToolName}; shipment found: {ShipmentFound}",
            nameof(GetShipmentById), shipment is not null);

        if (shipment is null)
        {
            logger.LogWarning("Tool call failed for {ToolName} with failure type {FailureType} and shipment ID {ShipmentId}",
                nameof(GetShipmentById), "NotFound", shipmentId);
            throw new McpException($"Shipment with ID {shipmentId} was not found.");
        }

        return shipment;
    }

    [McpServerTool(Name = "list_shipments", ReadOnly = true, Destructive = false),
     Description("List up to 20 shipments in the local demo SQL Server database.")]
    public static async Task<IReadOnlyList<Shipment>> ListShipments(
        IShipmentRepository repository,
        ShipmentToolExecutionPolicy executionPolicy,
        ILoggerFactory loggerFactory,
        CancellationToken cancellationToken)
    {
        var logger = loggerFactory.CreateLogger("ShipmentTools");
        logger.LogInformation("Tool call started for {ToolName}", nameof(ListShipments));

        try
        {
            var shipments = await executionPolicy.ExecuteAsync(repository.ListAsync, cancellationToken);
            logger.LogInformation("Tool call completed for {ToolName} with {ResultCount} results",
                nameof(ListShipments), shipments.Count);
            return shipments;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            logger.LogInformation("Tool call canceled for {ToolName}", nameof(ListShipments));
            throw;
        }
        catch (ShipmentToolDeadlineExceededException)
        {
            logger.LogWarning("Tool call failed for {ToolName} with failure type {FailureType}",
                nameof(ListShipments), "DeadlineExceeded");
            throw new McpException("The shipment operation timed out. Please try again later.");
        }
        catch (SqlException exception)
        {
            LogDatabaseFailure(logger, nameof(ListShipments), exception);
            throw new McpException("The shipment database operation failed. Please try again later.");
        }
        catch (Exception exception)
        {
            LogUnexpectedFailure(logger, nameof(ListShipments), exception);
            throw new McpException("The shipment operation failed. Please try again later.");
        }
    }

    [McpServerTool(Name = "get_shipments_by_status", ReadOnly = true, Destructive = false),
     Description("Find shipments with an exact status match in the local demo SQL Server database. Use this instead of list_shipments when filtering shipments by status.")]
    public static async Task<IReadOnlyList<Shipment>> GetShipmentsByStatus(
        IShipmentRepository repository,
        ShipmentToolExecutionPolicy executionPolicy,
        ILoggerFactory loggerFactory,
        [Description("Required shipment status to match, for example Pending, Loading, or Completed")] string status,
        CancellationToken cancellationToken)
    {
        var logger = loggerFactory.CreateLogger("ShipmentTools");

        string? canonicalStatus = null;
        if (status is not null && status.Length <= 50)
            canonicalStatus = NormalizeStatus(status);

        if (canonicalStatus is null)
        {
            logger.LogWarning("Tool call failed for {ToolName} with failure type {FailureType}",
                nameof(GetShipmentsByStatus), "InvalidInput");
            throw new McpException("status must be one of: Pending, Loading, Completed.");
        }

        logger.LogInformation("Tool call started for {ToolName} with canonical status {ShipmentStatus}",
            nameof(GetShipmentsByStatus), canonicalStatus);

        try
        {
            var shipments = await executionPolicy.ExecuteAsync(
                ct => repository.GetByStatusAsync(canonicalStatus, ct), cancellationToken);
            logger.LogInformation(
                "Tool call completed for {ToolName} with canonical status {ShipmentStatus} and {ResultCount} results",
                nameof(GetShipmentsByStatus), canonicalStatus, shipments.Count);
            return shipments;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            logger.LogInformation("Tool call canceled for {ToolName}", nameof(GetShipmentsByStatus));
            throw;
        }
        catch (ShipmentToolDeadlineExceededException)
        {
            logger.LogWarning("Tool call failed for {ToolName} with failure type {FailureType} and canonical status {ShipmentStatus}",
                nameof(GetShipmentsByStatus), "DeadlineExceeded", canonicalStatus);
            throw new McpException("The shipment operation timed out. Please try again later.");
        }
        catch (SqlException exception)
        {
            LogDatabaseFailure(logger, nameof(GetShipmentsByStatus), exception, canonicalStatus);
            throw new McpException("The shipment database operation failed. Please try again later.");
        }
        catch (Exception exception)
        {
            LogUnexpectedFailure(logger, nameof(GetShipmentsByStatus), exception, canonicalStatus);
            throw new McpException("The shipment operation failed. Please try again later.");
        }
    }

    private static string? NormalizeStatus(string status)
    {
        var value = status.AsSpan();
        var start = 0;
        while (start < value.Length && char.IsWhiteSpace(value[start]))
            start++;

        var end = value.Length - 1;
        while (end >= start && char.IsWhiteSpace(value[end]))
            end--;

        value = value[start..(end + 1)];
        if (value.Equals("Pending", StringComparison.OrdinalIgnoreCase))
            return "Pending";
        if (value.Equals("Loading", StringComparison.OrdinalIgnoreCase))
            return "Loading";
        if (value.Equals("Completed", StringComparison.OrdinalIgnoreCase))
            return "Completed";
        return null;
    }

    private static void LogDatabaseFailure(
        ILogger logger,
        string toolName,
        SqlException exception,
        string? canonicalStatus = null) =>
        logger.LogError(
            "Tool call failed for {ToolName} with failure type {FailureType}, SQL number {SqlNumber}, state {SqlState}, class {SqlClass}, and canonical status {ShipmentStatus}",
            toolName, "DatabaseFailure", exception.Number, exception.State, exception.Class, canonicalStatus);

    private static void LogUnexpectedFailure(
        ILogger logger,
        string toolName,
        Exception exception,
        string? canonicalStatus = null) =>
        logger.LogError(
            "Tool call failed for {ToolName} with failure type {FailureType}, exception type {ExceptionType}, HRESULT {ExceptionHResult}, and canonical status {ShipmentStatus}",
            toolName, "UnexpectedFailure", exception.GetType().FullName, exception.HResult, canonicalStatus);
}
