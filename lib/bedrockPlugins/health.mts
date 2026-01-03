import type { BedrockBot } from '../../index.js';
import { Vec3 } from 'vec3';

interface HealthOptions {
  respawn?: boolean;
}

export default function inject(bot: BedrockBot, options: HealthOptions = {}) {
  bot.isAlive = true;

  // undocumented, bedrock-specific fields
  (bot as any).respawnLocked = true; // lock respawn before player initialized
  (bot as any).awaitingRespawn = false; // used to prevent double events
  (bot as any).respawnQueued = false; // used to prevent sending multiple respawn packets
  (bot as any).spawned = false; // keep track of spawned state
  (bot as any).deathHandled = false;

  bot._client.on('respawn', (packet) => {
    if (packet.state === 0 && !(bot as any).awaitingRespawn && !(bot as any).respawnLocked) {
      // respawn avaliable
      (bot as any).awaitingRespawn = true;
      bot.emit('respawn');
    }
    if (packet.state === 1) {
      // ready state
      bot.entity.position = new Vec3(packet.position.x, packet.position.y, packet.position.z);
      (bot as any).respawnQueued = false;
    }
  });

  bot._client.on('play_status', (packet) => {
    // after login
    if (packet.status === 'player_spawn') {
      (bot as any).respawnLocked = false;
      handleSpawn();
      bot.emit('entitySpawn', bot.entity);
    }
  });

  bot._client.on('entity_event', (packet) => {
    // after respawn button press
    if (packet.runtime_entity_id !== bot.entity.id) return;
    if (packet.event_id === 'death_animation') {
      handleDeath();
    }
    if (packet.event_id === 'respawn') {
      handleSpawn();
    }
  });

  bot._client.on('set_health', (packet) => {
    bot.health = packet.health;
    bot.food = 20;
    bot.foodSaturation = 5;
    if (packet.health > 0) {
      handleSpawn();
    }
    bot.emit('health');
  });

  bot.on('entityAttributes', (entity) => {
    if (entity !== bot.entity) return;
    if (!entity.attributes) return;

    if ('minecraft:player.hunger' in entity.attributes) {
      bot.food = entity.attributes['minecraft:player.hunger'].value;
    }

    if ('minecraft:player.saturation' in entity.attributes) {
      bot.foodSaturation = entity.attributes['minecraft:player.saturation'].value;
    }

    let health_changed = false;

    if ('minecraft:health' in entity.attributes) {
      health_changed = bot.health !== entity.attributes['minecraft:health'].value;
      bot.health = entity.attributes['minecraft:health'].value;
    }

    if (health_changed) {
      bot.emit('health');
    }

    if (bot.health <= 0) {
      if (bot.isAlive) {
        handleDeath();
        if (options.respawn) {
          respawn();
        }
      }
    } else if (bot.health > 0 && !bot.isAlive) {
      handleSpawn();
    }
  });

  function handleSpawn() {
    if (!(bot as any).spawned && ((bot as any).awaitingRespawn || (bot as any).respawnLocked)) {
      (bot as any).awaitingRespawn = false;
      bot.isAlive = true;
      (bot as any).spawned = true;
      (bot as any).deathHandled = false;
      bot.emit('spawn');
    }
  }

  function handleDeath() {
    if (!(bot as any).deathHandled) {
      bot.isAlive = false;
      (bot as any).spawned = false;
      (bot as any).deathHandled = true;
      bot.emit('death');
    }
  }

  const respawn = () => {
    if (bot.isAlive) return;
    if ((bot as any).respawnQueued) return;
    bot._client.write('respawn', {
      position: {
        x: 0,
        y: 0,
        z: 0,
      },
      state: 2,
      runtime_entity_id: bot.entity.id,
    });
    (bot as any).respawnQueued = true;
  };

  bot.respawn = respawn;
}
