import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFoundError } from '../errors.js';
import { PLAYER_NAME_PATTERN, type PlayerService } from '../services/playerService.js';
import type { ServerService } from '../services/serverService.js';
import { PLAYER_ACTIONS } from '../types.js';

/**
 * API керування гравцями. Читання зводить дані з файлів сервера й RCON,
 * дії виконуються командами сервера (RCON із фолбеком у stdin).
 */

const idParamsSchema = z.object({ id: z.string().uuid('Некоректний ідентифікатор сервера') });

const actionSchema = z.object({
  player: z.string().regex(PLAYER_NAME_PATTERN, 'Недопустимий нік гравця'),
  action: z.enum(PLAYER_ACTIONS),
});

export function registerPlayerRoutes(
  app: FastifyInstance,
  service: ServerService,
  players: PlayerService,
): void {
  app.get('/api/servers/:id/players', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    const record = service.getRecord(id);
    if (!record) throw new NotFoundError(`Сервер з id=${id} не знайдено`);
    return players.listPlayers(record);
  });

  app.post('/api/servers/:id/players/action', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    const { player, action } = actionSchema.parse(req.body);
    const record = service.getRecord(id);
    if (!record) throw new NotFoundError(`Сервер з id=${id} не знайдено`);
    return players.performAction(record, player, action);
  });
}
