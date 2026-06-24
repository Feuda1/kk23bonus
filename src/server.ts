import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { registerRoutes } from "./api/routes.js";
import { TelegramLoyaltyBot } from "./bot/telegramBot.js";
import { VkLoyaltyBot } from "./bot/vkBot.js";
import { readConfig } from "./config.js";
import { LoyaltyService } from "./services/loyaltyService.js";
import { CompositeNotifier, MutableNotifier } from "./services/notifier.js";
import { MemoryStore } from "./store/memoryStore.js";
import { PgStore } from "./store/pgStore.js";
import type { LoyaltyStore } from "./store/store.js";
import type { LoyaltyNotifier } from "./services/notifier.js";

const config = readConfig();
const app = Fastify({ logger: true });
const notifier = new MutableNotifier();
const store: LoyaltyStore = config.databaseUrl ? new PgStore(config.databaseUrl) : new MemoryStore();
const service = new LoyaltyService(store, notifier);
const notifierTargets: LoyaltyNotifier[] = [];
let telegramBot: TelegramLoyaltyBot | null = null;
let vkBot: VkLoyaltyBot | null = null;

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
app.get("/vk", async (_request, reply) => reply.sendFile("vk/index.html"));

await store.ensureReady();
await registerRoutes(app, service);

if (config.telegramBotToken) {
  telegramBot = new TelegramLoyaltyBot(config.telegramBotToken, service);
  notifierTargets.push(telegramBot);
  app.log.info("Telegram bot polling started");
} else {
  app.log.warn("Telegram bot token is not set; API and barista panel will run without bot notifications");
}

if (config.vk) {
  vkBot = new VkLoyaltyBot(config.vk, service);
  notifierTargets.push(vkBot);
  app.post("/api/vk/callback", async (request, reply) => {
    const result = await vkBot!.handleCallback(request.body);
    return reply.code(result.status).type("text/plain").send(result.text);
  });
  app.log.info({ groupId: config.vk.groupId }, "VK callback bot enabled");
} else {
  app.log.warn("VK bot config is not set; /api/vk/callback will not be enabled");
}

if (notifierTargets.length > 0) {
  notifier.setTarget(new CompositeNotifier(notifierTargets));
}

const PENDING_SWEEP_INTERVAL_MS = 15_000;
const pendingSweep = setInterval(() => {
  void service.expireDuePending().catch((error) => app.log.error(error, "Pending sweep failed"));
}, PENDING_SWEEP_INTERVAL_MS);
pendingSweep.unref();

const shutdown = async (): Promise<void> => {
  app.log.info("Shutting down");
  clearInterval(pendingSweep);
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
