import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import type { ConsoleGateway } from '../docker/consoleGateway.js';
import { AppError } from '../errors.js';
import type { ServerService } from '../services/serverService.js';
import type { ConsoleClientMessage, ConsoleServerMessage } from '../types.js';

/**
 * WebSocket-роут інтерактивної консолі: GET /api/servers/:id/console (Upgrade).
 *
 * Сервер → клієнт: {type:'log'|'info'|'error'|'status', ...} (див. types.ts).
 * Клієнт → сервер: {type:'command', data:'say Привіт'} — команда у stdin сервера.
 */

interface ConsoleRouteDeps {
  service: ServerService;
  gateway: ConsoleGateway;
}

/** Кастомний код закриття: сервер не існує (діапазон 4000–4999 — прикладний). */
const WS_CLOSE_NOT_FOUND = 4404;

function send(socket: WebSocket, message: ConsoleServerMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function rawDataToString(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return raw.toString('utf8');
}

export function registerConsoleRoute(app: FastifyInstance, deps: ConsoleRouteDeps): void {
  app.get<{ Params: { id: string } }>(
    '/api/servers/:id/console',
    { websocket: true },
    (socket: WebSocket, req: FastifyRequest<{ Params: { id: string } }>) => {
      const serverId = req.params.id;
      const record = deps.service.getRecord(serverId);
      if (!record) {
        send(socket, { type: 'error', message: 'Сервер не знайдено' });
        socket.close(WS_CLOSE_NOT_FOUND, 'Server not found');
        return;
      }

      deps.gateway.subscribe(record, socket).catch((err) => {
        req.log.error(`Помилка підписки на консоль ${serverId}: ${err}`);
        send(socket, { type: 'error', message: 'Не вдалося підключитися до консолі сервера' });
      });

      socket.on('message', (raw: RawData) => {
        void handleClientMessage(raw);
      });
      socket.on('error', (err: Error) => {
        req.log.warn(`WS-помилка консолі ${serverId}: ${err.message}`);
      });
      socket.on('close', () => {
        deps.gateway.unsubscribe(serverId, socket);
      });

      async function handleClientMessage(raw: RawData): Promise<void> {
        let message: ConsoleClientMessage;
        try {
          message = JSON.parse(rawDataToString(raw)) as ConsoleClientMessage;
        } catch {
          send(socket, { type: 'error', message: 'Некоректне повідомлення (очікується JSON)' });
          return;
        }
        if (message?.type !== 'command' || typeof message.data !== 'string') {
          send(socket, { type: 'error', message: 'Невідомий тип повідомлення' });
          return;
        }

        // Перечитуємо запис: сервер могли видалити, поки консоль була відкрита.
        const fresh = deps.service.getRecord(serverId);
        if (!fresh) {
          send(socket, { type: 'error', message: 'Сервер уже видалено' });
          socket.close(WS_CLOSE_NOT_FOUND, 'Server deleted');
          return;
        }

        try {
          await deps.gateway.sendCommand(fresh, message.data);
        } catch (err) {
          send(socket, {
            type: 'error',
            message: err instanceof AppError ? err.message : 'Не вдалося надіслати команду',
          });
        }
      }
    },
  );
}
