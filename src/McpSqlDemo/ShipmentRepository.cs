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
    private readonly string _connectionString;
    private readonly int _commandTimeoutSeconds;
    private readonly ILogger<ShipmentRepository> _logger;

    public ShipmentRepository(ILogger<ShipmentRepository> logger, SecuritySettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        _logger = logger;
        var configuredConnectionString = Environment.GetEnvironmentVariable("MCP_SQL_CONNECTION")
            ?? throw new InvalidOperationException("MCP_SQL_CONNECTION environment variable is required.");
        var connectionStringBuilder = new SqlConnectionStringBuilder(configuredConnectionString)
        {
            ConnectTimeout = settings.ConnectionTimeoutSeconds
        };
        _connectionString = connectionStringBuilder.ConnectionString;
        _commandTimeoutSeconds = settings.CommandTimeoutSeconds;
    }

    public async Task<Shipment?> GetByIdAsync(int id, CancellationToken ct)
    {
        await using var connection = new SqlConnection(_connectionString);
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
        await using var connection = new SqlConnection(_connectionString);
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
        var result = new List<Shipment>();
        await using var connection = new SqlConnection(_connectionString);
        await connection.OpenAsync(ct);
        await using var command = new SqlCommand(
            "SELECT TOP (20) Id, Reference, Status, Quantity FROM dbo.Shipments WHERE Status = @Status ORDER BY Id",
            connection);
        command.CommandTimeout = _commandTimeoutSeconds;
        command.Parameters.Add("@Status", SqlDbType.NVarChar, 50).Value = status;
        await using var reader = await command.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct)) result.Add(ReadShipment(reader));
        _logger.LogInformation("Shipment query {QueryName} completed with {ResultCount} results",
            nameof(GetByStatusAsync), result.Count);
        return result;
    }

    private static Shipment ReadShipment(SqlDataReader reader) =>
        new(reader.GetInt32(0), reader.GetString(1), reader.GetString(2), reader.GetDecimal(3));
}
