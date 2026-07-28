#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const {
  chromium,
} = require("/Users/a55/.claude/skills/gstack/node_modules/playwright-core");

const REPO_ROOT = path.resolve(__dirname, "../..");
const REPORT_PATH = path.join(__dirname, "audit_report.json");
const BASE_URL = "http://localhost:8899";
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const GRID_SCALE = 100;
const SPOT_RADIUS = 0.06; // (구) 원형 — 아래 타원이 실측 근접판정
// 실측(2026-07-26): 근접판정 135px을 bgRect로 나누면 rx≈0.047, ry≈0.084 (타원)
const SPOT_RX = 0.047;
const SPOT_RY = 0.084;
const MINI_PLAY_MS = 8000;
const PAGE_TIMEOUT_MS = 12000;
const OVERALL_TIMEOUT_MS = 280000;

const startedAt = Date.now();
const report = {
  generatedAt: new Date().toISOString(),
  repoRoot: REPO_ROOT,
  baseUrl: BASE_URL,
  durationMs: 0,
  runtimeExport: {
    ok: false,
    counts: {},
    diagnostics: [],
    data: null,
  },
  sceneGraph: {
    sceneCount: 0,
    edgeCount: 0,
    mutuallyReachable: false,
    edges: [],
    unreachablePairs: [],
  },
  sceneBfs: {
    gridStep: 1 / GRID_SCALE,
    spotRadius: SPOT_RADIUS,
    sceneCount: 0,
    spotCount: 0,
    reachableSpotCount: 0,
    failures: [],
    scenes: [],
  },
  sceneGeometry: {
    // P0-② (2026-07-28 마스터플랜 v3 §2): 병목폭·양축차단·HERO면적
    minCorridor: 0.06,
    heroAreaMax: 0.10,
    sceneCount: 0,
    violations: [],
  },
  anchorAlignment: {
    // P0-② §3 앵커 정합 — tools/audit/anchors/<scene>.json 있는 씬만 검사
    specCount: 0,
    checkedAnchors: 0,
    failures: [],
  },
  viewportSmoke: {
    // P0-② 가로뷰·다중 뷰포트 (B관 게임 가로 잘림 재발 방지)
    viewports: [],
    results: [],
  },
  dataIntegrity: {
    checkedSpots: 0,
    checkedNpcs: 0,
    checkedGames: 0,
    checkedExhibits: 0,
    issueCount: 0,
    catalogMissing: [],
    catalogExtra: [],
  },
  miniGameHygiene: {
    fileCount: 0,
    completedCount: 0,
    results: [],
  },
  resources: {
    floorCount: 0,
    completedCount: 0,
    failedRequests: [],
    httpErrors: [],
    floors: [],
  },
  defects: [],
};

function addDefect(severity, scene, item, detail) {
  report.defects.push({
    severity,
    scene: scene || null,
    item: item || null,
    detail: String(detail),
  });
}

function errorText(error) {
  if (!error) return "알 수 없는 오류";
  const text = error.message || error.stack || String(error);
  const cleaned = String(text).replace(/\u001b\[[0-9;]*m/g, "");
  return cleaned.length > 8000
    ? `${cleaned.slice(0, 8000)}\n…(오류 메시지 생략)`
    : cleaned;
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 시간 초과(${timeoutMs}ms)`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const runners = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) {
    runners.push(run());
  }
  await Promise.all(runners);
  return results;
}

function writeReport() {
  report.durationMs = Date.now() - startedAt;
  fs.mkdirSync(path.dirname(REPORT_PATH), {
    recursive: true,
  });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function sceneEntries(data) {
  const entries = [];
  for (const floor of data.FLOORS || []) {
    entries.push([floor.id, floor, "floor"]);
  }
  for (const [roomId, room] of Object.entries(data.ROOMS || {})) {
    entries.push([roomId, room, "room"]);
  }
  return entries;
}

function pointInObstacle(obstacles, x, y) {
  for (const obstacle of obstacles || []) {
    if (
      x > obstacle[0]
      && x < obstacle[2]
      && y > obstacle[1]
      && y < obstacle[3]
    ) {
      return true;
    }
  }
  return false;
}

function isWalkable(scene, x, y) {
  const walkable = scene.walkable || [0, 0, 1, 1];
  if (
    x < walkable[0]
    || x > walkable[2]
    || y < walkable[1]
    || y > walkable[3]
  ) {
    return false;
  }
  return !pointInObstacle(scene.obstacles, x, y);
}

function nearbyCells(scene, x, y, scale = 1) {
  // 실측 타원(SPOT_RX·SPOT_RY) 사용 — 게임의 135px 근접판정과 동일 조건. scale로 완충 확대 가능
  if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
  const rx = SPOT_RX * scale;
  const ry = SPOT_RY * scale;
  const cells = [];
  const minX = Math.max(0, Math.floor((x - rx) * GRID_SCALE));
  const maxX = Math.min(GRID_SCALE, Math.ceil((x + rx) * GRID_SCALE));
  const minY = Math.max(0, Math.floor((y - ry) * GRID_SCALE));
  const maxY = Math.min(GRID_SCALE, Math.ceil((y + ry) * GRID_SCALE));

  for (let iy = minY; iy <= maxY; iy += 1) {
    for (let ix = minX; ix <= maxX; ix += 1) {
      const px = ix / GRID_SCALE;
      const py = iy / GRID_SCALE;
      const ex = (px - x) / rx;
      const ey = (py - y) / ry;
      if (ex * ex + ey * ey > 1 + 1e-9) continue;
      if (isWalkable(scene, px, py)) cells.push([ix, iy]);
    }
  }
  return cells;
}

function auditSceneGraph(data) {
  const entries = sceneEntries(data);
  const ids = entries.map(([sceneId]) => sceneId);
  const idSet = new Set(ids);
  const adjacency = new Map(ids.map((sceneId) => [sceneId, new Set()]));
  const edgeRecords = [];
  const edgeKeys = new Set();
  const incomingDoors = new Map();

  function addEdge(from, to, kind, item) {
    if (!idSet.has(from) || !idSet.has(to)) return;
    const key = `${from}\u0000${to}\u0000${kind}`;
    adjacency.get(from).add(to);
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edgeRecords.push({
      from,
      to,
      kind,
      item,
    });
  }

  for (const [sceneId, scene] of entries) {
    for (const spot of scene.spots || []) {
      if (spot.kind === "stair" || spot.kind === "gate") {
        addEdge(sceneId, spot.to, spot.kind, spot.name);
      } else if (spot.kind === "door") {
        addEdge(sceneId, spot.room, "door", spot.name);
        if (!incomingDoors.has(spot.room)) incomingDoors.set(spot.room, new Set());
        incomingDoors.get(spot.room).add(sceneId);
      } else if (spot.kind === "elevator") {
        for (const floorId of spot.floors || []) {
          addEdge(sceneId, floorId, "elevator", spot.name);
        }
      }
    }
    for (const zone of scene.zones || []) {
      addEdge(sceneId, zone.to, "zone", JSON.stringify(zone.rect || null));
    }
  }

  for (const [sceneId, scene] of entries) {
    const exits = (scene.spots || []).filter((spot) => spot.kind === "exit");
    if (!exits.length) continue;
    const destinations = incomingDoors.get(sceneId) || new Set();
    if (!destinations.size) {
      addDefect("critical", sceneId, "exit", "나가기의 복귀 대상이 되는 진입 문이 없습니다.");
    }
    for (const exit of exits) {
      for (const destination of destinations) {
        addEdge(sceneId, destination, "exit", exit.name);
      }
    }
  }

  const unreachablePairs = [];
  for (const source of ids) {
    const visited = new Set([source]);
    const queue = [source];
    for (let head = 0; head < queue.length; head += 1) {
      const current = queue[head];
      for (const next of adjacency.get(current) || []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    const missing = ids.filter((target) => !visited.has(target));
    for (const target of missing) {
      unreachablePairs.push({
        from: source,
        to: target,
      });
    }
    if (missing.length) {
      addDefect(
        "critical",
        source,
        "scene-graph",
        `도달할 수 없는 씬: ${missing.join(", ")}`,
      );
    }
  }

  report.sceneGraph.sceneCount = ids.length;
  report.sceneGraph.edgeCount = edgeRecords.length;
  report.sceneGraph.mutuallyReachable = unreachablePairs.length === 0;
  report.sceneGraph.edges = edgeRecords;
  report.sceneGraph.unreachablePairs = unreachablePairs;
}

function reachableGrid(scene) {
  const width = GRID_SCALE + 1;
  const total = width * width;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  const start = scene.start || [0.5, 0.5];
  const startX = Math.round(start[0] * GRID_SCALE);
  const startY = Math.round(start[1] * GRID_SCALE);
  const startPx = startX / GRID_SCALE;
  const startPy = startY / GRID_SCALE;

  if (
    startX < 0
    || startX > GRID_SCALE
    || startY < 0
    || startY > GRID_SCALE
    || !isWalkable(scene, startPx, startPy)
  ) {
    return {
      visited,
      startPassable: false,
      visitedCount: 0,
    };
  }

  let head = 0;
  let tail = 0;
  const startIndex = startY * width + startX;
  visited[startIndex] = 1;
  queue[tail] = startIndex;
  tail += 1;
  const directions = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  while (head < tail) {
    const current = queue[head];
    head += 1;
    const x = current % width;
    const y = Math.floor(current / width);
    for (const [dx, dy] of directions) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx > GRID_SCALE || ny < 0 || ny > GRID_SCALE) continue;
      const index = ny * width + nx;
      if (visited[index]) continue;
      if (!isWalkable(scene, nx / GRID_SCALE, ny / GRID_SCALE)) continue;
      visited[index] = 1;
      queue[tail] = index;
      tail += 1;
    }
  }

  return {
    visited,
    startPassable: true,
    visitedCount: tail,
  };
}

function spotSeverity(spot) {
  return [
    "stair",
    "gate",
    "door",
    "exit",
    "elevator",
    "game",
  ].includes(spot.kind)
    ? "critical"
    : "medium";
}

function auditSceneBfs(data) {
  const entries = sceneEntries(data);
  const width = GRID_SCALE + 1;

  for (const [sceneId, scene] of entries) {
    const grid = reachableGrid(scene);
    const sceneResult = {
      scene: sceneId,
      start: scene.start || [0.5, 0.5],
      startPassable: grid.startPassable,
      visitedCellCount: grid.visitedCount,
      spotCount: 0,
      reachableSpotCount: 0,
      failures: [],
    };

    if (!grid.startPassable) {
      addDefect(
        "critical",
        sceneId,
        "start",
        "씬 시작 좌표가 통행 가능 셀이 아니어서 내부 BFS를 시작할 수 없습니다.",
      );
    }

    for (const spot of scene.spots || []) {
      sceneResult.spotCount += 1;
      report.sceneBfs.spotCount += 1;
      const candidates = nearbyCells(scene, spot.x, spot.y);
      const reachable = candidates.some(([x, y]) => grid.visited[y * width + x]);
      if (reachable) {
        sceneResult.reachableSpotCount += 1;
        report.sceneBfs.reachableSpotCount += 1;
        continue;
      }

      const reason = candidates.length ? "단절" : "파묻힘";
      const failure = {
        scene: sceneId,
        spot: spot.name || null,
        kind: spot.kind || null,
        reason,
      };
      sceneResult.failures.push(failure);
      report.sceneBfs.failures.push(failure);
      addDefect(
        spotSeverity(spot),
        sceneId,
        spot.name || "이름 없는 스팟",
        `${reason}: 중심 반경 ${SPOT_RADIUS.toFixed(2)} 안의 통행 가능 셀에 시작점에서 도달할 수 없습니다.`,
      );
    }
    report.sceneBfs.scenes.push(sceneResult);
  }
  report.sceneBfs.sceneCount = entries.length;
}

// ── P0-② 기하 검사 (2026-07-28) ─────────────────────────────
function clearanceGrid(scene) {
  // 각 통행 셀의 "가장 가까운 비통행 셀까지 거리"(셀 단위, 4방향 BFS 멀티소스).
  // 회랑 폭 ≈ 클리어런스×2 → 폭 0.06 기준은 클리어런스 3셀(0.03).
  const width = GRID_SCALE + 1;
  const total = width * width;
  const dist = new Int16Array(total).fill(-1);
  const queue = new Int32Array(total);
  let tail = 0;
  for (let iy = 0; iy <= GRID_SCALE; iy += 1) {
    for (let ix = 0; ix <= GRID_SCALE; ix += 1) {
      if (!isWalkable(scene, ix / GRID_SCALE, iy / GRID_SCALE)) {
        const index = iy * width + ix;
        dist[index] = 0;
        queue[tail] = index;
        tail += 1;
      }
    }
  }
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let head = 0; head < tail; head += 1) {
    const current = queue[head];
    const x = current % width;
    const y = Math.floor(current / width);
    for (const [dx, dy] of directions) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx > GRID_SCALE || ny < 0 || ny > GRID_SCALE) continue;
      const index = ny * width + nx;
      if (dist[index] !== -1) continue;
      dist[index] = dist[current] + 1;
      queue[tail] = index;
      tail += 1;
    }
  }
  return dist;
}

function erodedReachable(scene, minClearanceCells) {
  // 클리어런스 미달 셀을 막은 상태로 start에서 BFS → "폭 넓은 길만으로" 도달 가능한 셀
  const width = GRID_SCALE + 1;
  const clearance = clearanceGrid(scene);
  const visited = new Uint8Array(width * width);
  const queue = new Int32Array(width * width);
  const start = scene.start || [0.5, 0.5];
  const sx = Math.round(start[0] * GRID_SCALE);
  const sy = Math.round(start[1] * GRID_SCALE);
  const startIndex = sy * width + sx;
  if (clearance[startIndex] <= 0) return { visited, ok: false };

  // 시드: 시작셀이 넓으면 그대로, 좁으면 "시작 포켓 예외" — 통상 이동으로 8셀 안에서
  // 처음 만나는 넓은 셀들만 시드로 (좁은 시작셀이 침식 검사를 통째로 우회하는 버그 방지)
  const seeds = [];
  if (clearance[startIndex] >= minClearanceCells) {
    seeds.push(startIndex);
  } else {
    const seen = new Uint8Array(width * width);
    const pocket = [startIndex];
    const pocketDist = new Int16Array(width * width);
    seen[startIndex] = 1;
    for (let head0 = 0; head0 < pocket.length; head0 += 1) {
      const current = pocket[head0];
      if (pocketDist[current] >= 8) continue;
      const x = current % width;
      const y = Math.floor(current / width);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx > GRID_SCALE || ny < 0 || ny > GRID_SCALE) continue;
        const index = ny * width + nx;
        if (seen[index] || clearance[index] <= 0) continue;
        seen[index] = 1;
        pocketDist[index] = pocketDist[current] + 1;
        if (clearance[index] >= minClearanceCells) seeds.push(index);
        else pocket.push(index);
      }
    }
    if (!seeds.length) return { visited, ok: false };
  }

  let head = 0;
  let tail = 0;
  for (const seed of seeds) {
    if (visited[seed]) continue;
    visited[seed] = 1;
    queue[tail] = seed;
    tail += 1;
  }
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (head < tail) {
    const current = queue[head];
    head += 1;
    const x = current % width;
    const y = Math.floor(current / width);
    for (const [dx, dy] of directions) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx > GRID_SCALE || ny < 0 || ny > GRID_SCALE) continue;
      const index = ny * width + nx;
      if (visited[index]) continue;
      if (clearance[index] < minClearanceCells) continue;
      visited[index] = 1;
      queue[tail] = index;
      tail += 1;
    }
  }
  return { visited, ok: true };
}

function interiorObstacles(scene) {
  // 씬 가장자리(벽 밴드)가 아닌, 내부에 떠 있는 장애물만
  const EDGE = 0.02;
  return (scene.obstacles || []).filter((o) => (
    o[0] > EDGE && o[1] > EDGE && o[2] < 1 - EDGE && o[3] < 1 - EDGE
  ));
}

function auditSceneGeometry(data) {
  const entries = sceneEntries(data);
  report.sceneGeometry.sceneCount = entries.length;
  const width = GRID_SCALE + 1;
  // 경계 셀이 obstacle 모서리 위에서도 통행 판정(엄격 부등호)이라 회랑이 1셀씩 넓게 잡힘
  // → 임계 4셀이 실질 폭 0.06에 대응 (codex R1 지적 반영)
  const MIN_CLEAR_CELLS = 4;

  for (const [sceneId, scene] of entries) {
    // 1) HERO/대형 내부 장애물 면적 ≤ 10%
    for (const o of interiorObstacles(scene)) {
      const area = Math.max(0, o[2] - o[0]) * Math.max(0, o[3] - o[1]);
      if (area > report.sceneGeometry.heroAreaMax) {
        const violation = {
          scene: sceneId, check: "hero-area",
          detail: `내부 장애물 [${o.join(",")}] 면적 ${(area * 100).toFixed(1)}% > 10% — 충돌은 발밑만(§2-2)`,
        };
        report.sceneGeometry.violations.push(violation);
        addDefect("medium", sceneId, "geometry", violation.detail);
      }
    }

    // 2) 양축 횡단: BFS 도달 셀이 동↔서·남↔북 스팬을 확보하는지 (둘 다 실패 = 중앙 차단)
    const grid = reachableGrid(scene);
    if (grid.startPassable) {
      const walkable = scene.walkable || [0, 0, 1, 1];
      const M = 0.04;
      let west = false; let east = false; let north = false; let south = false;
      for (let iy = 0; iy <= GRID_SCALE; iy += 1) {
        for (let ix = 0; ix <= GRID_SCALE; ix += 1) {
          if (!grid.visited[iy * width + ix]) continue;
          const px = ix / GRID_SCALE;
          const py = iy / GRID_SCALE;
          if (px <= walkable[0] + M) west = true;
          if (px >= walkable[2] - M) east = true;
          if (py <= walkable[1] + M) north = true;
          if (py >= walkable[3] - M) south = true;
        }
      }
      const horizontal = west && east;
      const vertical = north && south;
      if (!horizontal && !vertical) {
        const violation = {
          scene: sceneId, check: "both-axis-block",
          detail: "도달 영역이 가로·세로 어느 축으로도 횡단하지 못합니다 — 중앙 장애물 양축 차단 금지(§2-1)",
        };
        report.sceneGeometry.violations.push(violation);
        addDefect("medium", sceneId, "geometry", violation.detail);
      }
    }

    // 3) 병목 폭: 폭 0.06 미만 길만으로 이어진 주요 전환구는 위반
    //    (일반 BFS론 도달하는데 침식 BFS론 못 가면 = 그 길목이 좁다)
    const eroded = erodedReachable(scene, MIN_CLEAR_CELLS);
    if (grid.startPassable && eroded.ok) {
      for (const spot of scene.spots || []) {
        if (!["stair", "gate", "door", "elevator", "exit"].includes(spot.kind)) continue;
        const cells = nearbyCells(scene, spot.x, spot.y);
        const normalOk = cells.some(([x, y]) => grid.visited[y * width + x]);
        if (!normalOk) continue; // 도달 불가는 BFS 감사가 이미 잡음
        const wideOk = cells.some(([x, y]) => eroded.visited[y * width + x])
          // 스팟 바로 앞은 좁아도 됨 — 근접 타원을 조금 넓혀 재확인
          || nearbyCells(scene, spot.x, spot.y, 1.6)
            .some(([x, y]) => eroded.visited[y * width + x]);
        if (!wideOk) {
          const violation = {
            scene: sceneId, check: "bottleneck",
            spot: spot.name || null,
            detail: `"${spot.name}"까지의 주 동선이 폭 ${report.sceneGeometry.minCorridor} 미만 길목에 의존합니다(§2-1)`,
          };
          report.sceneGeometry.violations.push(violation);
          addDefect("medium", sceneId, spot.name || "geometry", violation.detail);
        }
      }
    }
  }
}

function auditAnchorAlignment(data) {
  // 씬별 스펙 파일(tools/audit/anchors/<scene>.json)이 있으면 대조.
  // 형식: [{name, x, y, matchSpot?: "스팟이름", expect?: "walkable"|"obstacle", tol?: 0.05}]
  const anchorsDir = path.join(__dirname, "anchors");
  if (!fs.existsSync(anchorsDir)) return;
  const sceneMap = new Map(sceneEntries(data).map(([sceneId, scene]) => [sceneId, scene]));
  for (const file of fs.readdirSync(anchorsDir).filter((f) => f.endsWith(".json"))) {
    const sceneId = path.basename(file, ".json");
    const scene = sceneMap.get(sceneId);
    if (!scene) {
      addDefect("medium", sceneId, "anchors", `앵커 스펙이 있으나 씬이 존재하지 않습니다: ${file}`);
      continue;
    }
    let anchors;
    try {
      anchors = JSON.parse(fs.readFileSync(path.join(anchorsDir, file), "utf8"));
    } catch (error) {
      addDefect("medium", sceneId, "anchors", `앵커 스펙 파싱 실패: ${errorText(error)}`);
      continue;
    }
    report.anchorAlignment.specCount += 1;
    for (const anchor of anchors) {
      report.anchorAlignment.checkedAnchors += 1;
      const tol = anchor.tol ?? 0.05;
      if (anchor.matchSpot) {
        const spot = (scene.spots || []).find((s) => s.name === anchor.matchSpot);
        if (!spot) {
          const failure = { scene: sceneId, anchor: anchor.name, reason: `스팟 "${anchor.matchSpot}" 없음` };
          report.anchorAlignment.failures.push(failure);
          addDefect("medium", sceneId, anchor.name, failure.reason);
          continue;
        }
        const dx = Math.abs(spot.x - anchor.x);
        const dy = Math.abs(spot.y - anchor.y);
        if (dx > tol || dy > tol) {
          const failure = {
            scene: sceneId, anchor: anchor.name,
            reason: `스팟 위치 (${spot.x},${spot.y})가 스펙 (${anchor.x},${anchor.y})에서 (${dx.toFixed(3)},${dy.toFixed(3)}) 벗어남 (tol ${tol})`,
          };
          report.anchorAlignment.failures.push(failure);
          addDefect("medium", sceneId, anchor.name, failure.reason);
        }
      } else if (anchor.expect) {
        const walkableHere = isWalkable(scene, anchor.x, anchor.y);
        const pass = anchor.expect === "walkable" ? walkableHere : !walkableHere;
        if (!pass) {
          const failure = {
            scene: sceneId, anchor: anchor.name,
            reason: `(${anchor.x},${anchor.y})가 스펙상 ${anchor.expect}여야 하는데 아닙니다`,
          };
          report.anchorAlignment.failures.push(failure);
          addDefect("medium", sceneId, anchor.name, failure.reason);
        }
      }
    }
  }
}

const SMOKE_VIEWPORTS = [
  { name: "phone-portrait", width: 430, height: 820 },
  { name: "phone-landscape", width: 820, height: 430 },
  { name: "small-portrait", width: 320, height: 568 },
];

async function smokeOnePage(browser, url, viewport, label) {
  const result = {
    label, viewport: viewport.name, url,
    loaded: false, pageErrors: [], overflowX: null,
  };
  let context;
  try {
    context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: true, isMobile: true,
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => result.pageErrors.push(error.message));
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
    result.loaded = true;
    await delay(500);
    result.overflowX = await withTimeout(page.evaluate(() => {
      const el = document.scrollingElement || document.documentElement;
      return el.scrollWidth > innerWidth + 1;
    }), 2000, "가로 넘침 검사");
  } catch (error) {
    result.loadError = errorText(error);
  } finally {
    if (context) await context.close().catch(() => {});
  }
  result.pageErrors = uniqueBy(result.pageErrors, (item) => item);
  return result;
}

async function auditViewportSmoke(browser, data) {
  report.viewportSmoke.viewports = SMOKE_VIEWPORTS.map((v) => v.name);
  const targets = [];
  for (const viewport of SMOKE_VIEWPORTS) {
    targets.push({ url: `${BASE_URL}/h.html`, viewport, label: "h.html" });
  }
  // 미니게임은 가로뷰만 (B관 게임 가로 잘림 사고 재발 방지 지점)
  const landscape = SMOKE_VIEWPORTS[1];
  for (const entry of collectMiniGameFiles(data)) {
    if (entry.source !== "game") continue;
    targets.push({ url: `${BASE_URL}/${entry.file}`, viewport: landscape, label: entry.item });
  }
  const results = await mapLimit(targets, 3, async (target) => {
    if (Date.now() - startedAt >= OVERALL_TIMEOUT_MS) {
      return { label: target.label, viewport: target.viewport.name, url: target.url,
        loaded: false, pageErrors: [], overflowX: null, loadError: "전체 제한 시간 도달" };
    }
    return smokeOnePage(browser, target.url, target.viewport, target.label);
  });
  report.viewportSmoke.results = results;
  for (const result of results) {
    if (!result.loaded) {
      addDefect("medium", null, result.label, `[${result.viewport}] 로드 실패: ${result.loadError || "?"}`);
    }
    if (result.overflowX) {
      addDefect("medium", null, result.label, `[${result.viewport}] 가로 스크롤 넘침 — 뷰포트에 안 맞습니다`);
    }
    for (const detail of result.pageErrors) {
      addDefect("medium", null, result.label, `[${result.viewport}] pageerror: ${detail}`);
    }
  }
}

function validFilePath(relativeFile) {
  if (typeof relativeFile !== "string" || !relativeFile.trim()) return null;
  const clean = relativeFile.split(/[?#]/, 1)[0];
  const absolute = path.resolve(REPO_ROOT, clean);
  const relative = path.relative(REPO_ROOT, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return absolute;
}

function auditDataIntegrity(data) {
  const defectCountBefore = report.defects.length;
  const entries = sceneEntries(data);
  const floorIds = new Set((data.FLOORS || []).map((floor) => floor.id));
  const roomIds = new Set(Object.keys(data.ROOMS || {}));
  const sceneMap = new Map(entries.map(([sceneId, scene]) => [sceneId, scene]));
  const exhibits = [];

  for (const [sceneId, scene] of entries) {
    for (const spot of scene.spots || []) {
      report.dataIntegrity.checkedSpots += 1;
      if (pointInObstacle(scene.obstacles, spot.x, spot.y)) {
        const nearby = nearbyCells(scene, spot.x, spot.y);
        // 통행셀이 근처에 있으면 "전시물 위 마커 + 앞에서 상호작용" = 의도된 설계 → minor (2026-07-26 보정)
        addDefect(
          nearby.length ? "minor" : "critical",
          sceneId,
          spot.name || "이름 없는 스팟",
          nearby.length
            ? `[설계상 정상 가능] 스팟 중심이 obstacle 안이지만 근접 타원 안에 통행셀이 있습니다.`
            : `스팟 중심이 obstacle 안이고 근접 타원 안에 통행셀이 없습니다.`,
        );
      }

      if (spot.kind === "door" && !roomIds.has(spot.room)) {
        addDefect("critical", sceneId, spot.name, `door.room "${spot.room}"이 ROOMS에 없습니다.`);
      }
      if (
        (spot.kind === "stair" || spot.kind === "gate")
        && !floorIds.has(spot.to)
      ) {
        addDefect(
          "critical",
          sceneId,
          spot.name,
          `${spot.kind}.to "${spot.to}"가 FLOORS에 없습니다.`,
        );
      }
      if (spot.kind === "elevator") {
        for (const floorId of spot.floors || []) {
          if (!floorIds.has(floorId)) {
            addDefect(
              "critical",
              sceneId,
              spot.name,
              `elevator.floors의 "${floorId}"가 FLOORS에 없습니다.`,
            );
          }
        }
      }
      if (spot.kind === "game") {
        report.dataIntegrity.checkedGames += 1;
        const absolute = validFilePath(spot.file);
        if (!absolute || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
          addDefect(
            "critical",
            sceneId,
            spot.name,
            `game.file "${spot.file}"을 repo 안에서 찾을 수 없습니다.`,
          );
        }
      }
      if (spot.kind === "exhibit") {
        exhibits.push({
          sceneId,
          spot,
        });
      }
    }

    for (const zone of scene.zones || []) {
      if (!floorIds.has(zone.to)) {
        addDefect(
          "critical",
          sceneId,
          "zone",
          `zones.to "${zone.to}"가 FLOORS에 없습니다.`,
        );
      }
    }
  }

  const npcGroups = [
    ["GUIDE_NPCS", data.GUIDE_NPCS || []],
    ["SECURITY_NPCS", data.SECURITY_NPCS || []],
    ["CLEANING_NPCS", data.CLEANING_NPCS || []],
  ];
  for (const [groupName, npcs] of npcGroups) {
    for (const npc of npcs) {
      report.dataIntegrity.checkedNpcs += 1;
      const scene = sceneMap.get(npc.scene);
      if (!scene) {
        addDefect(
          "critical",
          npc.scene,
          npc.name || groupName,
          `${groupName}의 scene이 존재하지 않습니다.`,
        );
        continue;
      }
      const start = groupName === "SECURITY_NPCS" && npc.waypoints?.length
        ? npc.waypoints[0]
        : [npc.x, npc.y];
      if (pointInObstacle(scene.obstacles, start[0], start[1])) {
        const nearby = nearbyCells(scene, start[0], start[1]);
        addDefect(
          nearby.length ? "medium" : "critical",
          npc.scene,
          npc.name || groupName,
          nearby.length
            ? `NPC 시작좌표가 obstacle 안이지만 반경 ${SPOT_RADIUS.toFixed(2)} 안에 통행셀이 있습니다.`
            : `NPC 시작좌표가 obstacle 안이고 반경 ${SPOT_RADIUS.toFixed(2)} 안에 통행셀이 없습니다.`,
        );
      }
    }
  }

  report.dataIntegrity.checkedExhibits = exhibits.length;
  const qidHashes = new Map();
  const hashQids = new Map();
  for (const {
    sceneId,
    spot,
  } of exhibits) {
    const hasQid = typeof spot.qid === "string" && spot.qid.length > 0;
    const hasHash = typeof spot.khash === "string" && spot.khash.length > 0;
    if (hasQid !== hasHash || !hasQid) {
      addDefect(
        "medium",
        sceneId,
        spot.name,
        `exhibit qid↔khash 짝이 완전하지 않습니다(qid=${hasQid}, khash=${hasHash}).`,
      );
    }
    if (hasQid && !/^[a-z-]+$/.test(spot.qid)) {
      addDefect("minor", sceneId, spot.name, `qid 형식이 올바르지 않습니다: "${spot.qid}"`);
    }
    if (hasHash && !/^[0-9a-f]{64}$/i.test(spot.khash)) {
      addDefect("minor", sceneId, spot.name, `khash가 SHA-256 hex 형식이 아닙니다: "${spot.khash}"`);
    }
    if (hasQid) {
      if (!qidHashes.has(spot.qid)) qidHashes.set(spot.qid, new Set());
      qidHashes.get(spot.qid).add(spot.khash || "");
    }
    if (hasHash) {
      if (!hashQids.has(spot.khash)) hashQids.set(spot.khash, new Set());
      hashQids.get(spot.khash).add(spot.qid || "");
    }
  }
  for (const [qid, hashes] of qidHashes) {
    if (hashes.size > 1) {
      addDefect(
        "critical",
        null,
        qid,
        `하나의 qid가 여러 khash와 연결됩니다: ${[...hashes].join(", ")}`,
      );
    }
  }
  for (const [hash, qids] of hashQids) {
    if (qids.size > 1) {
      addDefect(
        "medium",
        null,
        hash,
        `하나의 khash가 여러 qid와 연결됩니다: ${[...qids].join(", ")}`,
      );
    }
  }

  const catalog = Array.isArray(data.ALL_EXHIBITS) ? data.ALL_EXHIBITS : null;
  if (!catalog) {
    addDefect("medium", null, "ALL_EXHIBITS", "도감 배열을 런타임에서 추출할 수 없습니다.");
  } else {
    const sourceKeys = new Set(exhibits.map((entry) => (
      `${entry.sceneId}\u0000${entry.spot.qid || ""}\u0000${entry.spot.name || ""}`
    )));
    const catalogKeys = new Set(catalog.map((entry) => (
      `${entry.roomId || ""}\u0000${entry.qid || ""}\u0000${entry.name || ""}`
    )));
    report.dataIntegrity.catalogMissing = [...sourceKeys]
      .filter((key) => !catalogKeys.has(key))
      .map((key) => key.split("\u0000").join(" / "));
    report.dataIntegrity.catalogExtra = [...catalogKeys]
      .filter((key) => !sourceKeys.has(key))
      .map((key) => key.split("\u0000").join(" / "));

    for (const missing of report.dataIntegrity.catalogMissing) {
      addDefect("medium", null, "ALL_EXHIBITS", `도감 배열에 전시물이 누락되었습니다: ${missing}`);
    }
    for (const extra of report.dataIntegrity.catalogExtra) {
      addDefect("minor", null, "ALL_EXHIBITS", `도감 배열에 원본에 없는 항목이 있습니다: ${extra}`);
    }
  }

  report.dataIntegrity.issueCount = report.defects.length - defectCountBefore;
}

async function exportRuntime(browser) {
  const context = await browser.newContext({
    viewport: {
      width: 430,
      height: 820,
    },
  });
  const page = await context.newPage();
  const diagnostics = [];

  page.on("pageerror", (error) => {
    diagnostics.push({
      type: "pageerror",
      detail: error.message,
    });
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      diagnostics.push({
        type: "console.error",
        detail: message.text(),
      });
    }
  });

  try {
    await page.goto(`${BASE_URL}/h.html`, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_TIMEOUT_MS,
    });
    const data = await withTimeout(page.evaluate(() => {
      const values = {
        FLOORS,
        ROOMS,
        GUIDE_NPCS,
        SECURITY_NPCS,
        CLEANING_NPCS,
        ALL_EXHIBITS: typeof ALL_EXHIBITS === "undefined" ? null : ALL_EXHIBITS,
        STAMPS: typeof STAMPS === "undefined" ? null : STAMPS,
      };
      return JSON.parse(JSON.stringify(values, (key, value) => (
        typeof value === "function" ? undefined : value
      )));
    }), 5000, "런타임 데이터 export");

    report.runtimeExport.ok = true;
    report.runtimeExport.counts = {
      floors: data.FLOORS?.length || 0,
      rooms: Object.keys(data.ROOMS || {}).length,
      guideNpcs: data.GUIDE_NPCS?.length || 0,
      securityNpcs: data.SECURITY_NPCS?.length || 0,
      cleaningNpcs: data.CLEANING_NPCS?.length || 0,
      exhibits: data.ALL_EXHIBITS?.length || 0,
      stamps: data.STAMPS?.length || 0,
    };
    report.runtimeExport.data = data;
    return data;
  } finally {
    report.runtimeExport.diagnostics = diagnostics;
    await context.close().catch(() => {});
  }
}

function collectMiniGameFiles(data) {
  const gameFiles = [];
  for (const [sceneId, scene] of sceneEntries(data)) {
    for (const spot of scene.spots || []) {
      if (spot.kind !== "game" || typeof spot.file !== "string") continue;
      gameFiles.push({
        file: spot.file,
        source: "game",
        scene: sceneId,
        item: spot.name || spot.file,
      });
    }
  }
  const uniqueGames = uniqueBy(gameFiles, (entry) => entry.file);
  const prototypeDir = path.join(REPO_ROOT, "prototypes");
  const prototypes = fs.existsSync(prototypeDir)
    ? fs.readdirSync(prototypeDir)
      .filter((file) => /^proto_.*\.html$/.test(file))
      .sort()
      .map((file) => ({
        file: `prototypes/${file}`,
        source: "prototype",
        scene: "prototypes",
        item: file,
      }))
    : [];
  return [...uniqueGames, ...prototypes];
}

function seededRandom(seedText) {
  let state = 2166136261;
  for (let i = 0; i < seedText.length; i += 1) {
    state ^= seedText.charCodeAt(i);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

async function interactionBox(page) {
  return withTimeout(page.evaluate(() => {
    const canvases = [...document.querySelectorAll("canvas")]
      .map((element) => ({
        element,
        rect: element.getBoundingClientRect(),
      }))
      .filter((entry) => entry.rect.width > 20 && entry.rect.height > 20)
      .sort((a, b) => (
        b.rect.width * b.rect.height - a.rect.width * a.rect.height
      ));
    const target = canvases[0]?.element
      || document.querySelector("main, [id*='stage'], [class*='stage'], body");
    const rect = target?.getBoundingClientRect();
    if (!rect || rect.width < 20 || rect.height < 20) {
      return {
        x: 0,
        y: 0,
        width: innerWidth,
        height: innerHeight,
      };
    }
    return {
      x: Math.max(0, rect.left),
      y: Math.max(0, rect.top),
      width: Math.min(innerWidth, rect.right) - Math.max(0, rect.left),
      height: Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top),
    };
  }), 2000, "상호작용 영역 탐지");
}

async function clickStartButton(page) {
  return withTimeout(page.evaluate(() => {
    const visible = (button) => {
      const style = getComputedStyle(button);
      const rect = button.getBoundingClientRect();
      return (
        !button.disabled
        && style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity) !== 0
        && rect.width > 0
        && rect.height > 0
      );
    };
    const buttons = [...document.querySelectorAll("button")].filter(visible);
    const priorities = [
      /시작|출발|플레이/,
      /도전/,
    ];
    for (const pattern of priorities) {
      const button = buttons.find((candidate) => (
        pattern.test((candidate.innerText || candidate.textContent || "").trim())
      ));
      if (!button) continue;
      const text = (button.innerText || button.textContent || "").trim();
      button.click();
      return text;
    }
    return null;
  }), 2000, "시작 버튼 탐지");
}

async function randomTouches(page, file) {
  const random = seededRandom(file);
  const errors = [];
  const box = await interactionBox(page);
  const session = await page.context().newCDPSession(page);
  const deadline = Date.now() + MINI_PLAY_MS;
  let actionCount = 0;

  const point = () => {
    const marginX = Math.min(18, box.width * 0.08);
    const marginY = Math.min(18, box.height * 0.08);
    return {
      x: box.x + marginX + random() * Math.max(1, box.width - marginX * 2),
      y: box.y + marginY + random() * Math.max(1, box.height - marginY * 2),
    };
  };

  while (Date.now() < deadline) {
    const start = point();
    const end = point();
    const drag = actionCount % 2 === 1;
    try {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{
          x: start.x,
          y: start.y,
          radiusX: 2,
          radiusY: 2,
          force: 1,
          id: 1,
        }],
      });
      if (drag) {
        for (let step = 1; step <= 3; step += 1) {
          const ratio = step / 3;
          await session.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{
              x: start.x + (end.x - start.x) * ratio,
              y: start.y + (end.y - start.y) * ratio,
              radiusX: 2,
              radiusY: 2,
              force: 1,
              id: 1,
            }],
          });
          await delay(25);
        }
      }
      await session.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    } catch (error) {
      errors.push(error.message || String(error));
      try {
        await session.send("Input.dispatchTouchEvent", {
          type: "touchCancel",
          touchPoints: [],
        });
      } catch (_) {
        // 페이지가 닫힌 경우에는 취소 이벤트도 보낼 수 없다.
      }
    }
    actionCount += 1;
    await delay(80);
  }

  await session.detach().catch(() => {});
  return {
    actionCount,
    errors: uniqueBy(errors, (error) => error),
  };
}

async function readRafCount(page) {
  return withTimeout(page.evaluate(() => window.__auditRafCount || 0), 2000, "rAF 카운터 읽기");
}

async function auditMiniGame(browser, entry) {
  const result = {
    ...entry,
    url: `${BASE_URL}/${entry.file}`,
    loaded: false,
    startButton: null,
    actionCount: 0,
    interactionErrors: [],
    rafBefore: null,
    rafAfter: null,
    frozen: null,
    returnAnchor: null,
    pageErrors: [],
    consoleErrors: [],
    failedRequests: [],
    httpErrors: [],
    durationMs: 0,
  };
  const miniStartedAt = Date.now();
  const context = await browser.newContext({
    viewport: {
      width: 430,
      height: 820,
    },
    hasTouch: true,
    isMobile: true,
  });

  await context.addInitScript(() => {
    try {
      localStorage.clear();
    } catch (_) {
      // 저장소가 차단된 페이지도 나머지 감사는 계속한다.
    }
    window.__auditRafCount = 0;
    const auditTick = () => {
      window.__auditRafCount += 1;
      requestAnimationFrame(auditTick);
    };
    requestAnimationFrame(auditTick);
  });

  const page = await context.newPage();
  page.on("pageerror", (error) => result.pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") result.consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    result.failedRequests.push({
      url: request.url(),
      error: request.failure()?.errorText || "unknown",
    });
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      result.httpErrors.push({
        url: response.url(),
        status: response.status(),
      });
    }
  });
  page.on("dialog", (dialog) => dialog.accept().catch(() => {}));

  try {
    await page.goto(result.url, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_TIMEOUT_MS,
    });
    result.loaded = true;
    await delay(300);
    result.startButton = await clickStartButton(page);
    await delay(200);
    result.rafBefore = await readRafCount(page);
    const interactions = await randomTouches(page, entry.file);
    result.actionCount = interactions.actionCount;
    result.interactionErrors = interactions.errors;
    const sampleStart = await readRafCount(page);
    await delay(400);
    result.rafAfter = await readRafCount(page);
    result.frozen = result.rafAfter <= sampleStart;
    result.returnAnchor = await withTimeout(page.evaluate(() => {
      const anchor = [...document.querySelectorAll("a")].find((candidate) => (
        /허브|갤러리/.test([
          candidate.textContent || "",
          candidate.getAttribute("aria-label") || "",
          candidate.getAttribute("title") || "",
        ].join(" "))
      ));
      return anchor
        ? {
          text: (anchor.textContent || "").trim(),
          href: anchor.getAttribute("href"),
        }
        : null;
    }), 2000, "복귀 앵커 검사");
  } catch (error) {
    result.loadError = errorText(error);
  } finally {
    result.pageErrors = uniqueBy(result.pageErrors, (item) => item);
    result.consoleErrors = uniqueBy(result.consoleErrors, (item) => item);
    result.failedRequests = uniqueBy(
      result.failedRequests,
      (item) => `${item.url}\u0000${item.error}`,
    );
    result.httpErrors = uniqueBy(
      result.httpErrors,
      (item) => `${item.url}\u0000${item.status}`,
    );
    result.durationMs = Date.now() - miniStartedAt;
    await withTimeout(context.close(), 3000, "미니게임 컨텍스트 종료").catch(() => {});
  }
  return result;
}

function recordMiniDefects(result) {
  if (!result.loaded) {
    addDefect(
      "critical",
      result.scene,
      result.item,
      `미니게임을 로드하지 못했습니다: ${result.loadError || "알 수 없는 오류"}`,
    );
  }
  if (result.frozen) {
    addDefect("critical", result.scene, result.item, "rAF 카운터가 증가하지 않아 프리즈로 판정했습니다.");
  }
  if (result.loaded && !result.returnAnchor) {
    addDefect("medium", result.scene, result.item, "DOM에 '허브' 또는 '갤러리' 복귀 앵커가 없습니다.");
  }
  for (const detail of result.pageErrors) {
    addDefect("critical", result.scene, result.item, `pageerror: ${detail}`);
  }
  for (const detail of result.consoleErrors) {
    addDefect("medium", result.scene, result.item, `console.error: ${detail}`);
  }
  for (const failure of result.failedRequests) {
    addDefect(
      "medium",
      result.scene,
      result.item,
      `requestfailed: ${failure.url} (${failure.error})`,
    );
  }
  for (const httpError of result.httpErrors) {
    addDefect(
      "medium",
      result.scene,
      result.item,
      `HTTP ${httpError.status}: ${httpError.url}`,
    );
  }
  for (const detail of result.interactionErrors) {
    addDefect("minor", result.scene, result.item, `무작위 입력 오류: ${detail}`);
  }
}

async function auditMiniGames(browser, data) {
  const entries = collectMiniGameFiles(data);
  report.miniGameHygiene.fileCount = entries.length;
  const results = await mapLimit(entries, 3, async (entry) => {
    if (Date.now() - startedAt >= OVERALL_TIMEOUT_MS) {
      return {
        ...entry,
        url: `${BASE_URL}/${entry.file}`,
        loaded: false,
        frozen: null,
        returnAnchor: null,
        pageErrors: [],
        consoleErrors: [],
        failedRequests: [],
        httpErrors: [],
        interactionErrors: [],
        actionCount: 0,
        durationMs: 0,
        loadError: "전체 감사 제한 시간에 도달해 실행하지 못했습니다.",
      };
    }
    try {
      return await auditMiniGame(browser, entry);
    } catch (error) {
      return {
        ...entry,
        url: `${BASE_URL}/${entry.file}`,
        loaded: false,
        frozen: null,
        returnAnchor: null,
        pageErrors: [],
        consoleErrors: [],
        failedRequests: [],
        httpErrors: [],
        interactionErrors: [],
        actionCount: 0,
        durationMs: 0,
        loadError: errorText(error),
      };
    }
  });
  report.miniGameHygiene.results = results;
  report.miniGameHygiene.completedCount = results.filter((result) => result.loaded).length;
  for (const result of results) recordMiniDefects(result);
}

async function auditFloorResources(browser, data) {
  const floors = data.FLOORS || [];
  report.resources.floorCount = floors.length;
  const results = await mapLimit(floors, 3, async (floor, index) => {
    const result = {
      index,
      floor: floor.id,
      url: `${BASE_URL}/h.html?f=${index}`,
      loaded: false,
      failedRequests: [],
      httpErrors: [],
    };
    if (Date.now() - startedAt >= OVERALL_TIMEOUT_MS) {
      result.loadError = "전체 감사 제한 시간에 도달해 실행하지 못했습니다.";
      return result;
    }

    let context;
    try {
      context = await browser.newContext({
        viewport: {
          width: 430,
          height: 820,
        },
      });
      const page = await context.newPage();
      page.on("requestfailed", (request) => {
        result.failedRequests.push({
          url: request.url(),
          error: request.failure()?.errorText || "unknown",
        });
      });
      page.on("response", (response) => {
        if (response.status() >= 400) {
          result.httpErrors.push({
            url: response.url(),
            status: response.status(),
          });
        }
      });
      await page.goto(result.url, {
        waitUntil: "domcontentloaded",
        timeout: PAGE_TIMEOUT_MS,
      });
      result.loaded = true;
      await page.waitForFunction(() => (
        document.querySelector("#boot")?.style.display === "none"
      ), null, {
        timeout: 8000,
      }).catch(() => {});
      await delay(300);
    } catch (error) {
      result.loadError = errorText(error);
    } finally {
      result.failedRequests = uniqueBy(
        result.failedRequests,
        (item) => `${item.url}\u0000${item.error}`,
      );
      result.httpErrors = uniqueBy(
        result.httpErrors,
        (item) => `${item.url}\u0000${item.status}`,
      );
      if (context) await context.close().catch(() => {});
    }
    return result;
  });

  report.resources.floors = results;
  report.resources.completedCount = results.filter((result) => result.loaded).length;
  report.resources.failedRequests = uniqueBy(
    results.flatMap((result) => result.failedRequests.map((failure) => ({
      floor: result.floor,
      ...failure,
    }))),
    (item) => `${item.floor}\u0000${item.url}\u0000${item.error}`,
  );
  report.resources.httpErrors = uniqueBy(
    results.flatMap((result) => result.httpErrors.map((failure) => ({
      floor: result.floor,
      ...failure,
    }))),
    (item) => `${item.floor}\u0000${item.url}\u0000${item.status}`,
  );

  for (const result of results) {
    if (!result.loaded) {
      addDefect(
        "critical",
        result.floor,
        "h.html resources",
        `층 리소스 순회를 완료하지 못했습니다: ${result.loadError || "알 수 없는 오류"}`,
      );
    }
    for (const failure of result.failedRequests) {
      addDefect(
        "medium",
        result.floor,
        "resource",
        `requestfailed: ${failure.url} (${failure.error})`,
      );
    }
    for (const httpError of result.httpErrors) {
      addDefect(
        "medium",
        result.floor,
        "resource",
        `HTTP ${httpError.status}: ${httpError.url}`,
      );
    }
  }
}

function printSummary() {
  const severities = {
    critical: 0,
    medium: 0,
    minor: 0,
  };
  for (const defect of report.defects) severities[defect.severity] += 1;
  const miniErrors = report.miniGameHygiene.results.reduce((sum, result) => (
    sum
    + result.pageErrors.length
    + result.consoleErrors.length
    + result.failedRequests.length
    + result.httpErrors.length
  ), 0);

  console.log(
    `[런타임 export] ${report.runtimeExport.ok ? "성공" : "실패"}`
    + ` · 층 ${report.runtimeExport.counts.floors || 0}`
    + ` · 방 ${report.runtimeExport.counts.rooms || 0}`
    + ` · 전시물 ${report.runtimeExport.counts.exhibits || 0}`
    + ` · 스탬프 ${report.runtimeExport.counts.stamps || 0}`,
  );
  console.log(
    `[씬 그래프] 씬 ${report.sceneGraph.sceneCount}`
    + ` · 간선 ${report.sceneGraph.edgeCount}`
    + ` · 도달 불가 쌍 ${report.sceneGraph.unreachablePairs.length}`,
  );
  console.log(
    `[씬 내부 BFS] 씬 ${report.sceneBfs.sceneCount}`
    + ` · 스팟 ${report.sceneBfs.spotCount}`
    + ` · 성공 ${report.sceneBfs.reachableSpotCount}`
    + ` · 실패 ${report.sceneBfs.failures.length}`,
  );
  console.log(
    `[데이터 정합성] 스팟 ${report.dataIntegrity.checkedSpots}`
    + ` · NPC ${report.dataIntegrity.checkedNpcs}`
    + ` · 게임 ${report.dataIntegrity.checkedGames}`
    + ` · 전시물 ${report.dataIntegrity.checkedExhibits}`,
  );
  console.log(
    `[미니게임 위생] 파일 ${report.miniGameHygiene.fileCount}`
    + ` · 로드 ${report.miniGameHygiene.completedCount}`
    + ` · 오류/실패 리소스 ${miniErrors}`,
  );
  console.log(
    `[리소스] 층 ${report.resources.floorCount}`
    + ` · 완료 ${report.resources.completedCount}`
    + ` · requestfailed ${report.resources.failedRequests.length}`
    + ` · 4xx+ ${report.resources.httpErrors.length}`,
  );
  console.log(
    `[기하] 씬 ${report.sceneGeometry.sceneCount}`
    + ` · 위반 ${report.sceneGeometry.violations.length}`
    + ` (병목 ${report.sceneGeometry.violations.filter((v) => v.check === "bottleneck").length}`
    + ` · 양축 ${report.sceneGeometry.violations.filter((v) => v.check === "both-axis-block").length}`
    + ` · HERO ${report.sceneGeometry.violations.filter((v) => v.check === "hero-area").length})`,
  );
  console.log(
    `[앵커 정합] 스펙 ${report.anchorAlignment.specCount}`
    + ` · 앵커 ${report.anchorAlignment.checkedAnchors}`
    + ` · 실패 ${report.anchorAlignment.failures.length}`,
  );
  console.log(
    `[뷰포트 스모크] 대상 ${report.viewportSmoke.results.length}`
    + ` · 가로넘침 ${report.viewportSmoke.results.filter((r) => r.overflowX).length}`
    + ` · 로드실패 ${report.viewportSmoke.results.filter((r) => !r.loaded).length}`,
  );
  console.log(
    `[결함] critical ${severities.critical}`
    + ` · medium ${severities.medium}`
    + ` · minor ${severities.minor}`,
  );
  console.log(`[보고서] ${REPORT_PATH}`);
}

async function main() {
  let browser;
  let data;

  try {
    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
    });
    try {
      data = await exportRuntime(browser);
    } catch (error) {
      const detail = errorText(error);
      report.runtimeExport.diagnostics.push({
        type: "export-error",
        detail,
      });
      addDefect("critical", "h.html", "runtime-export", detail);
    }

    if (data) {
      auditSceneGraph(data);
      auditSceneBfs(data);
      auditSceneGeometry(data);
      auditAnchorAlignment(data);
      auditDataIntegrity(data);
      await auditMiniGames(browser, data);
      await auditFloorResources(browser, data);
      await auditViewportSmoke(browser, data);
    }
  } catch (error) {
    if (!browser) {
      report.runtimeExport.diagnostics.push({
        type: "browser-launch-error",
        detail: errorText(error),
      });
      addDefect("critical", "h.html", "runtime-export", errorText(error));
    } else {
      addDefect("critical", null, "audit-runner", errorText(error));
    }
  } finally {
    if (browser) {
      await withTimeout(browser.close(), 5000, "브라우저 종료").catch(() => {});
    }
    writeReport();
    printSummary();
  }
}

main();
