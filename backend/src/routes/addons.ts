import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequestError, NotFoundError } from '../errors.js';
import type { AddonService } from '../services/addonService.js';
import type { ServerService } from '../services/serverService.js';

/**
 * API плагінів/модів. Файли лежать у змонтованій теці plugins/ або mods/ сервера,
 * тож завантаження — це звичайний multipart-upload, а видалення — видалення файлу.
 */

const idParamsSchema = z.object({ id: z.string().uuid('Некоректний ідентифікатор сервера') });
const fileParamsSchema = z.object({
  id: z.string().uuid('Некоректний ідентифікатор сервера'),
  filename: z.string().min(1).max(200),
});

export function registerAddonRoutes(
  app: FastifyInstance,
  service: ServerService,
  addons: AddonService,
): void {
  app.get('/api/servers/:id/addons', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    const record = service.getRecord(id);
    if (!record) throw new NotFoundError(`Сервер з id=${id} не знайдено`);
    return addons.list(record);
  });

  app.post('/api/servers/:id/addons', async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const record = service.getRecord(id);
    if (!record) throw new NotFoundError(`Сервер з id=${id} не знайдено`);

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
    const record = service.getRecord(id);
    if (!record) throw new NotFoundError(`Сервер з id=${id} не знайдено`);
    await addons.remove(record, decodeURIComponent(filename));
    return reply.code(204).send();
  });
}
