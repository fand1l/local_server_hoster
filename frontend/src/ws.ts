import type { ConsoleClientMessage, ConsoleServerMessage } from './types';

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface ConsoleHandlers {
  onMessage(message: ConsoleServerMessage): void;
  onConnectionChange(state: ConnectionState): void;
}

/** Затримка перед повторним підключенням консолі. */
const RECONNECT_DELAY_MS = 2500;
/** Кастомний код закриття від бекенду: сервер не знайдено/видалено. */
const WS_CLOSE_NOT_FOUND = 4404;

/**
 * WebSocket-підключення до консолі одного сервера з автоперепідключенням.
 * Живе, поки відкрита сторінка сервера; close() зупиняє все остаточно.
 */
export class ConsoleConnection {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly serverId: string,
    private readonly handlers: ConsoleHandlers,
  ) {}

  connect(): void {
    if (this.disposed) return;
    this.handlers.onConnectionChange('connecting');

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${protocol}://${location.host}/api/servers/${this.serverId}/console`);

    this.ws.addEventListener('open', () => {
      if (!this.disposed) this.handlers.onConnectionChange('open');
    });

    this.ws.addEventListener('message', (event: MessageEvent<string>) => {
      if (this.disposed) return;
      try {
        this.handlers.onMessage(JSON.parse(event.data) as ConsoleServerMessage);
      } catch {
        // Ігноруємо биті кадри — бекенд шле лише JSON.
      }
    });

    this.ws.addEventListener('close', (event) => {
      if (this.disposed) return;
      this.handlers.onConnectionChange('closed');
      // Сервер видалено — перепідключатися немає сенсу.
      if (event.code === WS_CLOSE_NOT_FOUND) return;
      this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    });
    // 'error' завжди супроводжується 'close' — обробки close достатньо.
  }

  /** Надсилає команду; false — якщо з'єднання зараз не відкрите. */
  send(command: string): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    const message: ConsoleClientMessage = { type: 'command', data: command };
    this.ws.send(JSON.stringify(message));
    return true;
  }

  close(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}
