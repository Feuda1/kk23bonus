import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { generateLoyaltyCard } from "../card/generateCard.js";
import type { LoyaltyService } from "../services/loyaltyService.js";

const guestRegistrationSchema = z.object({
  phone: z.string().min(5),
  name: z.string().min(1),
  birthday: z.string().date().nullable().optional(),
  tgId: z.string().nullable().optional(),
});

const earnSchema = z.object({
  guestId: z.string().uuid(),
  amount: z.number().int().positive(),
  baristaId: z.string().uuid().nullable().optional(),
});

const spendSchema = z.object({
  guestId: z.string().uuid(),
  points: z.number().int().positive(),
  baristaId: z.string().uuid().nullable().optional(),
});

export async function registerRoutes(app: FastifyInstance, service: LoyaltyService): Promise<void> {
  app.get("/health", async () => ({ ok: true }));

  app.post("/api/guests", async (request, reply) => {
    const input = guestRegistrationSchema.parse(request.body);
    const guest = await service.registerGuest(input);
    return reply.code(201).send({ guest });
  });

  app.get("/api/guests/search", async (request) => {
    const query = z
      .object({
        pin: z.string().length(4).optional(),
        phone: z.string().optional(),
        phoneLast4: z.string().length(4).optional(),
      })
      .parse(request.query);
    const guest = await service.searchGuest({
      loyaltyCode: query.pin,
      phone: query.phone,
      phoneLast4: query.phoneLast4,
    });
    return { guest };
  });

  app.get("/api/guests/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const guest = await service.getGuest(id);
    if (!guest) return reply.code(404).send({ error: "Guest not found" });
    return { guest };
  });

  app.get("/api/guests/:id/card.png", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const guest = await service.getGuest(id);
    if (!guest) return reply.code(404).send({ error: "Guest not found" });
    const image = await generateLoyaltyCard(guest);
    return reply.type("image/png").send(image);
  });

  app.get("/api/guests/:id/transactions", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = z.object({ limit: z.coerce.number().int().positive().max(100).default(10) }).parse(request.query);
    const guest = await service.getGuest(id);
    if (!guest) return reply.code(404).send({ error: "Guest not found" });
    const transactions = await service.listTransactions(id, query.limit);
    return { transactions };
  });

  app.post("/api/transactions/earn", async (request) => {
    const input = earnSchema.parse(request.body);
    return service.earn(input);
  });

  app.post("/api/pending-spend", async (request, reply) => {
    const input = spendSchema.parse(request.body);
    const pending = await service.requestSpend(input);
    return reply.code(201).send({ pending });
  });

  app.get("/api/pending-spend/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const pending = await service.getPending(id);
    if (!pending) return reply.code(404).send({ error: "Pending spend not found" });
    return { pending };
  });

  app.post("/api/pending-spend/:id/confirm", async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return service.confirmSpend(id);
  });

  app.post("/api/pending-spend/:id/cancel", async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const pending = await service.cancelSpend(id);
    return { pending };
  });
}
