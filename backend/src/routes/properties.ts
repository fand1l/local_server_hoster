import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PROPERTY_KEY_PATTERN } from '../minecraft/properties.js';
import type { ServerService } from '../services/serverService.js';

/**
 * API редагування server.properties.
 * Файл лежить у змонтованій директорії сервера на хості; бекенд парсить його,
 * зберігаючи коментарі та порядок ключів (див. minecraft/properties.ts).
 */

const idParamsSchema = z.object({ id: z.string().uuid('Некоректний ідентифікатор сервера') });

const updateSchema = z.object({
  entries: z
    .array(
      z.object({
        key: z
          .string()
          .min(1)
          .max(64)
          .regex(PROPERTY_KEY_PATTERN, 'Недопустимий ключ properties'),
        value: z.string().max(1024, 'Значення задовге'),
      }),
    )
    .min(1, 'Порожній список змін')
    .max(200, 'Забагато ключів за один запит'),
});

export function registerPropertiesRoutes(app: FastifyInstance, service: ServerService): void {
  app.get('/api/servers/:id/properties', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    return service.getProperties(id);
  });

  app.put('/api/servers/:id/properties', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    const { entries } = updateSchema.parse(req.body);
    return service.updateProperties(id, entries);
  });
}
