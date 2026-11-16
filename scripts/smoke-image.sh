#!/usr/bin/env bash
set -euo pipefail

image=${1:?Usage: scripts/smoke-image.sh IMAGE}
name="paperfold-smoke-$(date +%s)-$$"
volume="${name}-data"
cleanup() {
  result=$?
  if (( result != 0 )); then docker logs "$name" >&2 || true; fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  exit "$result"
}
trap cleanup EXIT

docker volume create "$volume" >/dev/null
docker run -d --name "$name" \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=volume,source=${volume},target=/data" \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  "$image" >/dev/null

wait_ready() {
  for _ in {1..30}; do
    if docker exec "$name" bun -e \
      'const r = await fetch("http://127.0.0.1:3000/healthz"); if (!r.ok) process.exit(1)' \
      >/dev/null 2>&1; then return; fi
    sleep 1
  done
  echo 'Container did not become healthy' >&2
  return 1
}
wait_ready

# Exercise migrations and write permission as the image's unprivileged user.
docker exec "$name" bun -e '
  import { Database } from "bun:sqlite";
  if (process.getuid() === 0) throw new Error("Server must run as non-root");
  const db = new Database("/data/paperfold.db");
  db.query("INSERT INTO collections (pid, owned, equipped) VALUES (?, ?, ?)")
    .run("smokeplayer0001", JSON.stringify(["top-hat"]), "top-hat");
  db.close();
  await Bun.write("/data/paint/999999999.png", "persistent-paint");
'
docker restart "$name" >/dev/null
wait_ready

docker exec "$name" bun -e '
  const origin = "http://127.0.0.1:3000";
  const page = await fetch(origin);
  if (!page.ok || !(await page.text()).includes("Paperfold")) throw new Error("Client missing");
  const paint = await fetch(origin + "/paint/999999999.png", { headers: { Origin: "https://michidk.github.io" } });
  if (!paint.ok || paint.headers.get("access-control-allow-origin") !== "*") throw new Error("Cross-origin paint unavailable");
  if (await Bun.file("/data/paint/999999999.png").text() !== "persistent-paint") throw new Error("Paint lost on restart");
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error("WebSocket timeout")); }, 5000);
    const socket = new WebSocket("ws://127.0.0.1:3000/ws", { headers: { Origin: "https://michidk.github.io" } });
    socket.onopen = () => socket.send(JSON.stringify({ t: "hello", pid: "smokeplayer0001", name: "Smoke" }));
    socket.onerror = () => { clearTimeout(timeout); reject(new Error("WebSocket connection failed")); };
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.t !== "collection") return;
      clearTimeout(timeout);
      socket.close();
      if (message.equipped !== "top-hat" || message.owned.length !== 1) reject(new Error("Collection lost on restart"));
      else resolve();
    };
  });
'
echo 'Image smoke test passed: non-root, read-only root, HTTP, WebSocket and persistent data.'
