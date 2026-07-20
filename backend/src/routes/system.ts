import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import { getDocker, isDockerAvailable } from '../docker/client.js';

/**
 * Службовий стан панелі: чи живий Docker-демон + ресурси машини.
 * Фронтенд полить цей ендпоінт (банер стану Docker), а майстер створення
 * використовує totalMemoryMb/cpuCount як межі повзунків ОЗП і ЦП.
 */
export function registerSystemRoutes(app: FastifyInstance): void {
  app.get('/api/system', async () => {
    const dockerAvailable = await isDockerAvailable();

    let dockerVersion: string | null = null;
    if (dockerAvailable) {
      try {
        const version = await getDocker().version();
        dockerVersion = version.Version ?? null;
      } catch {
        // Версію не дістали — не критично, доступність уже відома.
      }
    }

    return {
      dockerAvailable,
      dockerVersion,
      /** Фізична пам'ять машини у МБ — верхня межа повзунка ОЗП. */
      totalMemoryMb: Math.floor(os.totalmem() / (1024 * 1024)),
      /** Кількість логічних ядер — верхня межа повзунка ЦП. */
      cpuCount: os.cpus().length,
    };
  });
}
