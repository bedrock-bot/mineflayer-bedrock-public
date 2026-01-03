import type { BedrockBot } from '../../index.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const USERNAME_REGEX = '(?:\\(.{1,15}\\)|\\[.{1,15}\\]|.){0,5}?(\\w+)';
const LEGACY_VANILLA_CHAT_REGEX = new RegExp(`^${USERNAME_REGEX}\\s?[>:\\-»\\]\\)~]+\\s(.*)$`);

interface ChatPattern {
  name: string;
  patterns: RegExp[];
  position: number;
  matches: string[];
  messages: any[];
  deprecated?: boolean;
  repeat: boolean;
  parse: boolean;
}

interface ChatOptions {
  chatLengthLimit?: number;
  defaultChatPatterns?: boolean;
}

export default function inject(bot: BedrockBot, options: ChatOptions = {}) {
  const CHAT_LENGTH_LIMIT = options.chatLengthLimit ?? (bot.supportFeature('lessCharsInChat') ? 100 : 256);
  const defaultChatPatterns = options.defaultChatPatterns ?? true;

  const ChatMessage = require('prismarine-chat')(bot.registry);

  const _patterns: Record<number, ChatPattern | undefined> = {};
  let _length = 0;

  // deprecated
  bot.chatAddPattern = (patternValue: RegExp, typeValue: string) => {
    return bot.addChatPattern(typeValue, patternValue, { deprecated: true });
  };

  bot.addChatPatternSet = (name: string, patterns: RegExp[], opts: { repeat?: boolean; parse?: boolean } = {}) => {
    if (!patterns.every((p) => p instanceof RegExp)) throw new Error('Pattern parameter should be of type RegExp');
    const { repeat = true, parse = false } = opts;
    _patterns[_length++] = {
      name,
      patterns,
      position: 0,
      matches: [],
      messages: [],
      repeat,
      parse,
    };
    return _length;
  };

  bot.addChatPattern = (name: string, pattern: RegExp, opts: { repeat?: boolean; deprecated?: boolean; parse?: boolean } = {}) => {
    if (!(pattern instanceof RegExp)) throw new Error('Pattern parameter should be of type RegExp');
    const { repeat = true, deprecated = false, parse = false } = opts;
    _patterns[_length] = {
      name,
      patterns: [pattern],
      position: 0,
      matches: [],
      messages: [],
      deprecated,
      repeat,
      parse,
    };
    return _length++;
  };

  bot.removeChatPattern = (name: string | number) => {
    if (typeof name === 'number') {
      _patterns[name] = undefined;
    } else {
      const matchingPatterns = Object.entries(_patterns).filter((pattern) => pattern[1]?.name === name);
      matchingPatterns.forEach(([indexString]) => {
        _patterns[+indexString] = undefined;
      });
    }
  };

  function findMatchingPatterns(msg: string): number[] {
    const found: number[] = [];
    for (const [indexString, pattern] of Object.entries(_patterns)) {
      if (!pattern) continue;
      const { position, patterns } = pattern;
      if (patterns[position].test(msg)) {
        found.push(+indexString);
      }
    }
    return found;
  }

  bot.on('messagestr', (msg: string, _: any, originalMsg: any) => {
    const foundPatterns = findMatchingPatterns(msg);

    for (const ix of foundPatterns) {
      const pattern = _patterns[ix];
      if (!pattern) continue;

      pattern.matches.push(msg);
      pattern.messages.push(originalMsg);
      pattern.position++;

      if (pattern.deprecated) {
        const matchResult = pattern.matches[0].match(pattern.patterns[0]);
        if (matchResult) {
          const [, ...matches] = matchResult;
          (bot.emit as any)(pattern.name, ...matches, pattern.messages[0]?.translate, ...pattern.messages);
        }
        pattern.messages = [];
      } else {
        if (pattern.patterns.length > pattern.matches.length) continue;
        if (pattern.parse) {
          const matches = pattern.patterns.map((p, i) => {
            const matchResult = pattern.matches[i].match(p);
            if (matchResult) {
              const [, ...m] = matchResult;
              return m;
            }
            return [];
          });

          bot.emit(`chat:${pattern.name}` as `chat:${string}`, matches);
        } else {
          (bot.emit as any)(`chat:${pattern.name}`, pattern.matches);
        }
      }

      if (_patterns[ix]?.repeat) {
        _patterns[ix]!.position = 0;
        _patterns[ix]!.matches = [];
      } else {
        _patterns[ix] = undefined;
      }
    }
  });

  addDefaultPatterns();

  // Handle incoming text packets
  bot._client.on('text', (data) => {
    let msg: any;

    if (data.type === 'translation') {
      // Handle translation messages with parameters
      const params: string[] = [];
      if (data.parameters) {
        for (const param of data.parameters) {
          if (typeof param === 'string' && param.startsWith('%') && bot.registry.language[param.substring(1)] != null) {
            params.push(bot.registry.language[param.substring(1)]);
          } else {
            params.push(param);
          }
        }
      }
      msg = new ChatMessage({ translate: data.message, with: params });
    } else if (['json', 'json_whisper', 'json_announcement'].includes(data.type)) {
      // Handle JSON/tellraw messages (Bedrock uses rawtext format)
      try {
        const jsonContent = (data.message || '').trim();
        if (jsonContent) {
          const parsed = typeof jsonContent === 'string' ? JSON.parse(jsonContent) : jsonContent;
          // Convert Bedrock rawtext format to Java-compatible format
          if (parsed.rawtext && Array.isArray(parsed.rawtext)) {
            // Convert rawtext array to extra array format that prismarine-chat understands
            const converted = {
              text: '',
              extra: parsed.rawtext.map((item: any) => {
                if (typeof item === 'string') return { text: item };
                if (item.text) return { text: item.text };
                if (item.translate) return { translate: item.translate, with: item.with };
                if (item.selector) return { text: item.selector }; // Simplified selector handling
                if (item.score) return { text: `${item.score.name}:${item.score.objective}` };
                return item;
              }),
            };
            msg = new ChatMessage(converted);
          } else {
            msg = new ChatMessage(parsed);
          }
        } else {
          msg = new ChatMessage({ text: '' });
        }
      } catch (e) {
        // If JSON parsing fails, treat as plain text
        msg = ChatMessage.fromNotch(data.message || '');
      }
    } else {
      // Handle regular text messages
      msg = ChatMessage.fromNotch(data.message || '');
    }

    if (['chat', 'whisper', 'announcement', 'json_whisper', 'json_announcement'].includes(data.type)) {
      (bot.emit as any)('message', msg, 'chat', data.source_name, null);
      (bot.emit as any)('messagestr', msg.toString(), data.type, msg, data.source_name, null);
    } else if (['popup', 'jukebox_popup'].includes(data.type)) {
      (bot.emit as any)('actionBar', msg, null);
    } else if (data.type === 'json') {
      // JSON messages are system/server messages
      (bot.emit as any)('message', msg, 'system', null);
      (bot.emit as any)('messagestr', msg.toString(), 'system', msg, null);
    } else {
      (bot.emit as any)('message', msg, data.type, null);
      (bot.emit as any)('messagestr', msg.toString(), data.type, msg, null);
    }
  });

  function chatWithHeader(message: string | number) {
    if (typeof message === 'number') message = message.toString();
    if (typeof message !== 'string') {
      throw new Error('Chat message type must be a string or number: ' + typeof message);
    }

    if (message.startsWith('/')) {
      // Send command via command_request packet (updated for 1.21.130)
      // Based on real client packet capture - command includes the leading slash
      const client = bot._client as any;
      bot._client.write('command_request', {
        command: message, // Keep the leading slash - real client sends it
        origin: {
          type: 'player',
          uuid: client.profile?.uuid || bot.player?.uuid || '',
          request_id: '',
          player_entity_id: 0n,
        },
        internal: false,
        version: 'latest',
      } as any);
      return;
    }

    const lengthLimit = CHAT_LENGTH_LIMIT;
    const client = bot._client as any;

    message.split('\n').forEach((subMessage) => {
      if (!subMessage) return;
      for (let i = 0; i < subMessage.length; i += lengthLimit) {
        const smallMsg = subMessage.substring(i, i + lengthLimit);

        // Construct the text packet with category 'authored' for client-to-server chat
        // Updated for 1.21.130 format
        bot._client.write('text', {
          needs_translation: false,
          category: 'authored',
          chat: 'chat',
          type: 'chat',
          whisper: 'whisper',
          announcement: 'announcement',
          source_name: client.username || '',
          message: smallMsg,
          xuid: '',
          platform_chat_id: '',
          has_filtered_message: false,
        } as any);
      }
    });
  }

  async function tabComplete(text: string, assumeCommand = false, sendBlockInSight = true, timeout = 5000): Promise<string[]> {
    // Tab completion is not implemented for Bedrock Edition
    // Bedrock uses a different command system that doesn't support client-side tab completion
    console.warn('tabComplete is not implemented for Bedrock Edition');
    return [];
  }

  bot.whisper = (username: string, message: string) => {
    chatWithHeader(`/tell ${username} ${message}`);
  };

  bot.chat = (message: string) => {
    chatWithHeader(message);
  };

  bot.tabComplete = tabComplete;

  function addDefaultPatterns() {
    if (!defaultChatPatterns) return;
    bot.addChatPattern('whisper', new RegExp(`^${USERNAME_REGEX} whispers(?: to you)?:? (.*)$`), {
      deprecated: true,
    });
    bot.addChatPattern('whisper', new RegExp(`^\\[${USERNAME_REGEX} -> \\w+\\s?\\] (.*)$`), {
      deprecated: true,
    });
    bot.addChatPattern('chat', LEGACY_VANILLA_CHAT_REGEX, { deprecated: true });
  }

  function awaitMessage(...args: (string | RegExp | (string | RegExp)[])[]): Promise<string> {
    return new Promise((resolve) => {
      const resolveMessages = args.flatMap((x) => x);
      function messageListener(msg: string) {
        if (resolveMessages.some((x) => (x instanceof RegExp ? x.test(msg) : msg === x))) {
          resolve(msg);
          bot.off('messagestr', messageListener);
        }
      }
      bot.on('messagestr', messageListener);
    });
  }
  bot.awaitMessage = awaitMessage;
}
