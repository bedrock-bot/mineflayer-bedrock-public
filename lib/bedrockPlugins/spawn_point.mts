import type { BedrockBot } from '../../index.js';
import { Vec3 } from 'vec3';

export default function inject(bot: BedrockBot) {
  bot.spawnPoint = new Vec3(0, 0, 0);
  bot._client.on('set_spawn_position', (packet) => {
    if (packet.spawn_type === 'player') {
      bot.spawnPoint = new Vec3(packet.player_position.x, packet.player_position.y, packet.player_position.z);
    }
    // else if (packet.spawn_type === "world") {
    //   if(bot.spawnPoint === new Vec3(0, 0, 0)) {
    //     bot.spawnPoint = new Vec3(packet.world_position.x, packet.world_position.y, packet.world_position.z)
    //   }
    // }
    bot.emit('game');
  });
}
