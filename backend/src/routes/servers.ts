import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerService } from '../services/serverService.js';
import { SERVER_KINDS } from '../types.js';

/**
 * REST API керування серверами (CRUD + життєвий цикл).
 * Валідація вхідних даних — zod; помилки схем перетворюються на 400
 * у глобальному error handler (див. app.ts).
 */

const idParamsSchema = z.object({ id: z.string().uuid('Некоректний ідентифікатор сервера') });

const createServerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Ім'я не може бути порожнім")
    .max(40, "Ім'я задовге (до 40 символів)")
    .regex(/^[\p{L}\p{N} _.'-]+$/u, "Ім'я містить недопустимі символи"),
  kind: z.enum(SERVER_KINDS),
  version: z
    .string()
    .trim()
    .min(1, 'Вкажіть версію (наприклад, 26.2 або 1.21.8)')
    .max(32)
    .regex(/^[A-Za-z0-9._-]+$/, 'Недопустимий формат версії'),
  coreVersion: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z0-9._+-]+$/, 'Недопустимий формат версії ядра')
    .optional(),
  hostPort: z
    .number({ invalid_type_error: 'Порт має бути числом' })
    .int()
    .min(1024, 'Використовуйте порти від 1024')
    .max(65535, 'Порт має бути не більшим за 65535'),
  memoryMb: z
    .number({ invalid_type_error: "Об'єм пам'яті має бути числом" })
    .int()
    .min(512, "Мінімум 512 МБ пам'яті")
    .max(1024 * 1024, "Завеликий об'єм пам'яті"),
  cpuCores: z
    .number({ invalid_type_error: 'Кількість ядер має бути числом' })
    .min(0.5, 'Мінімум пів ядра')
    .max(256, 'Забагато ядер')
    .optional(),
  onlineMode: z.boolean().optional().default(true),
  pregenRadius: z
    .number({ invalid_type_error: 'Радіус має бути числом' })
    .int()
    .min(100, 'Замалий радіус прегенерації')
    .max(50000, 'Завеликий радіус прегенерації (максимум 50000 блоків)')
    .optional(),
  acceptEula: z.literal(true, {
    errorMap: () => ({ message: 'Потрібно прийняти Minecraft EULA' }),
  }),
  autoStart: z.boolean().optional().default(true),
});

const deleteQuerySchema = z.object({
  deleteData: z.enum(['true', 'false']).optional(),
});

const updateServerSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Ім'я не може бути порожнім")
      .max(40, "Ім'я задовге (до 40 символів)")
      .regex(/^[\p{L}\p{N} _.'-]+$/u, "Ім'я містить недопустимі символи")
      .optional(),
    memoryMb: z
      .number({ invalid_type_error: "Об'єм пам'яті має бути числом" })
      .int()
      .min(512, "Мінімум 512 МБ пам'яті")
      .max(1024 * 1024, "Завеликий об'єм пам'яті")
      .optional(),
    cpuCores: z
      .number({ invalid_type_error: 'Кількість ядер має бути числом' })
      .min(0.5, 'Мінімум пів ядра')
      .max(256, 'Забагато ядер')
      .nullable()
      .optional(),
    hostPort: z
      .number({ invalid_type_error: 'Порт має бути числом' })
      .int()
      .min(1024, 'Використовуйте порти від 1024')
      .max(65535, 'Порт має бути не більшим за 65535')
      .optional(),
  })
  .refine(
    (patch) =>
      patch.name !== undefined ||
      patch.memoryMb !== undefined ||
      patch.cpuCores !== undefined ||
      patch.hostPort !== undefined,
    { message: 'Немає жодного поля для оновлення' },
  );

export function registerServerRoutes(app: FastifyInstance, service: ServerService): void {
  app.get('/api/servers', async () => service.listServers());

  app.post('/api/servers', async (req, reply) => {
    const input = createServerSchema.parse(req.body);
    const server = await service.createServer(input);
    return reply.code(201).send(server);
  });

  app.get('/api/servers/:id', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    return service.getServer(id);
  });

  app.patch('/api/servers/:id', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    const patch = updateServerSchema.parse(req.body);
    return service.updateServer(id, patch);
  });

  app.post('/api/servers/:id/start', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    return service.startServer(id);
  });

  app.post('/api/servers/:id/stop', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    return service.stopServer(id);
  });

  app.post('/api/servers/:id/restart', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    return service.restartServer(id);
  });

  app.delete('/api/servers/:id', async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const { deleteData } = deleteQuerySchema.parse(req.query);
    await service.deleteServer(id, deleteData === 'true');
    return reply.code(204).send();
  });
}
