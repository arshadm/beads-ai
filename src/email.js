const { spawn } = require("child_process");

function buildEmailBody({
  route,
  messagePayload,
  commandResult,
  deliveryTag,
  receivedAt,
}) {
  const status = commandResult.timedOut
    ? "TIMEOUT"
    : commandResult.exitCode === 0
      ? "SUCCESS"
      : "FAILED";

  const metadata = {
    project: route.projectName,
    action: route.action,
    queue: route.queue,
    command: route.cmd,
    project_dir: route.projectDir,
    delivery_tag: deliveryTag,
    received_at: receivedAt,
    completed_at: new Date().toISOString(),
    status,
    exit_code: commandResult.exitCode,
    signal: commandResult.signal,
    timed_out: commandResult.timedOut,
    stdout_truncated: commandResult.stdoutTruncated,
    stderr_truncated: commandResult.stderrTruncated,
  };

  return [
    "Agent Orchestrator Execution Report",
    "",
    "== Metadata ==",
    JSON.stringify(metadata, null, 2),
    "",
    "== Input Message (JSON) ==",
    messagePayload,
    "",
    "== STDOUT ==",
    commandResult.stdout || "(empty)",
    "",
    "== STDERR ==",
    commandResult.stderr || "(empty)",
    "",
  ].join("\n");
}

function sendEmail({ mailBin, to, subject, body }) {
  return new Promise((resolve, reject) => {
    const child = spawn(mailBin, ["-s", subject, to], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`mail command exited with code ${code}: ${stderr}`));
    });

    child.stdin.write(body);
    child.stdin.end();
  });
}

async function sendEmailWithRetry({
  mailBin,
  to,
  subject,
  body,
  retries = 2,
  retryDelayMs = 2000,
}) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await sendEmail({ mailBin, to, subject, body });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  throw lastError;
}

module.exports = {
  buildEmailBody,
  sendEmailWithRetry,
};
