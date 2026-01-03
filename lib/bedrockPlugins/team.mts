import type { BedrockBot } from '../../index.js';

export default function inject(bot: BedrockBot) {
  // Unsupported in bedrock
  bot.teams = {};
  bot.teamMap = {};
}
