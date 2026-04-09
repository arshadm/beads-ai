# beads-ai

RabbitMQ-driven AI agent orchestrator for Linux deployments.

## What it does

- Loads environment config from `.env` using `dotenv`.
- Loads project/queue/command routing from YAML using `js-yaml`.
- Consumes configured RabbitMQ queues.
- Sends each queue message JSON payload to the configured command over `stdin`.
- Captures command `stdout` and `stderr` (each capped by `OUTPUT_LIMIT_BYTES`).
- Acknowledges RabbitMQ message after command completes.
- Sends command output email using Unix `mail` command (non-blocking to queue ack).
- Requeues messages only on processing failures (for example invalid JSON, unexpected runtime errors).

## Install

```bash
npm install
cp .env.example .env
```

## Environment configuration

```env
RABBITMQ_HOST=amqp://localhost:5672
NOTIFY_EMAIL=somebody@example.com
CONFIG_PATH=config/agent-orchestrator.yaml
CONCURRENCY=1
COMMAND_TIMEOUT_MS=1800000
OUTPUT_LIMIT_BYTES=1048576
MAIL_BIN=mail
```

Notes:

- `NOTIFY_EMAIL` is the recipient for command-result emails. `EMAIL_TO` is still accepted as a legacy fallback.
- `CONCURRENCY` controls RabbitMQ prefetch per queue consumer.
- `COMMAND_TIMEOUT_MS` defaults to 30 minutes.
- `OUTPUT_LIMIT_BYTES` defaults to 1 MB per stream (`stdout` and `stderr` separately).

## YAML routing configuration

`/home/user/config/agent-orchestrator.yaml`:

```yaml
projects:
  rustc:
    project_dir: /home/projects/rustc
    commands:
      plan:
        queue: rustc-plan
        cmd: "agent-plan agent=claude"
      execute:
        queue: rustc-execute
        cmd: "agent-execute agent=claude"
```

## Queue message format

Each message must be valid JSON.

Example:

```json
{
  "ticket_id": "OPS-1289",
  "prompt": "Create migration plan for module foo",
  "context": {
    "branch": "feature/foo"
  }
}
```

The exact schema is owned by your downstream command scripts; this service only validates that it is JSON and then pipes the raw JSON string to command `stdin`.

## Run

```bash
npm start
```

## Linux prerequisites

- RabbitMQ reachable at `RABBITMQ_HOST`
- `mail`/`mailx` installed and configured to relay via Gmail SMTP on host
- Command binaries available in `PATH` (for example `agent-plan`, `agent-execute`)

## Behavior details

- Message `ack` happens after command completion (even if email fails).
- Email failures are retried briefly and then logged.
- Invalid JSON payloads are logged and requeued.
- Unexpected runtime exceptions are logged and requeued.

