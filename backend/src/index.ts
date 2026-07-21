import { createApp } from './app.js';
import { ensureDataDirs, loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { ServerRepository } from './db/serverRepository.js';
import { getDocker, isDockerAvailable } from './docker/client.js';
import { ContainerManager } from './docker/containerManager.js';
import { ConsoleGateway } from './docker/consoleGateway.js';
import { VersionCatalog } from './minecraft/versionCatalog.js';
import { registerConsoleRoute } from './routes/console.ws.js';
import { registerMetaRoutes } from './routes/meta.js';
import { registerPlayerRoutes } from './routes/players.js';
import { registerPropertiesRoutes } from './routes/properties.js';
import { registerServerRoutes } from './routes/servers.js';
import { registerSystemRoutes } from './routes/system.js';
import { PlayerService } from './services/playerService.js';
import { PregenMonitor } from './services/pregenMonitor.js';
import { PregenScheduler } from './services/pregenScheduler.js';
import { ServerService } from './services/serverService.js';

/**
 * Точка входу бекенду.
 *
 * Порядок ініціалізації:
 *   конфіг → директорії даних → SQLite → Docker-клієнт → Fastify → роути → listen.
 * Docker МОЖЕ бути недоступним на старті: панель все одно піднімається,
 * а операції з серверами повертають 503 із поясненням.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  ensureDataDirs(config);

  const db = openDatabase(config.dbFile);
  const repo = new ServerRepository(db);
  const containers = new ContainerManager(getDocker());
  const gateway = new ConsoleGateway(getDocker);

  const app = await createApp(config);

  // Монітор прогресу Chunky: парсить логи у фоні й пушить прогрес у консоль.
  const pregenMonitor = new PregenMonitor({
    containers,
    onUpdate: (serverId, progress) => gateway.notifyPregen(serverId, progress),
    log: app.log,
  });

  // Планувальник прегенерації читає завжди свіжий запис і сам позначає виконання;
  // markDone відкладаємо через замикання, бо service створюється наступним рядком.
  let service: ServerService;
  const pregen = new PregenScheduler({
    containers,
    gateway,
    monitor: pregenMonitor,
    getRecord: (id) => repo.get(id),
    markDone: (id) => service.markPregenDone(id),
    log: app.log,
  });
  service = new ServerService({ config, repo, containers, gateway, pregen, pregenMonitor, log: app.log });
  const players = new PlayerService({ containers, gateway, log: app.log });

  registerSystemRoutes(app);
  registerMetaRoutes(app, new VersionCatalog());
  registerServerRoutes(app, service);
  registerPropertiesRoutes(app, service);
  registerPlayerRoutes(app, service, players);
  registerConsoleRoute(app, { service, gateway });

  if (await isDockerAvailable()) {
    app.log.info('Docker-демон доступний');
  } else {
    app.log.warn(
      'Docker-демон недоступний: панель працює, але керування серверами поверне 503, поки Docker не запуститься',
    );
  }

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Дані панелі: ${config.dataRoot}`);
  if (config.frontendDist) {
    app.log.info(`Панель доступна на http://${config.host}:${config.port}`);
  } else {
    app.log.warn(
      'Збірку фронтенду не знайдено (frontend/dist): запустіть `npm run build -w frontend` ' +
        'або відкрийте dev-сервер Vite на http://localhost:5173',
    );
  }

  // Акуратне завершення: закриваємо сокети/БД. Контейнери НЕ зупиняємо —
  // Minecraft-сервери живуть незалежно від панелі.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`Отримано ${signal}, зупиняю панель (Minecraft-сервери продовжують працювати)`);
    pregenMonitor.shutdown();
    gateway.shutdown();
    void app
      .close()
      .then(() => db.close())
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Фатальна помилка запуску панелі:', err);
  process.exit(1);
});
