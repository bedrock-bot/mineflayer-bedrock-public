import type { BedrockBot } from '../../index.js';

function longToBigInt(arr: bigint | number | number[]): bigint {
  if (typeof arr === 'bigint') return arr;
  if (typeof arr === 'number') return BigInt(arr);
  if (Array.isArray(arr)) {
    return BigInt.asIntN(64, BigInt(arr[0]) << 32n) | BigInt(arr[1]);
  }
  return 0n;
}

export default function inject(bot: BedrockBot) {
  bot.time = {
    doDaylightCycle: null,
    bigTime: null,
    time: null,
    timeOfDay: null,
    day: null,
    isDay: null,
    moonPhase: null,
    bigAge: null,
    age: null,
  };

  // Initialize age from start_game.current_tick (world tick count)
  bot._client.on('start_game', (packet) => {
    if (packet.current_tick != null) {
      const age = longToBigInt(packet.current_tick);
      bot.time.bigAge = age;
      bot.time.age = Number(age);
    }
  });

  // Update age from tick_sync.response_time (server's current tick)
  bot._client.on('tick_sync', (packet) => {
    if (packet.response_time != null && packet.response_time !== 0n) {
      const age = BigInt(packet.response_time);
      bot.time.bigAge = age;
      bot.time.age = Number(age);
    }
  });

  bot._client.on('set_time', (packet) => {
    let time = BigInt(packet.time);

    if (time < 0n) {
      bot.time.doDaylightCycle = false;
      time = -time;
    } else {
      bot.time.doDaylightCycle = true;
    }

    bot.time.bigTime = time;
    bot.time.time = Number(time);
    bot.time.timeOfDay = bot.time.time % 24000;
    bot.time.day = Math.floor(bot.time.time / 24000);
    // Match Java: isDay when timeOfDay is in range [0, 13000)
    bot.time.isDay = bot.time.timeOfDay >= 0 && bot.time.timeOfDay < 13000;
    bot.time.moonPhase = bot.time.day % 8;

    bot.emit('time');
  });
}
