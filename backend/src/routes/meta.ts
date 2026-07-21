import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { VersionCatalog } from '../minecraft/versionCatalog.js';
import { SERVER_KINDS } from '../types.js';

/**
 * Метадані для майстра створення сервера:
 *  - список версій гри під обране ядро;
 *  - список версій ядра (білди Paper / лоадери Fabric) під обрану версію гри.
 * Дані тягнуться з офіційних API з кешем; без мережі — вбудований fallback
 * (source у відповіді каже фронтенду, чи можна довіряти списку як повному).
 */

const kindQuerySchema = z.object({
  kind: z.enum(SERVER_KINDS),
});

const coreQuerySchema = z.object({
  kind: z.enum(SERVER_KINDS),
  version: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z0-9._-]+$/, 'Недопустимий формат версії'),
});

export function registerMetaRoutes(app: FastifyInstance, catalog: VersionCatalog): void {
  app.get('/api/meta/versions', async (req) => {
    const { kind } = kindQuerySchema.parse(req.query);
    return catalog.gameVersions(kind);
  });

  app.get('/api/meta/core-versions', async (req) => {
    const { kind, version } = coreQuerySchema.parse(req.query);
    return catalog.coreVersions(kind, version);
  });

  // Чи доступна автопрегенерація Chunky для цього ядра+версії (перевірка Modrinth).
  app.get('/api/meta/pregen', async (req) => {
    const { kind, version } = coreQuerySchema.parse(req.query);
    return catalog.chunkyAvailability(kind, version);
  });
}
