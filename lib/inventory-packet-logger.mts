/**
 * Interface for packet logging. Implement this to create custom packet loggers.
 */
export interface IPacketLogger {
  /**
   * Log a packet
   * @param direction 'C' for client->server, 'S' for server->client
   * @param name Packet name
   * @param packet Packet data
   */
  log(direction: 'C' | 'S', name: string, packet: any): void;

  /**
   * Attach logger to a bot's client
   * @param client The bot._client instance
   */
  attachToBot(client: any): void;

  /**
   * Set the registry for item name resolution
   * @param registry The bot.registry instance
   */
  setRegistry?(registry: any): void;

  /**
   * Log a custom message/event for debugging
   * @param msg Message text
   * @param data Optional additional data
   */
  message?(msg: string, data?: Record<string, any>): void;

  /**
   * Close the logger and flush any pending writes
   */
  close(): void;
}
