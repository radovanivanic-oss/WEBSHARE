const axios = require("axios");
const fs = require("fs");

function getProxyApiKey(env = process.env) {
  const value = env.PROXY_API_KEY;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("PROXY_API_KEY is required.");
  }
  return value;
}

function redactSensitiveFields(value) {
  if (Array.isArray(value)) return value.map(redactSensitiveFields);
  if (typeof value === "string" && /(?:^|\/\/)[^\s:@]+:[^\s@]+@/u.test(value)) return "[REDACTED]";
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      /(?:password|token|secret|api[_-]?key|authorization|credential|username)/iu.test(key)
        ? "[REDACTED]"
        : redactSensitiveFields(child)
    ])
  );
}

async function main({ client = axios, fileSystem = fs, env = process.env } = {}) {
  const apiKey = getProxyApiKey(env);

  try {
    // 1. Získa profil používateľa
    await client.get("https://proxy.webshare.io/api/v2/profile/", {
      headers: { "Authorization": `Token ${apiKey}` }
    });

    // 2. Získa zoznam proxy serverov dostupných cez API key
    const proxiesResp = await client.get("https://proxy.webshare.io/api/v2/proxies/", {
      headers: { "Authorization": `Token ${apiKey}` }
    });

    // 3. Uloženie výsledkov do files.json
    const safeProxies = redactSensitiveFields(proxiesResp.data);
    fileSystem.writeFileSync("files.json", JSON.stringify(safeProxies, null, 2), "utf-8");
    console.log(`Úspešne uložené ${proxiesResp.data.length} proxy položiek do files.json`);
    return true;
  } catch (err) {
    console.error("Proxy API request failed.");
    return false;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { getProxyApiKey, redactSensitiveFields, main };
