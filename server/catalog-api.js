#!/usr/bin/env node
const Fastify = require("fastify");
const { getCatalogConfig } = require("../src/config/catalog-config");
const { openCatalogDatabase } = require("../src/db/catalog-db");
const { migrateDatabase } = require("../src/db/migrate");
const { createCatalogRepository } = require("../src/repositories/catalog-repository");

function createCatalogApi(options = {}) {
  const config = options.config || getCatalogConfig();
  const database = options.database || openCatalogDatabase(config.databasePath);
  if (!options.skipMigrations) {
    migrateDatabase(database, config.migrationsDir, { logger: options.logger || console });
  }
  const repository = createCatalogRepository(database, config);
  const app = Fastify({
    logger: options.logger === false ? false : { level: process.env.CATALOG_API_LOG_LEVEL || "info" },
    bodyLimit: 16384,
  });
  const base = config.apiBasePath;

  app.get(`${base}/health`, async () => ({
    ...repository.health(),
    uptime_seconds: Math.round(process.uptime()),
    memory: process.memoryUsage(),
    generated_at: new Date().toISOString(),
  }));

  app.get(`${base}/categories`, async () => ({ categories: repository.categories() }));

  app.get(`${base}/media`, async (request) => repository.listMedia(request.query));

  app.get(`${base}/media/:id`, async (request, reply) => {
    const id = Number.parseInt(request.params.id, 10);
    if (!Number.isFinite(id) || id < 1) return reply.code(400).send({ error: "invalid_media_id" });
    const media = repository.getMedia(id);
    if (!media) return reply.code(404).send({ error: "media_not_found" });
    return { data: media };
  });

  app.get(`${base}/media/:id/files`, async (request, reply) => {
    const id = Number.parseInt(request.params.id, 10);
    if (!Number.isFinite(id) || id < 1) return reply.code(400).send({ error: "invalid_media_id" });
    if (!repository.getMedia(id)) return reply.code(404).send({ error: "media_not_found" });
    return repository.getMediaFiles(id, request.query);
  });

  app.get(`${base}/media/:id/episodes`, async (request, reply) => {
    const id = Number.parseInt(request.params.id, 10);
    if (!Number.isFinite(id) || id < 1) return reply.code(400).send({ error: "invalid_media_id" });
    const media = repository.getMedia(id);
    if (!media) return reply.code(404).send({ error: "media_not_found" });
    if (media.media_type !== "tv") return reply.code(400).send({ error: "media_is_not_tvshow" });
    return repository.getEpisodes(id, request.query);
  });

  app.get(`${base}/search`, async (request, reply) => {
    if (!String(request.query.q || "").trim()) return reply.code(400).send({ error: "missing_query" });
    return repository.listMedia({ ...request.query, query: request.query.q });
  });

  app.get(`${base}/search/movies`, async (request, reply) => {
    if (!String(request.query.q || "").trim()) return reply.code(400).send({ error: "missing_query" });
    return repository.listMedia({ ...request.query, query: request.query.q, category: "movies" });
  });

  app.get(`${base}/search/series`, async (request, reply) => {
    if (!String(request.query.q || "").trim()) return reply.code(400).send({ error: "missing_query" });
    return repository.listMedia({ ...request.query, query: request.query.q, category: "series" });
  });

  app.get(`${base}/filters/years`, async (request) => ({ data: repository.distinctFilter("years", request.query.category) }));
  app.get(`${base}/filters/qualities`, async (request) => ({ data: repository.distinctFilter("qualities", request.query.category) }));
  app.get(`${base}/filters/genres`, async (request) => ({ data: repository.genres(request.query.category) }));
  app.get(`${base}/filters/languages`, async (request) => ({ data: repository.languages(request.query.category) }));

  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: "not_found" }));
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ error: error.message }, "Catalog API request failed");
    reply.code(error.statusCode && error.statusCode < 500 ? error.statusCode : 500).send({
      error: error.statusCode && error.statusCode < 500 ? error.message : "internal_server_error",
    });
  });

  app.addHook("onClose", async () => {
    if (!options.database) database.close();
  });
  return app;
}

async function main() {
  const config = getCatalogConfig();
  const app = createCatalogApi({ config });
  const stop = async () => {
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await app.listen({ host: config.apiHost, port: config.apiPort });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  createCatalogApi,
};
