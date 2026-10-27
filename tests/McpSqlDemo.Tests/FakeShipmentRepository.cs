internal sealed class FakeShipmentRepository : IShipmentRepository
{
    public Shipment? ShipmentById { get; set; }
    public IReadOnlyList<Shipment> Shipments { get; set; } = [];
    public IReadOnlyList<Shipment> ShipmentsByStatus { get; set; } = [];
    public Func<int, CancellationToken, Task<Shipment?>>? GetByIdHandler { get; set; }
    public Func<CancellationToken, Task<IReadOnlyList<Shipment>>>? ListHandler { get; set; }
    public Func<string, CancellationToken, Task<IReadOnlyList<Shipment>>>? GetByStatusHandler { get; set; }

    public int GetByIdCallCount { get; private set; }
    public int ListCallCount { get; private set; }
    public int GetByStatusCallCount { get; private set; }
    public int? RequestedId { get; private set; }
    public string? RequestedStatus { get; private set; }
    public CancellationToken ReceivedCancellationToken { get; private set; }

    public Task<Shipment?> GetByIdAsync(int id, CancellationToken ct)
    {
        GetByIdCallCount++;
        RequestedId = id;
        ReceivedCancellationToken = ct;
        return GetByIdHandler?.Invoke(id, ct) ?? Task.FromResult(ShipmentById);
    }

    public Task<IReadOnlyList<Shipment>> ListAsync(CancellationToken ct)
    {
        ListCallCount++;
        ReceivedCancellationToken = ct;
        return ListHandler?.Invoke(ct) ?? Task.FromResult(Shipments);
    }

    public Task<IReadOnlyList<Shipment>> GetByStatusAsync(string status, CancellationToken ct)
    {
        GetByStatusCallCount++;
        RequestedStatus = status;
        ReceivedCancellationToken = ct;
        return GetByStatusHandler?.Invoke(status, ct) ?? Task.FromResult(ShipmentsByStatus);
    }
}
