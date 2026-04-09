const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const dotenv = require("dotenv");

dotenv.config();

function parsePositiveInt(value, fallback, keyName) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const num = Number.parseInt(value, 10);
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error(`${keyName} must be a positive integer`);
  }
  return num;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function loadYamlConfig(configPath) {
  const absolutePath = path.resolve(configPath);
  const fileContent = fs.readFileSync(absolutePath, "utf8");
  const parsed = yaml.load(fileContent);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid YAML structure at ${absolutePath}`);
  }
  return parsed;
}

function buildQueueRoutes(projects) {
  if (!projects || typeof projects !== "object") {
    throw new Error("YAML must contain a 'projects' object");
  }

  const routes = new Map();

  for (const [projectName, projectConfig] of Object.entries(projects)) {
    if (!projectConfig || typeof projectConfig !== "object") {
      throw new Error(`Project '${projectName}' config must be an object`);
    }

    const projectDir = projectConfig.project_dir;
    const commands = projectConfig.commands;

    if (!projectDir || typeof projectDir !== "string") {
      throw new Error(`Project '${projectName}' must define project_dir`);
    }
    if (!commands || typeof commands !== "object") {
      throw new Error(`Project '${projectName}' must define commands`);
    }

    for (const [action, commandConfig] of Object.entries(commands)) {
      if (!commandConfig || typeof commandConfig !== "object") {
        throw new Error(
          `Command '${projectName}.${action}' config must be an object`
        );
      }

      const queue = commandConfig.queue;
      const cmd = commandConfig.cmd;

      if (!queue || typeof queue !== "string") {
        throw new Error(`Command '${projectName}.${action}' must define queue`);
      }
      if (!cmd || typeof cmd !== "string") {
        throw new Error(`Command '${projectName}.${action}' must define cmd`);
      }
      if (routes.has(queue)) {
        throw new Error(
          `Duplicate queue '${queue}' detected in YAML configuration`
        );
      }

      routes.set(queue, {
        queue,
        projectName,
        action,
        projectDir,
        cmd,
      });
    }
  }

  if (routes.size === 0) {
    throw new Error("No queue routes found in YAML configuration");
  }

  return routes;
}

function loadConfig() {
  const configPath = process.env.CONFIG_PATH || "config/agent-orchestrator.yaml";
  const yamlConfig = loadYamlConfig(configPath);

  const rabbitmqHost = requiredEnv("RABBITMQ_HOST");
  const notifyEmail = process.env.NOTIFY_EMAIL || process.env.EMAIL_TO;
  if (!notifyEmail) {
    throw new Error(
      "Missing required environment variable: NOTIFY_EMAIL (or legacy EMAIL_TO)"
    );
  }

  return {
    rabbitmqHost,
    notifyEmail,
    mailBin: process.env.MAIL_BIN || "mail",
    concurrency: parsePositiveInt(process.env.CONCURRENCY, 1, "CONCURRENCY"),
    commandTimeoutMs: parsePositiveInt(
      process.env.COMMAND_TIMEOUT_MS,
      30 * 60 * 1000,
      "COMMAND_TIMEOUT_MS"
    ),
    outputLimitBytes: parsePositiveInt(
      process.env.OUTPUT_LIMIT_BYTES,
      1024 * 1024,
      "OUTPUT_LIMIT_BYTES"
    ),
    queueRoutes: buildQueueRoutes(yamlConfig.projects),
  };
}

module.exports = {
  loadConfig,
};
