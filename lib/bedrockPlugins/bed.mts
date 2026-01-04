import type { Bot } from '../..'
import type { Block } from 'prismarine-block'
import { Vec3 } from 'vec3'

export default function inject(bot: Bot) {
  bot.isSleeping = false

  // All bed block names in Bedrock Edition
  const beds = new Set([
    'white_bed', 'orange_bed', 'magenta_bed', 'light_blue_bed',
    'yellow_bed', 'lime_bed', 'pink_bed', 'gray_bed',
    'light_gray_bed', 'cyan_bed', 'purple_bed', 'blue_bed',
    'brown_bed', 'green_bed', 'red_bed', 'black_bed', 'bed'
  ])

  // Bedrock direction: 0=south, 1=west, 2=north, 3=east
  // Maps to offset from foot to head
  const DIRECTION_OFFSETS: Record<number, Vec3> = {
    0: new Vec3(0, 0, 1),   // south (+Z)
    1: new Vec3(-1, 0, 0),  // west (-X)
    2: new Vec3(0, 0, -1),  // north (-Z)
    3: new Vec3(1, 0, 0),   // east (+X)
  }

  function isABed(block: Block): boolean {
    return beds.has(block.name)
  }

  interface BedMetadata {
    part: boolean      // true: head, false: foot
    occupied: boolean
    facing: number     // 0: south, 1: west, 2: north, 3: east
    headOffset: Vec3   // offset from foot to head
  }

  function parseBedMetadata(bedBlock: Block): BedMetadata {
    const metadata: BedMetadata = {
      part: false,
      occupied: false,
      facing: 0,
      headOffset: new Vec3(0, 0, 1)
    }

    // Bedrock uses _properties for block state
    const props = (bedBlock as any)._properties
    if (props) {
      // direction: 0=south, 1=west, 2=north, 3=east
      metadata.facing = props.direction ?? props['minecraft:direction'] ?? 0
      // head_piece_bit: true for head, false for foot
      metadata.part = props.head_piece_bit === true || props.head_piece_bit === 1
      // occupied_bit: true if someone is in the bed
      metadata.occupied = props.occupied_bit === true || props.occupied_bit === 1
      // Calculate head offset based on direction
      metadata.headOffset = DIRECTION_OFFSETS[metadata.facing] || new Vec3(0, 0, 1)
    }

    return metadata
  }

  async function wake(): Promise<void> {
    if (!bot.isSleeping) {
      throw new Error('already awake')
    }

    // Bedrock uses player_action packet with stop_sleeping action
    bot._client.write('player_action', {
      runtime_entity_id: bot.entity.id,
      action: 'stop_sleeping',
      position: { x: 0, y: 0, z: 0 },
      result_position: { x: 0, y: 0, z: 0 },
      face: 0
    })
  }

  async function sleep(bedBlock: Block): Promise<void> {
    const thunderstorm = bot.isRaining && (bot.thunderState > 0)
    if (!thunderstorm && !(bot.time.timeOfDay >= 12541 && bot.time.timeOfDay <= 23458)) {
      throw new Error("it's not night and it's not a thunderstorm")
    }
    if (bot.isSleeping) {
      throw new Error('already sleeping')
    }
    if (!isABed(bedBlock)) {
      throw new Error('wrong block : not a bed block')
    }

    const botPos = bot.entity.position.floored()
    const metadata = parseBedMetadata(bedBlock)
    let headPoint = bedBlock.position

    if (metadata.occupied) {
      throw new Error('the bed is occupied')
    }

    if (!metadata.part) {
      // This is the foot part, find the head
      const upperBlock = bot.blockAt(bedBlock.position.plus(metadata.headOffset))

      if (upperBlock && isABed(upperBlock)) {
        headPoint = upperBlock.position
      } else {
        // Try the opposite direction
        const lowerBlock = bot.blockAt(bedBlock.position.plus(metadata.headOffset.scaled(-1)))

        if (lowerBlock && isABed(lowerBlock)) {
          // If there are 2 foot parts, minecraft only lets you sleep if you click on the lower one
          headPoint = bedBlock.position
          bedBlock = lowerBlock
        } else {
          throw new Error("there's only half bed")
        }
      }
    }

    if (!bot.canDigBlock(bedBlock)) {
      throw new Error('cant click the bed')
    }

    // Check distance constraints
    const clickRange = [2, -3, -3, 2] // [south, west, north, east]
    const monsterRange = [7, -8, -8, 7]
    const oppositeCardinal = (metadata.facing + 2) % 4

    if (clickRange[oppositeCardinal] < 0) {
      clickRange[oppositeCardinal]--
    } else {
      clickRange[oppositeCardinal]++
    }

    const nwClickCorner = headPoint.offset(clickRange[1], -2, clickRange[2])
    const seClickCorner = headPoint.offset(clickRange[3], 2, clickRange[0])
    if (
      botPos.x > seClickCorner.x || botPos.x < nwClickCorner.x ||
      botPos.y > seClickCorner.y || botPos.y < nwClickCorner.y ||
      botPos.z > seClickCorner.z || botPos.z < nwClickCorner.z
    ) {
      throw new Error('the bed is too far')
    }

    // Check for monsters nearby (unless creative mode)
    if (bot.game.gameMode !== 'creative') {
      const nwMonsterCorner = headPoint.offset(monsterRange[1], -6, monsterRange[2])
      const seMonsterCorner = headPoint.offset(monsterRange[3], 4, monsterRange[0])

      for (const key of Object.keys(bot.entities)) {
        const entity = bot.entities[key]
        if (entity.kind === 'Hostile mobs') {
          const entityPos = entity.position.floored()
          if (
            entityPos.x <= seMonsterCorner.x && entityPos.x >= nwMonsterCorner.x &&
            entityPos.y <= seMonsterCorner.y && entityPos.y >= nwMonsterCorner.y &&
            entityPos.z <= seMonsterCorner.z && entityPos.z >= nwMonsterCorner.z
          ) {
            throw new Error('there are monsters nearby')
          }
        }
      }
    }

    // Register listener before activating to avoid race conditions
    const waitingPromise = waitUntilSleep()
    await bot.activateBlock(bedBlock)
    await waitingPromise
  }

  async function waitUntilSleep(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutForSleep = setTimeout(() => {
        reject(new Error('bot is not sleeping'))
      }, 3000)

      bot.once('sleep', () => {
        clearTimeout(timeoutForSleep)
        resolve()
      })
    })
  }

  // Handle animate packet for wake_up action
  bot._client.on('animate', (packet: { action: string; runtime_entity_id?: any; entity_id?: any }) => {
    if (packet.action === 'wake_up') {
      const entityId = packet.runtime_entity_id ?? packet.entity_id
      if (entityId === bot.entity.id) {
        bot.isSleeping = false
        bot.emit('wake')
      } else {
        // Another entity woke up
        const entity = bot.entities[entityId]
        if (entity) {
          bot.emit('entityWake', entity)
        }
      }
    }
  })

  // Handle player_action for sleep detection
  // Note: The client sends start_sleeping after server confirms bed interaction
  // We track this via the server's response (occupied bit change or move to bed position)
  bot._client.on('player_action', (packet: { action: string; runtime_entity_id?: any }) => {
    if (packet.action === 'start_sleeping' && packet.runtime_entity_id === bot.entity.id) {
      bot.isSleeping = true
      bot.emit('sleep')
    }
  })

  // Handle set_spawn_position for spawnReset event
  // This is emitted when player can't spawn at their bed (bed destroyed, obstructed)
  // In Bedrock, we track this via set_spawn_position with specific values
  bot._client.on('set_spawn_position', (packet: {
    spawn_type: string
    player_position?: { x: number; y: number; z: number }
    world_position?: { x: number; y: number; z: number }
  }) => {
    // When spawn type is 'player' and position is invalid (very large negative values),
    // it indicates spawn reset
    if (packet.spawn_type === 'player') {
      const pos = packet.player_position
      if (pos && (pos.x === -2147483648 || pos.y === -2147483648 || pos.z === -2147483648)) {
        bot.emit('spawnReset')
      }
    }
  })

  // Expose API
  bot.parseBedMetadata = parseBedMetadata
  bot.wake = wake
  bot.sleep = sleep
  bot.isABed = isABed
}
