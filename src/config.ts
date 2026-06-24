import "dotenv/config";

export type AppConfig = {
  port: number;
  host: string;
  databaseUrl?: string;
  telegramBotToken?: string;
  vk?: VkConfig;
  publicBaseUrl?: string;
};

export type VkConfig = {
  accessToken: string;
  groupId: string;
  confirmationToken: string;
  secretKey: string;
  apiVersion: string;
};

export function readConfig(): AppConfig {
  const vk = readVkConfig();
  return {
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? "0.0.0.0",
    databaseUrl: process.env.DATABASE_URL,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    vk,
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
  };
}

function readVkConfig(): VkConfig | undefined {
  const accessToken = process.env.VK_ACCESS_TOKEN;
  const groupId = process.env.VK_GROUP_ID;
  const confirmationToken = process.env.VK_CONFIRMATION_TOKEN;
  const secretKey = process.env.VK_SECRET_KEY;
  if (!accessToken || !groupId || !confirmationToken || !secretKey) return undefined;

  return {
    accessToken,
    groupId,
    confirmationToken,
    secretKey,
    apiVersion: process.env.VK_API_VERSION ?? "5.199",
  };
}
