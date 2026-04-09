const { loadConfig } = require("./config");
const { startConsumers } = require("./rabbit");

async function main() {
  const config = loadConfig();

  console.log("Starting beads-ai orchestrator...");
  console.log(
    `RabbitMQ host=${config.rabbitmqHost}, queues=${config.queueRoutes.size}, concurrency=${config.concurrency}`
  );

  const runtime = await startConsumers(config);

  const handleShutdown = async (signal) => {
    console.log(`Received ${signal}, shutting down...`);
    try {
      await runtime.close();
      process.exit(0);
    } catch (error) {
      console.error(`Shutdown error: ${error.message}`);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => {
    handleShutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    handleShutdown("SIGTERM");
  });
}

main().catch((error) => {
  console.error(`Fatal startup error: ${error.message}`);
  process.exit(1);
});
