import pg from "pg";
import { assertPositiveInteger, getLevel, normalizePhone } from "../domain/loyalty.js";
import type { Guest, GuestRegistration, PendingTransaction, Transaction } from "../domain/types.js";
import type { LoyaltyStore, SearchGuestInput } from "./store.js";

const { Pool } = pg;

type DbGuest = {
  id: string;
  phone: string;
  loyalty_code: string;
  name: string;
  birthday: string | null;
  total_spent: number;
  balance: number;
  level: Guest["level"];
  last_visit: Date | null;
  tg_id: string | number | null;
  tg_card_message_id: number | null;
  card_updated_at: Date | null;
  created_at: Date;
};

type DbTransaction = {
  id: string;
  guest_id: string;
  type: Transaction["type"];
  amount: number;
  points: number;
  barista_id: string | null;
  created_at: Date;
};

type DbPending = {
  id: string;
  guest_id: string;
  points: number;
  status: PendingTransaction["status"];
  barista_id: string | null;
  expires_at: Date;
  created_at: Date;
};

export class PgStore implements LoyaltyStore {
  private pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async ensureReady(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createOrUpdateGuest(input: GuestRegistration): Promise<Guest> {
    const phone = normalizePhone(input.phone);
    const tgId = input.tgId ?? null;
    const existing = await this.findExistingGuest(phone, tgId);
    if (existing) {
      const result = await this.pool.query<DbGuest>(
        `
        UPDATE guests
        SET phone = $1, name = COALESCE(NULLIF($2, ''), name), birthday = COALESCE($3, birthday), tg_id = COALESCE($4, tg_id)
        WHERE id = $5
        RETURNING *
        `,
        [phone, input.name, input.birthday ?? null, tgId, existing.id],
      );
      return mapGuest(result.rows[0]);
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
      try {
        const result = await this.pool.query<DbGuest>(
          `
          INSERT INTO guests (phone, loyalty_code, name, birthday, tg_id)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING *
          `,
          [phone, code, input.name, input.birthday ?? null, tgId],
        );
        return mapGuest(result.rows[0]);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }

    throw new Error("Could not allocate loyalty PIN");
  }

  async getGuest(id: string): Promise<Guest | null> {
    const result = await this.pool.query<DbGuest>("SELECT * FROM guests WHERE id = $1", [id]);
    return result.rows[0] ? mapGuest(result.rows[0]) : null;
  }

  async getGuestByTelegramId(tgId: string): Promise<Guest | null> {
    const result = await this.pool.query<DbGuest>("SELECT * FROM guests WHERE tg_id = $1", [tgId]);
    return result.rows[0] ? mapGuest(result.rows[0]) : null;
  }

  async searchGuest(input: SearchGuestInput): Promise<Guest | null> {
    const phone = input.phone ? normalizePhone(input.phone) : undefined;
    const result = await this.pool.query<DbGuest>(
      `
      SELECT *
      FROM guests
      WHERE ($1::text IS NOT NULL AND loyalty_code = $1)
         OR ($2::text IS NOT NULL AND phone = $2)
         OR ($3::text IS NOT NULL AND right(phone, 4) = $3)
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [input.loyaltyCode ?? null, phone ?? null, input.phoneLast4 ?? null],
    );
    return result.rows[0] ? mapGuest(result.rows[0]) : null;
  }

  async updateCardTimestamp(guestId: string): Promise<Guest> {
    const result = await this.pool.query<DbGuest>("UPDATE guests SET card_updated_at = now() WHERE id = $1 RETURNING *", [guestId]);
    if (!result.rows[0]) throw new Error("Guest not found");
    return mapGuest(result.rows[0]);
  }

  async updateTelegramCardMessage(guestId: string, messageId: number): Promise<Guest> {
    const result = await this.pool.query<DbGuest>("UPDATE guests SET tg_card_message_id = $1 WHERE id = $2 RETURNING *", [
      messageId,
      guestId,
    ]);
    if (!result.rows[0]) throw new Error("Guest not found");
    return mapGuest(result.rows[0]);
  }

  async earnPoints(input: { guestId: string; amount: number; points: number; baristaId?: string | null }): Promise<{ guest: Guest; transaction: Transaction }> {
    assertPositiveInteger(input.amount, "amount");
    if (!Number.isInteger(input.points) || input.points < 0) throw new Error("points must be a non-negative integer");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const guestResult = await client.query<DbGuest>("SELECT * FROM guests WHERE id = $1 FOR UPDATE", [input.guestId]);
      const current = guestResult.rows[0];
      if (!current) throw new Error("Guest not found");
      const totalSpent = current.total_spent + input.amount;
      const level = getLevel(totalSpent);
      const updatedGuest = await client.query<DbGuest>(
        `
        UPDATE guests
        SET total_spent = $1, balance = balance + $2, level = $3, last_visit = now(), card_updated_at = now()
        WHERE id = $4
        RETURNING *
        `,
        [totalSpent, input.points, level, input.guestId],
      );
      const transaction = await client.query<DbTransaction>(
        `
        INSERT INTO transactions (guest_id, type, amount, points, barista_id)
        VALUES ($1, 'earn', $2, $3, $4)
        RETURNING *
        `,
        [input.guestId, input.amount, input.points, input.baristaId ?? null],
      );
      await client.query("COMMIT");
      return { guest: mapGuest(updatedGuest.rows[0]), transaction: mapTransaction(transaction.rows[0]) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createPendingSpend(input: { guestId: string; points: number; baristaId?: string | null }): Promise<PendingTransaction> {
    assertPositiveInteger(input.points, "points");
    await this.expirePendingTransactions();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const guestResult = await client.query<DbGuest>("SELECT * FROM guests WHERE id = $1 FOR UPDATE", [input.guestId]);
      const guest = guestResult.rows[0];
      if (!guest) throw new Error("Guest not found");
      if (guest.balance < input.points) throw new Error("Not enough points");

      const active = await client.query<DbPending>(
        "SELECT * FROM pending_transactions WHERE guest_id = $1 AND status = 'pending' LIMIT 1",
        [input.guestId],
      );
      if (active.rows[0]) throw new Error("Guest already has an active pending spend");

      const result = await client.query<DbPending>(
        `
        INSERT INTO pending_transactions (guest_id, points, barista_id, expires_at)
        VALUES ($1, $2, $3, now() + interval '2 minutes')
        RETURNING *
        `,
        [input.guestId, input.points, input.baristaId ?? null],
      );
      await client.query("COMMIT");
      return mapPending(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getPending(id: string): Promise<PendingTransaction | null> {
    await this.expirePendingTransactions();
    const result = await this.pool.query<DbPending>("SELECT * FROM pending_transactions WHERE id = $1", [id]);
    return result.rows[0] ? mapPending(result.rows[0]) : null;
  }

  async getActivePendingForGuest(guestId: string): Promise<PendingTransaction | null> {
    await this.expirePendingTransactions();
    const result = await this.pool.query<DbPending>(
      "SELECT * FROM pending_transactions WHERE guest_id = $1 AND status = 'pending' LIMIT 1",
      [guestId],
    );
    return result.rows[0] ? mapPending(result.rows[0]) : null;
  }

  async confirmPending(id: string): Promise<{ guest: Guest; pending: PendingTransaction; transaction: Transaction }> {
    await this.expirePendingTransactions();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const pendingResult = await client.query<DbPending>("SELECT * FROM pending_transactions WHERE id = $1 FOR UPDATE", [id]);
      const pending = pendingResult.rows[0];
      if (!pending || pending.status !== "pending") throw new Error("Pending spend is not active");

      const guestResult = await client.query<DbGuest>("SELECT * FROM guests WHERE id = $1 FOR UPDATE", [pending.guest_id]);
      const guest = guestResult.rows[0];
      if (!guest) throw new Error("Guest not found");
      if (guest.balance < pending.points) throw new Error("Not enough points");

      const updatedGuest = await client.query<DbGuest>(
        "UPDATE guests SET balance = balance - $1, last_visit = now(), card_updated_at = now() WHERE id = $2 RETURNING *",
        [pending.points, pending.guest_id],
      );
      const updatedPending = await client.query<DbPending>(
        "UPDATE pending_transactions SET status = 'confirmed' WHERE id = $1 RETURNING *",
        [id],
      );
      const transaction = await client.query<DbTransaction>(
        `
        INSERT INTO transactions (guest_id, type, amount, points, barista_id)
        VALUES ($1, 'spend', $2, $3, $4)
        RETURNING *
        `,
        [pending.guest_id, pending.points, -pending.points, pending.barista_id],
      );
      await client.query("COMMIT");
      return {
        guest: mapGuest(updatedGuest.rows[0]),
        pending: mapPending(updatedPending.rows[0]),
        transaction: mapTransaction(transaction.rows[0]),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async cancelPending(id: string): Promise<PendingTransaction> {
    const result = await this.pool.query<DbPending>(
      "UPDATE pending_transactions SET status = 'cancelled' WHERE id = $1 AND status = 'pending' RETURNING *",
      [id],
    );
    if (!result.rows[0]) throw new Error("Pending spend is not active");
    return mapPending(result.rows[0]);
  }

  async expirePendingTransactions(): Promise<PendingTransaction[]> {
    const result = await this.pool.query<DbPending>(
      `
      UPDATE pending_transactions
      SET status = 'expired'
      WHERE status = 'pending' AND expires_at <= now()
      RETURNING *
      `,
    );
    return result.rows.map(mapPending);
  }

  async listTransactions(guestId: string, limit: number): Promise<Transaction[]> {
    const result = await this.pool.query<DbTransaction>(
      "SELECT * FROM transactions WHERE guest_id = $1 ORDER BY created_at DESC LIMIT $2",
      [guestId, limit],
    );
    return result.rows.map(mapTransaction);
  }

  private async findExistingGuest(phone: string, tgId: string | null): Promise<Guest | null> {
    const result = await this.pool.query<DbGuest>(
      "SELECT * FROM guests WHERE phone = $1 OR ($2::bigint IS NOT NULL AND tg_id = $2) LIMIT 1",
      [phone, tgId],
    );
    return result.rows[0] ? mapGuest(result.rows[0]) : null;
  }
}

function mapGuest(row: DbGuest): Guest {
  return {
    id: row.id,
    phone: row.phone,
    loyaltyCode: row.loyalty_code,
    name: row.name,
    birthday: row.birthday,
    totalSpent: Number(row.total_spent),
    balance: Number(row.balance),
    level: row.level,
    lastVisit: row.last_visit?.toISOString() ?? null,
    tgId: row.tg_id === null ? null : String(row.tg_id),
    tgCardMessageId: row.tg_card_message_id,
    cardUpdatedAt: row.card_updated_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

function mapTransaction(row: DbTransaction): Transaction {
  return {
    id: row.id,
    guestId: row.guest_id,
    type: row.type,
    amount: Number(row.amount),
    points: Number(row.points),
    baristaId: row.barista_id,
    createdAt: row.created_at.toISOString(),
  };
}

function mapPending(row: DbPending): PendingTransaction {
  return {
    id: row.id,
    guestId: row.guest_id,
    points: Number(row.points),
    status: row.status,
    baristaId: row.barista_id,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
