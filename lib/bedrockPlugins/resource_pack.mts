import type { BedrockBot } from '../../index.js';
import assert from 'assert';

export default function inject(bot: BedrockBot) {
  function acceptResourcePack() {
    assert(false, 'Not supported');
  }

  function denyResourcePack() {
    assert(false, 'Not supported');
  }

  bot.acceptResourcePack = acceptResourcePack;
  bot.denyResourcePack = denyResourcePack;
}
