const amqp = require("amqplib");
const fs = require("fs");
const path = require("path");
const { runCommandWithStdin } = require("./executor");
const { buildEmailBody, sendEmailWithRetry } = require("./email");

function toSingleLine(text, maxLength = 120) {
  return text.replace(/\s+/g, " ").slice(0, maxLength);
}

function withCommandDir(cmd, commandDir) {
  if (!commandDir || typeof commandDir !== "string" || commandDir.trim() === "") {
    return cmd;
  }

  const match = cmd.match(/^(\s*)(\S+)([\s\S]*)$/);
  if (!match) {
    return cmd;
  }

  const [, leadingSpace, executable, rest] = match;
  if (
    executable.startsWith("/") ||
    executable.startsWith("./") ||
    executable.startsWith("../")
  ) {
    return cmd;
  }

  const normalizedDir = commandDir.replace(/\/+$/, "");
  return `${leadingSpace}${normalizedDir}/${executable}${rest}`;
}

function appendRouteParameters(cmd, route) {
  const args = [];
  if (route.githubRepo) {
    args.push(`github_repo=${route.githubRepo}`);
  }
  if (route.branch) {
    args.push(`branch=${route.branch}`);
  }
  if (route.promptDir) {
    args.push(`prompt_dir=${route.promptDir}`);
  }
  if (args.length === 0) {
    return cmd;
  }
  return `${cmd} ${args.join(" ")}`;
}

function parseJsonMessage(rawText) {
  try {
    const payload = JSON.parse(rawText);
    return { valid: true, payload };
  } catch (error) {
    return { valid: false, error };
  }
}

function getMessageField(payload, keys) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return null;
}

function sanitizePathSegment(value) {
  return value.replace(/[\\/]/g, "_");
}

function resolveWorkingDir({ appConfig, route, taskId }) {
  if (appConfig.tempDir && appConfig.tempDir.trim() !== "") {
    const dir = path.join(appConfig.tempDir, sanitizePathSegment(taskId));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  return route.projectDir;
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

  const taskId =
    getMessageField(parsed.payload, ["taskId", "task_id", "ticket_id", "id"]) ||
    "unknown-task";
  const taskTitle =
    getMessageField(parsed.payload, ["taskTitle", "title", "task_title", "prompt"]) ||
    "untitled-task";
  const workingDir = resolveWorkingDir({ appConfig, route, taskId });
  const commandToRun = appendRouteParameters(
    withCommandDir(route.cmd, appConfig.commandDir),
    route
  );
  const commandResult = await runCommandWithStdin({
    cmd: commandToRun,
    cwd: workingDir,
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

  const subject = `[beads-ai] [${route.action}] ${taskId} - ${taskTitle} (${statusText})`;
  const body = buildEmailBody({
    route,
    messagePayload: rawMessage,
    commandResult,
    deliveryTag: msg.fields.deliveryTag,
    receivedAt,
    executedCommand: commandToRun,
    executionCwd: workingDir,
  });

  try {
    await sendEmailWithRetry({
      mailBin: appConfig.mailBin,
      to: appConfig.notifyEmail,
      subject: toSingleLine(subject),
      body,
      retries: 2,
      retryDelayMs: 2000,
    });
    console.log(
      `[queue=${route.queue}] Email sent to ${appConfig.notifyEmail} deliveryTag=${msg.fields.deliveryTag}`
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
