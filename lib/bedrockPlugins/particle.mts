import type { BedrockBot } from '../../index.js';
import { Vec3 } from 'vec3';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// REQ BEDROCK PARTICLES IMPLEMENTATION
export default function inject(bot: BedrockBot) {
  const Particle = require('../particle')(bot.registry);

  bot._client.on('level_event', (packet) => {
    if (packet.event.startsWith('particle')) {
      bot.emit('particle', new Particle(packet.event, packet.position, new Vec3(0, 0, 0)));
    }
  });
  bot._client.on('spawn_particle_effect', (packet) => {
    bot.emit('particle', new Particle(packet.particle_name, packet.position, new Vec3(0, 0, 0)));
  });
}
