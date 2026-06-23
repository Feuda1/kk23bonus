import "dotenv/config";

export type AppConfig = {
  port: number;
  host: string;
  databaseUrl?: string;
  telegramBotToken?: string;
  publicBaseUrl?: string;
};

export function readConfig(): AppConfig {
  return {
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? "0.0.0.0",
    databaseUrl: process.env.DATABASE_URL,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
  };
}
