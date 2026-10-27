using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Logging;
using System.Data;

public sealed record Shipment(int Id, string Reference, string Status, decimal Quantity);

public interface IShipmentRepository
{
    Task<Shipment?> GetByIdAsync(int id, CancellationToken ct);
    Task<IReadOnlyList<Shipment>> ListAsync(CancellationToken ct);
    Task<IReadOnlyList<Shipment>> GetByStatusAsync(string status, CancellationToken ct);
}

public sealed class ShipmentRepository : IShipmentRepository
{
    private readonly string? _configuredConnectionString;
    private readonly int _connectionTimeoutSeconds;
    private readonly int _commandTimeoutSeconds;
    private readonly ILogger<ShipmentRepository> _logger;

    public ShipmentRepository(ILogger<ShipmentRepository> logger, SecuritySettings settings)
        : this(logger, settings, Environment.GetEnvironmentVariable("MCP_SQL_CONNECTION"))
    {
    }

    internal ShipmentRepository(
        ILogger<ShipmentRepository> logger,
        SecuritySettings settings,
        string? configuredConnectionString)
    {
        ArgumentNullException.ThrowIfNull(settings);
        ArgumentNullException.ThrowIfNull(logger);
        _logger = logger;
        _configuredConnectionString = configuredConnectionString;
        _connectionTimeoutSeconds = settings.ConnectionTimeoutSeconds;
        _commandTimeoutSeconds = settings.CommandTimeoutSeconds;
    }

    public async Task<Shipment?> GetByIdAsync(int id, CancellationToken ct)
    {
        if (!ShipmentInputValidation.IsValidShipmentId(id))
            throw new ArgumentOutOfRangeException(nameof(id));

        await using var connection = CreateConnection();
        await connection.OpenAsync(ct);
        await using var command = new SqlCommand(
            "SELECT Id, Reference, Status, Quantity FROM dbo.Shipments WHERE Id = @Id", connection);
        command.CommandTimeout = _commandTimeoutSeconds;
        command.Parameters.Add("@Id", SqlDbType.Int).Value = id;
        await using var reader = await command.ExecuteReaderAsync(ct);
        var shipment = await reader.ReadAsync(ct) ? ReadShipment(reader) : null;
        _logger.LogInformation("Shipment query {QueryName} completed with {ResultCount} results",
            nameof(GetByIdAsync), shipment is null ? 0 : 1);
        return shipment;
    }

    public async Task<IReadOnlyList<Shipment>> ListAsync(CancellationToken ct)
    {
        var result = new List<Shipment>();
        await using var connection = CreateConnection();
        await connection.OpenAsync(ct);
        await using var command = new SqlCommand(
            "SELECT TOP (20) Id, Reference, Status, Quantity FROM dbo.Shipments ORDER BY Id", connection);
        command.CommandTimeout = _commandTimeoutSeconds;
        await using var reader = await command.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct)) result.Add(ReadShipment(reader));
        _logger.LogInformation("Shipment query {QueryName} completed with {ResultCount} results",
            nameof(ListAsync), result.Count);
        return result;
    }

    public async Task<IReadOnlyList<Shipment>> GetByStatusAsync(string status, CancellationToken ct)
    {
        var canonicalStatus = ShipmentInputValidation.NormalizeStatus(status)
            ?? throw new ArgumentException(
                "The status must be an approved shipment status.", nameof(status));

        var result = new List<Shipment>();
        await using var connection = CreateConnection();
        await connection.OpenAsync(ct);
        await using var command = new SqlCommand(
            "SELECT TOP (20) Id, Reference, Status, Quantity FROM dbo.Shipments WHERE Status = @Status ORDER BY Id",
            connection);
        command.CommandTimeout = _commandTimeoutSeconds;
        command.Parameters.Add("@Status", SqlDbType.NVarChar, 50).Value = canonicalStatus;
        await using var reader = await command.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct)) result.Add(ReadShipment(reader));
        _logger.LogInformation("Shipment query {QueryName} completed with {ResultCount} results",
            nameof(GetByStatusAsync), result.Count);
        return result;
    }

    private SqlConnection CreateConnection()
    {
        if (string.IsNullOrWhiteSpace(_configuredConnectionString))
            throw new InvalidOperationException("The shipment database connection is not configured.");

        try
        {
            var connectionStringBuilder = new SqlConnectionStringBuilder(_configuredConnectionString)
            {
                ConnectTimeout = _connectionTimeoutSeconds,
                PersistSecurityInfo = false
            };
            return new SqlConnection(connectionStringBuilder.ConnectionString);
        }
        catch (ArgumentException exception)
        {
            throw new InvalidOperationException(
                "The shipment database connection configuration is invalid.", exception);
        }
    }

    private static Shipment ReadShipment(SqlDataReader reader) =>
        new(reader.GetInt32(0), reader.GetString(1), reader.GetString(2), reader.GetDecimal(3));
}
