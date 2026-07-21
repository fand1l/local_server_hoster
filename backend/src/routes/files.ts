import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequestError, NotFoundError } from '../errors.js';
import type { FileService } from '../services/fileService.js';
import type { ServerService } from '../services/serverService.js';

/**
 * API файлового менеджера. Усі шляхи — відносні до кореня теки сервера;
 * безпеку (path traversal) забезпечує FileService. Тут лише валідація вводу
 * та стрімінг завантаження.
 */

const idParamsSchema = z.object({ id: z.string().uuid('Некоректний ідентифікатор сервера') });
const pathQuerySchema = z.object({ path: z.string().max(4096).optional() });

const contentBodySchema = z.object({
  path: z.string().min(1).max(4096),
  content: z.string().max(2 * 1024 * 1024),
});
const mkdirBodySchema = z.object({
  path: z.string().max(4096).optional(),
  name: z.string().min(1).max(200),
});
const renameBodySchema = z.object({
  path: z.string().min(1).max(4096),
  newName: z.string().min(1).max(200),
});

export function registerFileRoutes(
  app: FastifyInstance,
  service: ServerService,
  files: FileService,
): void {
  const mustRecord = (id: string) => {
    const record = service.getRecord(id);
    if (!record) throw new NotFoundError(`Сервер з id=${id} не знайдено`);
    return record;
  };

  app.get('/api/servers/:id/files', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    const { path } = pathQuerySchema.parse(req.query);
    return files.list(mustRecord(id), path ?? '');
  });

  app.get('/api/servers/:id/files/content', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    const { path } = pathQuerySchema.parse(req.query);
    if (!path) throw new BadRequestError('Не вказано шлях до файлу');
    return files.readText(mustRecord(id), path);
  });

  app.put('/api/servers/:id/files/content', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    const { path, content } = contentBodySchema.parse(req.body);
    return files.writeText(mustRecord(id), path, content);
  });

  app.post('/api/servers/:id/files/upload', async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const { path } = pathQuerySchema.parse(req.query);
    const record = mustRecord(id);
    const data = await req.file();
    if (!data) throw new BadRequestError('Файл не надіслано');
    const buffer = await data.toBuffer();
    if (data.file.truncated) throw new BadRequestError('Файл завеликий (ліміт 250 МБ)');
    const entry = files.upload(record, path ?? '', data.filename, buffer);
    return reply.code(201).send(entry);
  });

  app.post('/api/servers/:id/files/mkdir', async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const { path, name } = mkdirBodySchema.parse(req.body);
    return reply.code(201).send(files.mkdir(mustRecord(id), path ?? '', name));
  });

  app.post('/api/servers/:id/files/rename', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    const { path, newName } = renameBodySchema.parse(req.body);
    return files.rename(mustRecord(id), path, newName);
  });

  app.delete('/api/servers/:id/files', async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const { path } = pathQuerySchema.parse(req.query);
    if (!path) throw new BadRequestError('Не вказано шлях');
    files.remove(mustRecord(id), path);
    return reply.code(204).send();
  });

  app.get('/api/servers/:id/files/download', async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const { path } = pathQuerySchema.parse(req.query);
    if (!path) throw new BadRequestError('Не вказано шлях до файлу');
    const { absPath, filename, sizeBytes } = files.resolveForDownload(mustRecord(id), path);

    // RFC 5987: кодуємо ім'я файлу, щоб коректно віддавати кирилицю/пробіли.
    const encoded = encodeURIComponent(filename);
    reply
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encoded}`)
      .header('Content-Length', String(sizeBytes))
      .type('application/octet-stream');
    return reply.send(fs.createReadStream(absPath));
  });
}
