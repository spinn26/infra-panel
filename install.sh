#!/usr/bin/env bash
# Infra Panel — установка одной командой
#   curl -fsSL https://raw.githubusercontent.com/spinn26/infra-panel/main/install.sh | bash
#
# Переменные (необязательно):
#   INFRA_PANEL_DIR   куда ставить            (по умолчанию ~/infra-panel)
#   INFRA_PANEL_REF   ветка или тег           (по умолчанию main)
#   ADMIN_USER / ADMIN_PASSWORD               без вопросов в терминале
#   HOST_DEPLOY_HOST / HOST_BACKUPS_DIR       пути на хосте (/opt/fleet/...)
set -euo pipefail

REPO_URL="${INFRA_PANEL_REPO:-https://github.com/spinn26/infra-panel.git}"
REPO_REF="${INFRA_PANEL_REF:-main}"
INSTALL_DIR="${INFRA_PANEL_DIR:-$HOME/infra-panel}"
DEPLOY_DIR="${HOST_DEPLOY_HOST:-/opt/fleet/deploy}"
BACKUPS_DIR="${HOST_BACKUPS_DIR:-/opt/fleet/backups}"
URL="http://127.0.0.1:18080"

if [[ -t 1 || "${FORCE_COLOR:-1}" == "1" ]]; then
  C0='\033[0m'; B='\033[1m'; D='\033[2m'; R='\033[31m'; G='\033[32m'; Y='\033[33m'; C='\033[36m'
else
  C0=''; B=''; D=''; R=''; G=''; Y=''; C=''
fi
ok()   { echo -e "  ${G}✓${C0} $*"; }
info() { echo -e "  ${D}·${C0} $*"; }
warn() { echo -e "  ${Y}!${C0} $*"; }
fail() { echo -e "  ${R}✗${C0} $*"; exit 1; }
step=0
begin() { step=$((step + 1)); echo; echo -e "  ${C}${B}[$step/6]${C0} ${B}$*${C0}"; }

SUDO=""
[[ $EUID -ne 0 ]] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"

rand_pass() { openssl rand -base64 24 2>/dev/null | tr -d '/+=' | head -c 24 || head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
rand_hex()  { openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

set_env() {
  local key="$1" val="$2"
  if grep -qE "^#? ?${key}=" .env; then
    sed -i -E "s|^#? ?${key}=.*|${key}=${val}|" .env
  else
    echo "${key}=${val}" >> .env
  fi
}

echo
echo -e "  ${B}Infra Panel${C0}  ${D}установка${C0}"
info "репозиторий  ${REPO_URL} (${REPO_REF})"
info "каталог      ${INSTALL_DIR}"

# 1 ── проверки
begin "Проверка окружения"
command -v docker >/dev/null 2>&1 || fail "нужен Docker → https://docs.docker.com/engine/install/"
docker info >/dev/null 2>&1 || fail "нет доступа к Docker. Выполните: sudo usermod -aG docker \$USER && newgrp docker"
docker compose version >/dev/null 2>&1 || fail "нужен плагин docker compose"
command -v git >/dev/null 2>&1 || fail "нужен git (apt install git)"
ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null)"

# 2 ── исходники
begin "Загрузка панели с GitHub"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  git -C "$INSTALL_DIR" fetch -q --depth 1 origin "$REPO_REF"
  git -C "$INSTALL_DIR" checkout -q -B "$REPO_REF" FETCH_HEAD
  ok "обновлено до ${REPO_REF}"
else
  git clone -q --depth 1 --branch "$REPO_REF" "$REPO_URL" "$INSTALL_DIR"
  ok "склонировано"
fi
cd "$INSTALL_DIR"

# 3 ── настройка
begin "Настройка .env"
NEW_PASS=""
if [[ -f .env ]]; then
  ok "оставлен существующий .env"
else
  cp .env.example .env
  USER_NAME="${ADMIN_USER:-}"
  NEW_PASS="${ADMIN_PASSWORD:-}"
  if [[ -z "$USER_NAME" && -r /dev/tty ]]; then
    printf "  Логин [admin]: " >/dev/tty; IFS= read -r USER_NAME </dev/tty || true
  fi
  if [[ -z "$NEW_PASS" && -r /dev/tty ]]; then
    printf "  Пароль (пусто — сгенерировать): " >/dev/tty; IFS= read -rs NEW_PASS </dev/tty || true; echo >/dev/tty
  fi
  USER_NAME="${USER_NAME:-admin}"
  [[ -n "$NEW_PASS" ]] || NEW_PASS="$(rand_pass)"
  GID="$(getent group docker | cut -d: -f3 || true)"
  [[ -n "$GID" ]] || GID="$(stat -c '%g' /var/run/docker.sock)"
  IP="$(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)"
  set_env ADMIN_USER "$USER_NAME"
  set_env ADMIN_PASSWORD "$NEW_PASS"
  set_env PANEL_SECRET "$(rand_hex)"
  set_env DOCKER_GID "$GID"
  set_env HOST_DEPLOY_HOST "$DEPLOY_DIR"
  set_env HOST_BACKUPS_DIR "$BACKUPS_DIR"
  set_env HOST_PUBLIC_IP "$IP"
  chmod 600 .env
  ok ".env создан (DOCKER_GID=${GID})"
fi

# 4 ── каталоги
begin "Каталоги на хосте"
$SUDO mkdir -p "$DEPLOY_DIR" "$BACKUPS_DIR"
[[ -f "$DEPLOY_DIR/Caddyfile" ]] || $SUDO touch "$DEPLOY_DIR/Caddyfile"
ok "$DEPLOY_DIR, $BACKUPS_DIR"

# 5 ── запуск
begin "Сборка и запуск контейнера"
info "образ node:22-alpine скачивается с Docker Hub"
docker compose up -d --build --quiet-pull >/dev/null
ok "контейнер infra-panel запущен"

# 6 ── проверка
begin "Проверка"
code=000
for _ in $(seq 1 20); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$URL/" 2>/dev/null || echo 000)"
  [[ "$code" =~ ^(200|302|401)$ ]] && break
  sleep 1
done
if [[ "$code" =~ ^(200|302|401)$ ]]; then ok "панель отвечает (HTTP $code)"; else warn "панель пока не отвечает — docker logs infra-panel"; fi

echo
echo -e "  ${G}${B}Готово${C0}"
echo -e "  Адрес    ${C}${URL}${C0}"
echo -e "  Логин    $(grep '^ADMIN_USER=' .env | cut -d= -f2-)"
if [[ -n "$NEW_PASS" ]]; then echo -e "  Пароль   ${Y}${NEW_PASS}${C0}  ${D}(сохраните)${C0}"; else echo -e "  Пароль   ${D}из .env${C0}"; fi
echo
echo -e "  ${D}С удалённой машины: ssh -L 18080:127.0.0.1:18080 user@server${C0}"
echo -e "  ${D}Обновить: повторно запустите эту команду${C0}"
echo
