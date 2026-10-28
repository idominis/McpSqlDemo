using System.ComponentModel;
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
        LogStarted(logger, nameof(GetShipmentById));

        if (!ShipmentInputValidation.IsValidShipmentId(shipmentId))
        {
            LogFailure(logger, nameof(GetShipmentById), "InvalidInput");
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
            LogCanceled(logger, nameof(GetShipmentById));
            throw;
        }
        catch (ShipmentToolDeadlineExceededException)
        {
            LogFailure(logger, nameof(GetShipmentById), "DeadlineExceeded");
            throw new McpException("The shipment operation timed out. Please try again later.");
        }
        catch (ShipmentDatabaseException exception) when (exception.IsCommandTimeout)
        {
            LogFailure(logger, nameof(GetShipmentById), "DatabaseTimeout");
            throw new McpException("The shipment operation timed out. Please try again later.");
        }
        catch (ShipmentDatabaseException)
        {
            LogFailure(logger, nameof(GetShipmentById), "DatabaseFailure");
            throw new McpException("The shipment database operation failed. Please try again later.");
        }
        catch (Exception)
        {
            LogFailure(logger, nameof(GetShipmentById), "UnexpectedFailure");
            throw new McpException("The shipment operation failed. Please try again later.");
        }

        if (shipment is null)
        {
            LogFailure(logger, nameof(GetShipmentById), "NotFound");
            throw new McpException($"Shipment with ID {shipmentId} was not found.");
        }

        LogCompleted(logger, nameof(GetShipmentById));
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
        LogStarted(logger, nameof(ListShipments));

        try
        {
            var shipments = await executionPolicy.ExecuteAsync(repository.ListAsync, cancellationToken);
            LogCompleted(logger, nameof(ListShipments));
            return shipments;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            LogCanceled(logger, nameof(ListShipments));
            throw;
        }
        catch (ShipmentToolDeadlineExceededException)
        {
            LogFailure(logger, nameof(ListShipments), "DeadlineExceeded");
            throw new McpException("The shipment operation timed out. Please try again later.");
        }
        catch (ShipmentDatabaseException exception) when (exception.IsCommandTimeout)
        {
            LogFailure(logger, nameof(ListShipments), "DatabaseTimeout");
            throw new McpException("The shipment operation timed out. Please try again later.");
        }
        catch (ShipmentDatabaseException)
        {
            LogFailure(logger, nameof(ListShipments), "DatabaseFailure");
            throw new McpException("The shipment database operation failed. Please try again later.");
        }
        catch (Exception)
        {
            LogFailure(logger, nameof(ListShipments), "UnexpectedFailure");
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

        var canonicalStatus = ShipmentInputValidation.NormalizeStatus(status);

        if (canonicalStatus is null)
        {
            LogFailure(logger, nameof(GetShipmentsByStatus), "InvalidInput");
            throw new McpException("status must be one of: Pending, Loading, Completed.");
        }

        LogStarted(logger, nameof(GetShipmentsByStatus));

        try
        {
            var shipments = await executionPolicy.ExecuteAsync(
                ct => repository.GetByStatusAsync(canonicalStatus, ct), cancellationToken);
            LogCompleted(logger, nameof(GetShipmentsByStatus));
            return shipments;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            LogCanceled(logger, nameof(GetShipmentsByStatus));
            throw;
        }
        catch (ShipmentToolDeadlineExceededException)
        {
            LogFailure(logger, nameof(GetShipmentsByStatus), "DeadlineExceeded");
            throw new McpException("The shipment operation timed out. Please try again later.");
        }
        catch (ShipmentDatabaseException exception) when (exception.IsCommandTimeout)
        {
            LogFailure(logger, nameof(GetShipmentsByStatus), "DatabaseTimeout");
            throw new McpException("The shipment operation timed out. Please try again later.");
        }
        catch (ShipmentDatabaseException)
        {
            LogFailure(logger, nameof(GetShipmentsByStatus), "DatabaseFailure");
            throw new McpException("The shipment database operation failed. Please try again later.");
        }
        catch (Exception)
        {
            LogFailure(logger, nameof(GetShipmentsByStatus), "UnexpectedFailure");
            throw new McpException("The shipment operation failed. Please try again later.");
        }
    }

    private static void LogStarted(ILogger logger, string toolName) =>
        logger.LogInformation("Shipment tool event {ToolEvent} for {ToolName}", "Started", toolName);

    private static void LogCompleted(ILogger logger, string toolName) =>
        logger.LogInformation("Shipment tool event {ToolEvent} for {ToolName}", "Completed", toolName);

    private static void LogCanceled(ILogger logger, string toolName) =>
        logger.LogInformation("Shipment tool event {ToolEvent} for {ToolName}", "Canceled", toolName);

    private static void LogFailure(ILogger logger, string toolName, string failureCategory) =>
        logger.LogWarning(
            "Shipment tool event {ToolEvent} for {ToolName} with category {FailureCategory}",
            "Failed", toolName, failureCategory);
}
