using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using ModelContextProtocol.Server;
using System.Text.Json;
using Xunit;

public sealed class McpToolExposureTests
{
    [Fact]
    public void ServerRegistration_ExposesExactlyTheApprovedTools()
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton<IShipmentRepository, FakeShipmentRepository>();
        services.AddSingleton(new SecuritySettings(5, 10, TimeSpan.FromSeconds(5), 2));
        services.AddSingleton<ShipmentToolExecutionPolicy>();
        services.AddMcpServer().WithToolsFromAssembly(typeof(ShipmentTools).Assembly);

        using var serviceProvider = services.BuildServiceProvider();
        var tools = serviceProvider.GetServices<McpServerTool>().ToArray();
        var toolNames = tools
            .Select(tool => tool.ProtocolTool.Name)
            .Order(StringComparer.Ordinal)
            .ToArray();

        Assert.Equal(
            ["get_shipment_by_id", "get_shipments_by_status", "list_shipments"],
            toolNames);

        Assert.Equal(["shipmentId"], GetClientParameterNames(tools, "get_shipment_by_id"));
        Assert.Equal(["status"], GetClientParameterNames(tools, "get_shipments_by_status"));
        Assert.Empty(GetClientParameterNames(tools, "list_shipments"));

        Assert.All(tools, tool =>
        {
            Assert.True(tool.ProtocolTool.Annotations?.ReadOnlyHint);
            Assert.False(tool.ProtocolTool.Annotations?.DestructiveHint);
        });

        Assert.Equal("integer", GetClientParameterType(tools, "get_shipment_by_id", "shipmentId"));
        Assert.Equal("string", GetClientParameterType(tools, "get_shipments_by_status", "status"));
    }

    private static string[] GetClientParameterNames(McpServerTool[] tools, string toolName)
    {
        var tool = Assert.Single(tools, candidate => candidate.ProtocolTool.Name == toolName);
        using var schema = JsonDocument.Parse(JsonSerializer.Serialize(tool.ProtocolTool.InputSchema));
        return schema.RootElement.GetProperty("properties")
            .EnumerateObject()
            .Select(property => property.Name)
            .Order(StringComparer.Ordinal)
            .ToArray();
    }

    private static string GetClientParameterType(
        McpServerTool[] tools,
        string toolName,
        string parameterName)
    {
        var tool = Assert.Single(tools, candidate => candidate.ProtocolTool.Name == toolName);
        using var schema = JsonDocument.Parse(JsonSerializer.Serialize(tool.ProtocolTool.InputSchema));
        return schema.RootElement
            .GetProperty("properties")
            .GetProperty(parameterName)
            .GetProperty("type")
            .GetString()!;
    }
}
