import { Context, Logger, Schema, Session } from 'koishi';
import { Rcon } from 'rcon-client';

export const name = 'kairos-yunmi';

export let client: Rcon | null = null;
export let logger: Logger;
export let rconServers: rconServer[] = [];
export let selectedServer: rconServer | null = null;

export interface Config {
  rcon: string;
  admin: string;
}

/** Rcon 参数 */
class rconServer {
  constructor(
    public host: string,
    public port: string,
    public password: string,
    public name: string
  ) { }

  toRcon(): Rcon {
    return new Rcon({
      host: this.host,
      port: Number(this.port),
      password: this.password,
    });
  }
}

export const Config: Schema<Config> = Schema.object({
  rcon: Schema.string()
    .description('Rcon 地址, 格式: host:port:password:name::[another]')
    .default('127.0.0.1:25575:password:server1'),
  admin: Schema.string()
    .description('管理员 UserID, 多个管理员用冒号分隔')
    .default(''),
});

export async function apply(ctx: Context, config: Config) {
  logger = ctx.logger('kairos-yunmi');

  /** 初始化 Rcon 服务 */
  ctx.on('ready', () => {
    const servers = config.rcon.split('::');
    servers.forEach((server) => {
      const [host, port, password, name] = server.split(':');
      if (host && port && password && name) {
        rconServers.push(new rconServer(host, port, password, name));
      }
    });

    if (rconServers.length > 0) {
      selectedServer = rconServers[0];
    }
  });

  //** 关闭操作 */
  ctx.on("dispose", () => {
    rconServers = []
    selectedServer = null
    client = null
  })

  /** 获取服务器信息 */
  ctx
    .command('serverinfo <type:text>', '获取服务器信息')
    .example('serverinfo players')
    .action(async ({ session }, type) => {
      if (!type) {
        return sendMessage(session, '需要提供参数。\n示例: serverinfo [players/whitelist]');
      }

      let result: string;
      switch (type) {
        case 'players':
          try {
            result = await rconCommand('list');
          } catch (error) {
            logger.error(error);
            return sendMessage(session, '出现错误，请联系管理员获取帮助。');
          }

          const playerlist = result.split(' ');
          var message = `服务器[${selectedServer.name}]玩家如下:`;

          if (playerlist[2] === '0') {
            return sendMessage(session, `${message}\nNO PLAYER IN SERVER`);
          }

          for (let i = 1; i < playerlist.length - 9; i++) {
            message += `\n${i}. ${playerlist[i + 9].replace(',', '')}`;
            if (i === 15) {
              message += `\n...(${playerlist.length - 15})`;
              break;
            }
          }
          sendMessage(session, message);
          break;

        case 'whitelist':
          if (!isAdmin(session, config)) {
            return sendMessage(session, `您没有权限使用此命令。\nUserID: ${session.userId}`);
          }
          try {
            result = await rconCommand('whitelist list');
          } catch (error) {
            logger.error(error);
            return sendMessage(session, '执行出现错误, 详细内容见日志。');
          }

          const whitelist = result.split(' ');
          message = `服务器[${selectedServer.name}]白名单如下:`;

          if (whitelist[2] === 'no') {
            return sendMessage(session, `${message}\nNO PLAYERS IN WHITELIST`);
          }

          for (let i = 1; i < whitelist.length - 4; i++) {
            message += `\n${i}. ${whitelist[i + 4].replace(',', '')}`;
            if (i === 15) {
              message += `\n...(${whitelist.length - 15})`;
              break;
            }
          }
          sendMessage(session, message);
          break;

        default:
          sendMessage(session, '错误的参数信息。\n示例: serverinfo [players/whitelist]');
      }
    });

  /** 控制 Rcon 服务器 */
  ctx
    .command('rcon <action:text>', '控制 Rcon 服务器')
    .example('rcon list')
    .action(async ({ session }, action) => {
      if (!action) {
        return sendMessage(session, '需要参数。\n示例: rcon [list/check/select]');
      }

      const [cmd, serverName] = action.split(':');
      switch (cmd) {
        case 'list':
          return sendMessage(session, 
            '当前可用服务器:\n' +
            rconServers.map((s) => ` - ${s.name}`).join('\n')
          );
        case 'check':
          if (!isAdmin(session, config)) {
            return sendMessage(session, `您没有权限使用此命令。\nUserID: ${session.userId}`);
          }
          if (!client || !selectedServer) {
            return sendMessage(session, '未配置 Rcon 服务器，请检查配置文件。');
          }
          try {
            await rconCommand('list');
            return sendMessage(session, `服务器 [${selectedServer.name}] 连接正常。`);
          } catch {
            return sendMessage(session, `服务器 [${selectedServer.name}] 连接异常。`);
          }
        case 'select':
          if (!serverName) {
            return sendMessage(session, '需要指定服务器名。\n示例: rcon select:server1');
          }
          const server = rconServers.find(
            (s) => s.name.toLowerCase() === serverName.toLowerCase()
          );
          if (!server) {
            return sendMessage(session, `未找到服务器: ${serverName}`);
          }
          selectedServer = server;
          client = selectedServer.toRcon();
          return sendMessage(session, `已切换到服务器: ${server.name}`);
        default:
          return sendMessage(session, '未知命令。\n示例: rcon [list/check/select]');
      }
    });

    ctx
    .command('whitelist <action:text>', '控制服务器白名单')
    .example('whitelist add:Player001')
    .action(async ({ session }, action) => {
      if (!isAdmin(session, config)) {
        return sendMessage(session, `您没有权限使用此命令。\nUserID: ${session.userId}`);
      }
  
      const [cmd, playerName] = action.split(':');
      if (!cmd || !playerName) {
        return sendMessage(session, '无效语法。\n示例: whitelist [add/remove]:player');
      }
  
      try {
        const result = await rconCommand(`whitelist ${cmd} ${playerName}`);
        return sendMessage(session, `执行成功: ${result}`);
      } catch (error) {
        logger.error(error);
        return sendMessage(session, '执行出错，请查看日志获取更多信息。');
      }
    });

  async function rconCommand(command: string): Promise<string> {
    if (!client) {
      if (!selectedServer) throw new Error('未选择服务器。');
      client = selectedServer.toRcon();
    }
    await client.connect();
    const result = client.send(command);
    client.end();
    return result;
  }

  function isAdmin(session: Session, config: Config): boolean {
    if (!config.admin || !session.userId) return false;
    return config.admin.split(':').includes(session.userId);
  }

  function sendMessage(session: Session, message: string) {
    session.send(`MESSAGE:\n[Yunmi] ${message}`);
  }
}