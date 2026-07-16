import net from 'node:net';

/**
 * Перевіряє (best-effort), чи вільний TCP-порт на вказаному інтерфейсі хоста.
 *
 * Це рання діагностика на момент СТВОРЕННЯ сервера: якщо порт зайнятий іншим
 * застосунком, користувач дізнається одразу, а не після довгого pull образу.
 * Гонки все одно можливі (порт може зайнятися пізніше) — фінальну відповідь
 * дає Docker при старті контейнера, і ту помилку ми теж показуємо.
 */
export function isTcpPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen({ port, host, exclusive: true }, () => {
      probe.close(() => resolve(true));
    });
  });
}
