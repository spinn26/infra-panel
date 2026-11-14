# Infra Panel

Панель управления Docker-инфраструктурой и сайтами на одном сервере. Один бинарный файл на Node.js без зависимостей: веб-интерфейс, метрики, живая телеметрия и развёртка сайтов с предустановками CMS — в одном контейнере.

A single-binary Docker infrastructure panel: overview, live metrics, container management, site provisioning with popular CMS presets — no external dependencies, plain Node.js.

## Возможности

- **Обзор**: статус всех контейнеров, CPU/RAM/диск, история нагрузки 24 ч, live-события Docker, алерты
- **Сайты**: мониторинг доменов (код, латентность, аптайм) + создание сайтов из предустановок — WordPress, Joomla, Drupal, OpenCart, PrestaShop, Nextcloud, 1C-Битрикс, n8n, Jenkins, чистый сервер Ubuntu с SSH
- **Контейнеры**: старт/стоп/рестарт, логи в реальном времени, скан ошибок, exec команд, детали в выезжающей панели
- **Образы / тома / сети**: просмотр, скачивание, удаление, проверка обновлений образов
- **Бэкапы**: архив всех томов и конфигов одной кнопкой, автобэкап по расписанию, выгрузка в S3 (Яндекс Object Storage, Selectel, R2, B2)
- **Файлы**: просмотр и редактирование файлов деплоя в браузере (с бэкапом копии)
- CMS-пресеты получают базу автоматически: общий MariaDB поднимается при первой установке, у каждого сайта своя БД и пользователь

## Быстрый старт

```bash
git clone https://github.com/<you>/infra-panel.git
cd infra-panel
cp .env.example .env
# задайте ADMIN_PASSWORD и DOCKER_GID (id группы docker: getent group docker)
docker compose up -d --build
# откройте http://127.0.0.1:18080
```

Панель слушает только localhost — для доступа извне поставьте reverse proxy с TLS (Caddy, nginx, Traefik).

## Переменные окружения

| Переменная | Назначение |
|---|---|
| `ADMIN_USER` | логин (по умолчанию `admin`) |
| `ADMIN_PASSWORD` | пароль — **обязателен** |
| `PANEL_SECRET` | подпись сессий (по умолчанию генерируется при старте) |
| `HOST_DEPLOY_DIR` | путь деплоя внутри контейнера (по умолчанию `/host-deploy`) |
| `HOST_DEPLOY_HOST` | тот же путь на **хосте** (по умолчанию `/opt/fleet/deploy`) — через него helper-контейнеры пишут файлы сайтов и Caddyfile |
| `HOST_BACKUPS_DIR` | каталог бэкапов на хосте (по умолчанию `/opt/fleet/backups`) |
| `HOST_PUBLIC_IP` | публичный IP сервера — подставляется в подсказку SSH для пресета Ubuntu |
| `DOCKER_GID` | gid группы `docker` на хосте (для compose) |

## Как устроено

- `server.js` — HTTP-сервер, API через unix-сокет dockerd, встроенный фронт, механизмы бэкапов и S3
- `client.js` — интерфейс (vanilla JS, без сборки)
- Сайты создаются как контейнеры `aksite-<имя>` в общей docker-сети; блоки для reverse proxy дописываются в Caddyfile хоста (шаблон блока использует сниппет `import secure` — при необходимости поправьте в `createSite`)
- CMS-пресеты — официальные образы; данные в named-томах `aksite-<имя>-data`

## Безопасность

- Бинд только на `127.0.0.1`, сильный пароль, сессии — подписанные cookie (HttpOnly, SameSite)
- Панель управляет docker-сокетом = root-доступ к хосту. Не выставляйте её в интернет без TLS и не давайте доступ посторонним
- Лимит попыток входа: 5 неудачных за 10 минут

## Лицензия

MIT — см. [LICENSE](LICENSE). Разработано в [AK Systems](https://aksystems.pro).
