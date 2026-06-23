import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { registerRoutes } from "./api/routes.js";
import { TelegramLoyaltyBot } from "./bot/telegramBot.js";
import { readConfig } from "./config.js";
import { LoyaltyService } from "./services/loyaltyService.js";
import { MutableNotifier } from "./services/notifier.js";
import { MemoryStore } from "./store/memoryStore.js";
import { PgStore } from "./store/pgStore.js";
import type { LoyaltyStore } from "./store/store.js";

const config = readConfig();
const app = Fastify({ logger: true });
const notifier = new MutableNotifier();
const store: LoyaltyStore = config.databaseUrl ? new PgStore(config.databaseUrl) : new MemoryStore();
const service = new LoyaltyService(store, notifier);
let telegramBot: TelegramLoyaltyBot | null = null;

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ZodError) {
    return reply.code(400).send({ error: "Validation error", details: error.issues });
  }

  const message = error instanceof Error ? error.message : "Unexpected error";
  const statusCode = message.includes("not found") ? 404 : message.includes("Not enough") ? 409 : 400;
  app.log.error(error);
  return reply.code(statusCode).send({ error: message });
});

await app.register(cors, { origin: true });

const here = dirname(fileURLToPath(import.meta.url));
await app.register(fastifyStatic, {
  root: join(here, "..", "public"),
  prefix: "/",
});

await store.ensureReady();
await registerRoutes(app, service);

if (config.telegramBotToken) {
  telegramBot = new TelegramLoyaltyBot(config.telegramBotToken, service);
  notifier.setTarget(telegramBot);
  app.log.info("Telegram bot polling started");
} else {
  app.log.warn("Telegram bot token is not set; API and barista panel will run without bot notifications");
}

const shutdown = async (): Promise<void> => {
  app.log.info("Shutting down");
  if (telegramBot) await telegramBot.stop();
  await store.close();
  await app.close();
};

process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});

await app.listen({ port: config.port, host: config.host });
