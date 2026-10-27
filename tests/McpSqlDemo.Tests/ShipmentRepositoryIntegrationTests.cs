using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

[Trait("Category", "Integration")]
public sealed class ShipmentRepositoryIntegrationTests
{
    [LocalDbFact]
    public async Task ListAsync_ReturnsAtMostTwentyShipmentsOrderedById()
    {
        var repository = CreateRepository();

        var shipments = await repository.ListAsync(CancellationToken.None);

        Assert.True(shipments.Count <= 20);
        Assert.Equal(shipments.OrderBy(shipment => shipment.Id), shipments);
    }

    [LocalDbFact]
    public async Task GetByIdAsync_ReturnsTheSelectedShipmentWhenOneExists()
    {
        var repository = CreateRepository();
        var shipments = await repository.ListAsync(CancellationToken.None);

        if (shipments.Count == 0)
        {
            return;
        }

        var expected = shipments[0];
        var actual = await repository.GetByIdAsync(expected.Id, CancellationToken.None);

        Assert.Equal(expected, actual);
    }

    [LocalDbFact]
    public async Task GetByStatusAsync_ReturnsOnlyExactStatusMatchesOrderedById()
    {
        var repository = CreateRepository();
        var shipments = await repository.ListAsync(CancellationToken.None);
        var status = shipments.Count > 0
            ? shipments[0].Status
            : $"missing-{Guid.NewGuid():N}";

        var matches = await repository.GetByStatusAsync(status, CancellationToken.None);

        Assert.True(matches.Count <= 20);
        Assert.All(matches, shipment => Assert.Equal(status, shipment.Status));
        Assert.Equal(matches.OrderBy(shipment => shipment.Id), matches);
    }

    [LocalDbFact]
    public async Task GetByStatusAsync_WithSqlInjectionPayload_IsRejectedAndDoesNotAffectData()
    {
        var repository = CreateRepository();
        var before = await repository.ListAsync(CancellationToken.None);

        await Assert.ThrowsAsync<ArgumentException>(() =>
            repository.GetByStatusAsync(
                "Pending'; DELETE FROM dbo.Shipments;--",
                CancellationToken.None));

        var after = await repository.ListAsync(CancellationToken.None);
        Assert.Equal(before, after);
    }

    private static ShipmentRepository CreateRepository() =>
        new(NullLogger<ShipmentRepository>.Instance, SecuritySettings.FromEnvironment());
}
