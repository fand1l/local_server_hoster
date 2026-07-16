/**
 * Ієрархія помилок застосунку.
 *
 * Будь-яка AppError безпечно серіалізується у відповідь API
 * ({ error: { code, message } }) з відповідним HTTP-статусом.
 * Усе інше вважається неочікуваною помилкою → 500 + запис у лог.
 */

export class AppError extends Error {
  constructor(
    message: string,
    /** HTTP-статус, з яким помилка піде клієнту. */
    public readonly statusCode: number = 500,
    /** Машиночитний код для фронтенду. */
    public readonly code: string = 'INTERNAL_ERROR',
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Docker-демон не запущено / сокет недоступний. */
export class DockerUnavailableError extends AppError {
  constructor(detail?: string) {
    super(
      'Docker-демон недоступний. Переконайтеся, що Docker Desktop / dockerd запущено' +
        (detail ? ` (${detail})` : ''),
      503,
      'DOCKER_UNAVAILABLE',
    );
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Ресурс не знайдено') {
    super(message, 404, 'NOT_FOUND');
  }
}

/** Конфлікт стану: зайнятий порт, дубльоване ім'я, недопустима операція у поточному стані. */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'CONFLICT');
  }
}

export class BadRequestError extends AppError {
  constructor(message: string) {
    super(message, 400, 'BAD_REQUEST');
  }
}

/** Помилки, що прийшли від Docker Engine API (через dockerode). */
interface DockerApiErrorLike {
  statusCode?: number;
  code?: string;
  message?: string;
}

/** true, якщо помилка dockerode означає "об'єкт не знайдено" (контейнер/образ видалено). */
export function isDockerNotFound(err: unknown): boolean {
  return (err as DockerApiErrorLike)?.statusCode === 404;
}

/** true, якщо помилка схожа на "немає з'єднання з демоном" (сокет відсутній тощо). */
export function isDockerConnectionError(err: unknown): boolean {
  const code = (err as DockerApiErrorLike)?.code;
  return (
    code === 'ENOENT' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'EACCES' ||
    code === 'EPIPE'
  );
}

/**
 * Перетворює довільну помилку dockerode на AppError із людиночитним поясненням.
 * Використовуйте в catch навколо будь-яких викликів Docker API.
 */
export function translateDockerError(err: unknown, context: string): AppError {
  if (err instanceof AppError) return err;
  if (isDockerConnectionError(err)) {
    return new DockerUnavailableError((err as DockerApiErrorLike).code);
  }
  const e = err as DockerApiErrorLike;
  if (e?.statusCode === 404) {
    return new NotFoundError(`${context}: об'єкт Docker не знайдено`);
  }
  if (e?.statusCode === 409) {
    return new ConflictError(`${context}: конфлікт на боці Docker (${e.message ?? '409'})`);
  }
  // Типова помилка "port is already allocated" приходить як 500 від демона.
  if (typeof e?.message === 'string' && /port is already allocated/i.test(e.message)) {
    return new ConflictError(`${context}: порт уже зайнятий іншим процесом або контейнером`);
  }
  return new AppError(`${context}: ${e?.message ?? 'невідома помилка Docker'}`, 500, 'DOCKER_ERROR');
}
