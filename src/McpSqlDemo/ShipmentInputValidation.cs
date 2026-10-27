internal static class ShipmentInputValidation
{
    internal const int MinimumShipmentId = 1;
    internal const int MaximumShipmentId = 1_000_000;
    internal const int MaximumStatusLength = 50;

    internal static bool IsValidShipmentId(int shipmentId) =>
        shipmentId is >= MinimumShipmentId and <= MaximumShipmentId;

    internal static string? NormalizeStatus(string? status)
    {
        if (status is null || status.Length > MaximumStatusLength)
            return null;

        var value = status.AsSpan().Trim();
        if (value.Equals("Pending", StringComparison.OrdinalIgnoreCase))
            return "Pending";
        if (value.Equals("Loading", StringComparison.OrdinalIgnoreCase))
            return "Loading";
        if (value.Equals("Completed", StringComparison.OrdinalIgnoreCase))
            return "Completed";
        return null;
    }
}
