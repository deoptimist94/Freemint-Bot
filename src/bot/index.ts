import { Bot } from "grammy";
import {
  startCommand,
  helpCommand,
  whoisCommand,
  bypassCommand,
  handleCallback,
  handleText,
} from "./handlers.js";

export function createBot(): Bot {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    throw new Error(
      "BOT_TOKEN is not set. Provide your Telegram bot token in the environment."
    );
  }

  const bot = new Bot(token);

  bot.command("start", startCommand);
  bot.command("help", helpCommand);
  bot.command("whois", whoisCommand);
  bot.command("bypass", bypassCommand);

  bot.on("callback_query:data", handleCallback);
  bot.on("message:text", handleText);

  bot.catch((err) => {
    console.error("Bot error:", err.error);
  });

  return bot;
}
