# ------------------------------------------------------------------------------
# Альтернативний "чистий" образ для Minecraft-сервера (без itzg/minecraft-server).
#
# Панель за замовчуванням використовує itzg/minecraft-server, бо той сам
# завантажує потрібний jar (Paper/Vanilla/Fabric) і коректно обробляє зупинку.
# Цей Dockerfile — мінімальна альтернатива, якщо ви хочете покласти СВІЙ
# server.jar у директорію сервера і запускати його на чистому JRE.
#
# Збірка:
#   docker build -t mc-hoster/custom-jre:21 docker/custom-jre
#
# Запуск (директорія з server.jar монтується у /data):
#   docker run -d -i --name my-server \
#     -p 25565:25565 \
#     -v /шлях/до/сервера:/data \
#     -e MEMORY=2048M \
#     mc-hoster/custom-jre:21
#
# Прапорець -i (OpenStdin) обов'язковий, щоб працювала консоль через attach.
# ------------------------------------------------------------------------------
FROM eclipse-temurin:21-jre-jammy

# Окремий непривілейований користувач — сервер не має працювати від root.
RUN useradd --create-home --uid 1000 minecraft 2>/dev/null || true

WORKDIR /data
VOLUME ["/data"]
EXPOSE 25565/tcp

# MEMORY керує -Xms/-Xmx JVM (формат як у java: 2048M, 4G тощо).
ENV MEMORY=2048M \
    JAR_FILE=server.jar

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER minecraft
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
