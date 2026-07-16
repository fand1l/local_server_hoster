#!/bin/sh
# Точка входу "чистого" Minecraft-образу: запускає server.jar із /data.
set -eu

cd /data

if [ ! -f "${JAR_FILE}" ]; then
  echo "ПОМИЛКА: у /data немає ${JAR_FILE}. Покладіть jar сервера у директорію сервера." >&2
  exit 1
fi

# Minecraft вимагає прийняту EULA; створюємо файл, лише якщо користувач
# явно передав EULA=TRUE (так само поводиться itzg/minecraft-server).
if [ "${EULA:-}" = "TRUE" ] && [ ! -f eula.txt ]; then
  echo "eula=true" > eula.txt
fi

# exec — щоб java стала PID 1: отримувала stdin (консоль через docker attach)
# і SIGTERM від `docker stop` для коректного збереження світу.
exec java -Xms"${MEMORY}" -Xmx"${MEMORY}" -jar "${JAR_FILE}" nogui
