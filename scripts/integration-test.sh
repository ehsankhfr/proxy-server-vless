#!/usr/bin/env bash
# integration-test.sh – spin up the Docker Compose stack, run 5 assertions, then tear it down.
# Usage: bash scripts/integration-test.sh   or   npm run test:integration
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/../docker/docker-compose.yml"
PASS=0
FAIL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}PASS${NC}: $1"; PASS=$((PASS + 1)); }
fail() { echo -e "${RED}FAIL${NC}: $1"; FAIL=$((FAIL + 1)); }
info() { echo -e "${YELLOW}INFO${NC}: $1"; }

cleanup() {
  info "Tearing down containers"
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans 2>/dev/null || true
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Start
# ---------------------------------------------------------------------------
info "Pulling images and starting containers"
docker compose -f "$COMPOSE_FILE" pull --quiet
docker compose -f "$COMPOSE_FILE" up -d

# ---------------------------------------------------------------------------
# Wait for nginx-proxy to be ready (up to 60 s)
# ---------------------------------------------------------------------------
info "Waiting for nginx-proxy to be ready on localhost:18080"
for i in $(seq 1 30); do
  if curl -sf http://localhost:18080/ > /dev/null 2>&1; then
    info "nginx-proxy is ready"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: nginx-proxy did not become ready in time"
    docker compose -f "$COMPOSE_FILE" logs nginx-proxy v2ray-server
    exit 1
  fi
  sleep 2
done

# ---------------------------------------------------------------------------
# Wait for v2ray-client SOCKS port to be ready (up to 60 s)
# ---------------------------------------------------------------------------
info "Waiting for v2ray-client SOCKS port 11080"
for i in $(seq 1 30); do
  if curl -sf --socks5-hostname localhost:11080 --max-time 5 http://target/ > /dev/null 2>&1; then
    info "v2ray-client SOCKS tunnel is ready"
    break
  fi
  if [ "$i" -eq 30 ]; then
    info "v2ray-client tunnel not ready after 60 s – proceeding anyway (test will record failure)"
    break
  fi
  sleep 2
done

echo ""
echo "========================================"
echo " Running integration tests"
echo "========================================"
echo ""

# ---------------------------------------------------------------------------
# Test 1: Nginx health endpoint
# ---------------------------------------------------------------------------
RESULT=$(curl -sf http://localhost:18080/ 2>&1) || RESULT=""
if echo "$RESULT" | grep -q "OK"; then
  pass "Nginx health endpoint returns 'OK'"
else
  fail "Nginx health endpoint: expected 'OK', got: '$RESULT'"
fi

# ---------------------------------------------------------------------------
# Test 2: Non-existent path returns non-404 (nginx / catch-all returns 200)
#          while a path outside /vless-fallback does NOT proxy to v2ray
# ---------------------------------------------------------------------------
# The nginx config serves "OK" for all locations except /vless-fallback.
# Verify /vless-fallback is handled differently: expect non-plain-200 or a
# WebSocket-upgrade response (101) from v2ray, whereas a random path gets "OK".
WS_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Upgrade: websocket" \
  -H "Connection: Upgrade" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Sec-WebSocket-Version: 13" \
  http://localhost:18080/vless-fallback 2>&1) || WS_CODE=""
PLAIN_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  http://localhost:18080/some-other-path 2>&1) || PLAIN_CODE=""
if [ "$WS_CODE" = "101" ] && [ "$PLAIN_CODE" = "200" ]; then
  pass "WebSocket path /vless-fallback proxied to v2ray (101); other paths served by nginx (200)"
elif [ "$WS_CODE" != "200" ] && [ "$PLAIN_CODE" = "200" ]; then
  pass "WebSocket path /vless-fallback handled differently from plain paths (ws=$WS_CODE plain=$PLAIN_CODE)"
else
  fail "WebSocket path routing unexpected: ws=$WS_CODE plain=$PLAIN_CODE"
fi

# ---------------------------------------------------------------------------
# Test 3: Traffic passes through the VLESS tunnel (correct client)
#  curl → SOCKS5h:11080 → v2ray-client → VLESS/WS → nginx-proxy → v2ray-server → target
# ---------------------------------------------------------------------------
TUNNEL_RESULT=$(curl -sf --socks5-hostname localhost:11080 --max-time 15 http://target/ 2>&1) || TUNNEL_RESULT=""
if echo "$TUNNEL_RESULT" | grep -q "TARGET OK"; then
  pass "Traffic passes through VLESS tunnel (correct UUID + path)"
else
  fail "VLESS tunnel: expected 'TARGET OK', got: '$TUNNEL_RESULT'"
  docker compose -f "$COMPOSE_FILE" logs --tail=20 v2ray-server v2ray-client 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Test 4: Wrong UUID – tunnel must NOT forward traffic
# ---------------------------------------------------------------------------
WRONG_UUID_RESULT=$(curl -sf --socks5-hostname localhost:11081 --max-time 10 http://target/ 2>&1) || WRONG_UUID_RESULT=""
if echo "$WRONG_UUID_RESULT" | grep -q "TARGET OK"; then
  fail "Wrong-UUID client should NOT pass traffic, but 'TARGET OK' was received"
else
  pass "Wrong UUID correctly rejected (no 'TARGET OK' received)"
fi

# ---------------------------------------------------------------------------
# Test 5: Wrong WS path – tunnel must NOT forward traffic
# ---------------------------------------------------------------------------
WRONG_PATH_RESULT=$(curl -sf --socks5-hostname localhost:11082 --max-time 10 http://target/ 2>&1) || WRONG_PATH_RESULT=""
if echo "$WRONG_PATH_RESULT" | grep -q "TARGET OK"; then
  fail "Wrong-path client should NOT pass traffic, but 'TARGET OK' was received"
else
  pass "Wrong WS path correctly rejected (no 'TARGET OK' received)"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "========================================"
echo " Results: ${PASS} passed, ${FAIL} failed"
echo "========================================"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
