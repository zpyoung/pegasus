/**
 * Claude Usage types for CLI-based usage tracking
 */

export type ClaudeUsage = {
  sessionTokensUsed: number;
  sessionLimit: number;
  sessionPercentage: number;
  sessionResetTime: string; // ISO date string
  sessionResetText: string; // Raw text like "Resets 10:59am (Asia/Dubai)"

  weeklyTokensUsed: number;
  weeklyLimit: number;
  weeklyPercentage: number;
  weeklyResetTime: string; // ISO date string
  weeklyResetText: string; // Raw text like "Resets Dec 22 at 7:59pm (Asia/Dubai)"

  sonnetWeeklyTokensUsed: number;
  sonnetWeeklyPercentage: number;
  sonnetResetText: string; // Raw text like "Resets Dec 27 at 9:59am (Asia/Dubai)"

  costUsed: number | null;
  costLimit: number | null;
  costCurrency: string | null;

  lastUpdated: string; // ISO date string
  userTimezone: string;
};

export type ClaudeStatus = {
  indicator: {
    color: "green" | "yellow" | "orange" | "red" | "gray";
  };
  description: string;
};
