import type { FastifyInstance } from 'fastify';
import { getDocker, isDockerAvailable } from '../docker/client.js';

/**
 * Службовий стан панелі: чи живий Docker-демон.
 * Фронтенд полить цей ендпоінт і показує банер, коли Docker не запущено.
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

    return { dockerAvailable, dockerVersion };
  });
}
