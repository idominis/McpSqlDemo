using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

// Avoid default configuration providers: this lab needs no files, secrets,
// environment credentials, command-line configuration, or external services.
var builder = Host.CreateEmptyApplicationBuilder(new HostApplicationBuilderSettings());

// MCP stdio reserves stdout for protocol messages.
builder.Logging.ClearProviders();
builder.Logging.AddConsole(options => options.LogToStandardErrorThreshold = LogLevel.Trace);

builder.Services
    .AddMcpServer()
    .WithStdioServerTransport()
    .WithToolsFromAssembly(typeof(UntrustedShipmentTools).Assembly);

await builder.Build().RunAsync();
