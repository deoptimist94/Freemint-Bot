import { prisma } from "../db/client.js";

export interface BotStats {
  totalUsers: number;
  totalWallets: number;
  totalMints: number;
}

export async function getBotStats(): Promise<BotStats> {
  const [totalUsers, totalWallets, totalMints] = await Promise.all([
    prisma.user.count(),
    prisma.wallet.count(),
    prisma.mintHistory.count(),
  ]);
  return { totalUsers, totalWallets, totalMints };
}

export function formatStatsLine(stats: BotStats): string {
  return (
    `👥 ${stats.totalUsers.toLocaleString()} users · ` +
    `👛 ${stats.totalWallets.toLocaleString()} wallets · ` +
    `🚀 ${stats.totalMints.toLocaleString()} mints`
  );
}
