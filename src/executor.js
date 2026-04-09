const { spawn } = require("child_process");

function trimBuffer(buffer, limitBytes) {
  if (buffer.length <= limitBytes) {
    return { buffer, truncated: false };
  }
  return {
    buffer: buffer.subarray(0, limitBytes),
    truncated: true,
  };
}

function runCommandWithStdin({ cmd, cwd, stdinJson, timeoutMs, outputLimitBytes }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      cwd,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutChunks = [];
    let stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let timeoutTriggered = false;

    const timeoutHandle = setTimeout(() => {
      timeoutTriggered = true;
      child.kill("SIGTERM");

      setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, 5000);
    }, timeoutMs);

    function collectChunk(targetChunks, chunk, currentBytes, markTruncated) {
      if (currentBytes >= outputLimitBytes) {
        return { bytes: currentBytes, truncated: true };
      }
      const remaining = outputLimitBytes - currentBytes;
      const { buffer, truncated } = trimBuffer(chunk, remaining);
      targetChunks.push(buffer);
      return {
        bytes: currentBytes + buffer.length,
        truncated: markTruncated || truncated,
      };
    }

    child.stdout.on("data", (chunk) => {
      const result = collectChunk(
        stdoutChunks,
        chunk,
        stdoutBytes,
        stdoutTruncated
      );
      stdoutBytes = result.bytes;
      stdoutTruncated = result.truncated;
    });

    child.stderr.on("data", (chunk) => {
      const result = collectChunk(
        stderrChunks,
        chunk,
        stderrBytes,
        stderrTruncated
      );
      stderrBytes = result.bytes;
      stderrTruncated = result.truncated;
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: `Failed to start command: ${error.message}`,
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    });

    child.on("close", (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      resolve({
        exitCode,
        signal,
        timedOut: timeoutTriggered,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        stdoutTruncated,
        stderrTruncated,
      });
    });

    child.stdin.write(stdinJson);
    child.stdin.end();
  });
}

module.exports = {
  runCommandWithStdin,
};
