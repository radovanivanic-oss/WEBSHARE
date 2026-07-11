const fs = require("fs");
const path = require("path");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function createCliLogger() {
  function write(level, message, extra) {
    const timestamp = new Date().toISOString();
    const suffix = extra === undefined ? "" : ` ${JSON.stringify(extra, null, 2)}`;
    console.log(`[${timestamp}] [${level}] ${message}${suffix}`);
  }

  return {
    info(message, extra) {
      write("INFO", message, extra);
    },
    warn(message, extra) {
      write("WARN", message, extra);
    },
    error(message, extra) {
      write("ERROR", message, extra);
    },
  };
}

async function main() {
  loadEnvFile(path.join(process.cwd(), ".env"));
  process.env.GITHUB_EXPORT_ENABLED = "true";

  const { getConfig, publishExportsToGithub } = require("./main");
  const config = getConfig({ requireCredentials: false });
  const logger = createCliLogger();

  logger.info("Spúšťam manuálny GitHub export.", {
    outputPath: config.outputPath,
    branch: config.githubExportBranch,
  });

  const result = await publishExportsToGithub(config, logger);
  logger.info("Manuálny GitHub export hotový.", result);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
