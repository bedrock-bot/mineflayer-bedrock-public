import type { BedrockBot } from '../../index.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

export default function inject(bot: BedrockBot) {
  const ChatMessage = require('prismarine-chat')(bot.registry);

  bot.tablist = {
    header: new ChatMessage(''),
    footer: new ChatMessage(''),
  };
}
