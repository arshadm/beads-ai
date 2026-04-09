const amqp = require("amqplib");
const { runCommandWithStdin } = require("./executor");
const { buildEmailBody, sendEmailWithRetry } = require("./email");

function toSingleLine(text, maxLength = 120) {
  return text.replace(/\s+/g, " ").slice(0, maxLength);
}

function parseJsonMessage(rawText) {
  try {
    JSON.parse(rawText);
    return { valid: true };
  } catch (error) {
    return { valid: false, error };
  }
}

async function processMessage({ channel, msg, route, appConfig }) {
  const receivedAt = new Date().toISOString();
  const rawMessage = msg.content.toString("utf8");
  const parsed = parseJsonMessage(rawMessage);

  if (!parsed.valid) {
    console.error(
      `[queue=${route.queue}] Invalid JSON payload. Requeueing. error=${parsed.error.message}`
    );
    channel.nack(msg, false, true);
    return;
  }

  console.log(
    `[queue=${route.queue}] Processing message deliveryTag=${msg.fields.deliveryTag}`
  );

  const commandResult = await runCommandWithStdin({
    cmd: route.cmd,
    cwd: route.projectDir,
    stdinJson: rawMessage,
    timeoutMs: appConfig.commandTimeoutMs,
    outputLimitBytes: appConfig.outputLimitBytes,
  });

  channel.ack(msg);

  const statusText = commandResult.timedOut
    ? "timeout"
    : commandResult.exitCode === 0
      ? "success"
      : "failed";

  console.log(
    `[queue=${route.queue}] Command completed status=${statusText} exitCode=${commandResult.exitCode} signal=${commandResult.signal || "-"}`
  );

  const subject = `[beads-ai] ${route.projectName}/${route.action} ${statusText}`;
  const body = buildEmailBody({
    route,
    messagePayload: rawMessage,
    commandResult,
    deliveryTag: msg.fields.deliveryTag,
    receivedAt,
  });

  try {
    await sendEmailWithRetry({
      mailBin: appConfig.mailBin,
      to: appConfig.emailTo,
      subject: toSingleLine(subject),
      body,
      retries: 2,
      retryDelayMs: 2000,
    });
    console.log(
      `[queue=${route.queue}] Email sent to ${appConfig.emailTo} deliveryTag=${msg.fields.deliveryTag}`
    );
  } catch (error) {
    console.error(
      `[queue=${route.queue}] Email failed (non-blocking) deliveryTag=${msg.fields.deliveryTag} error=${error.message}`
    );
  }
}

async function startConsumers(appConfig) {
  const connection = await amqp.connect(appConfig.rabbitmqHost);
  const channels = [];

  for (const route of appConfig.queueRoutes.values()) {
    const channel = await connection.createChannel();
    channels.push(channel);

    await channel.assertQueue(route.queue, { durable: true });
    await channel.prefetch(appConfig.concurrency);

    await channel.consume(
      route.queue,
      async (msg) => {
        if (!msg) {
          return;
        }

        try {
          await processMessage({ channel, msg, route, appConfig });
        } catch (error) {
          console.error(
            `[queue=${route.queue}] Unexpected processing error. Requeueing. error=${error.message}`
          );
          channel.nack(msg, false, true);
        }
      },
      { noAck: false }
    );

    console.log(
      `Consuming queue=${route.queue} project=${route.projectName} action=${route.action} concurrency=${appConfig.concurrency}`
    );
  }

  return {
    async close() {
      for (const channel of channels) {
        await channel.close();
      }
      await connection.close();
    },
  };
}

module.exports = {
  startConsumers,
};
