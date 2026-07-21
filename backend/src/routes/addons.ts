import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequestError, NotFoundError } from '../errors.js';
import type { AddonService } from '../services/addonService.js';
import type { ModrinthService } from '../services/modrinthService.js';
import type { ServerService } from '../services/serverService.js';

/**
 * API плагінів/модів. Файли лежать у змонтованій теці plugins/ або mods/ сервера,
 * тож завантаження свого .jar — звичайний multipart-upload, видалення —
 * видалення файлу, а встановлення з Modrinth — завантаження на бекенді.
 */

const idParamsSchema = z.object({ id: z.string().uuid('Некоректний ідентифікатор сервера') });
const fileParamsSchema = z.object({
  id: z.string().uuid('Некоректний ідентифікатор сервера'),
  filename: z.string().min(1).max(200),
});
const searchQuerySchema = z.object({
  q: z.string().max(120).optional(),
  offset: z.coerce.number().int().min(0).max(1000).optional(),
});
const installBodySchema = z.object({
  // Ідентифікатор або slug проєкту Modrinth (base62-id або a-z0-9-_).
  projectId: z.string().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/, 'Некоректний ідентифікатор проєкту'),
});

export function registerAddonRoutes(
  app: FastifyInstance,
  service: ServerService,
  addons: AddonService,
  modrinth: ModrinthService,
): void {
  const mustRecord = (id: string) => {
    const record = service.getRecord(id);
    if (!record) throw new NotFoundError(`Сервер з id=${id} не знайдено`);
    return record;
  };

  app.get('/api/servers/:id/addons', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    return addons.list(mustRecord(id));
  });

  app.get('/api/servers/:id/addons/search', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    const { q, offset } = searchQuerySchema.parse(req.query);
    return modrinth.search(mustRecord(id), q ?? '', offset ?? 0);
  });

  app.post('/api/servers/:id/addons/install', async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const { projectId } = installBodySchema.parse(req.body);
    const info = await modrinth.install(mustRecord(id), projectId);
    return reply.code(201).send(info);
  });

  app.post('/api/servers/:id/addons', async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const record = mustRecord(id);

    // Один файл на запит (multipart/form-data, поле "file").
    const data = await req.file();
    if (!data) {
      throw new BadRequestError('Файл не надіслано');
    }
    const buffer = await data.toBuffer();
    // Ліміт спрацював під час читання (@fastify/multipart) — повідомляємо явно.
    if (data.file.truncated) {
      throw new BadRequestError('Файл завеликий (ліміт 250 МБ)');
    }
    const info = await addons.install(record, data.filename, buffer);
    return reply.code(201).send(info);
  });

  app.delete('/api/servers/:id/addons/:filename', async (req, reply) => {
    const { id, filename } = fileParamsSchema.parse(req.params);
    await addons.remove(mustRecord(id), decodeURIComponent(filename));
    return reply.code(204).send();
  });
}
