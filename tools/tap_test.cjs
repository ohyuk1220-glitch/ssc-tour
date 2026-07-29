#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  chromium,
} = require("/Users/a55/.claude/skills/gstack/node_modules/playwright-core");

const BASE_URL = "http://localhost:8899";
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGE_TIMEOUT_MS = 15000;
const TEST_TIMEOUT_MS = 20000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForScene(page, sceneId) {
  await page.waitForFunction(
    (expected) => curSceneId() === expected && fadeState === 0,
    sceneId,
    { timeout: TEST_TIMEOUT_MS },
  );
}

async function tapAt(page, point) {
  assert(Number.isFinite(point.x) && Number.isFinite(point.y), "탭 좌표가 유효해야 합니다.");
  assert(point.x >= 0 && point.x <= 900 && point.y >= 0 && point.y <= 700, "탭 대상이 뷰포트 안에 있어야 합니다.");
  await page.mouse.click(point.x, point.y);
}

async function assertPositionStable(page, waitMs = 900, tolerance = 0.004) {
  const before = await page.evaluate(() => ({ x: player.px, y: player.py, scene: curSceneId() }));
  await delay(waitMs);
  const after = await page.evaluate(() => ({ x: player.px, y: player.py, scene: curSceneId() }));
  assert.equal(after.scene, before.scene, "안정 구간에서 씬이 다시 전환되면 안 됩니다.");
  assert(
    Math.hypot(after.x - before.x, after.y - before.y) <= tolerance,
    `안정 구간에서 플레이어가 움직였습니다: ${JSON.stringify({ before, after })}`,
  );
}

async function runWithPage(browser, path, test) {
  const context = await browser.newContext({
    viewport: { width: 900, height: 700 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await page.goto(`${BASE_URL}/${path}`, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_TIMEOUT_MS,
    });
    await page.waitForFunction(
      () => document.getElementById("boot").style.display === "none",
      null,
      { timeout: PAGE_TIMEOUT_MS },
    );
    await test(page);
    assert.deepEqual(pageErrors, [], `페이지 오류: ${pageErrors.join(" | ")}`);
  } finally {
    await context.close();
  }
}

const scenarios = [
  {
    name: "① SQRT2 왕복 뒤 재전환 루프 없음",
    run: async (browser) => runWithPage(browser, "h.html?f=1F", async (page) => {
      await page.evaluate(() => {
        player.px = 0.69;
        player.py = 0.09;
        player.vx = player.vy = 0;
        camX = player.px;
        camY = player.py;
        resetWalkInArming();
      });
      await waitForScene(page, "SQRT2");
      await assertPositionStable(page);

      const activated = await page.evaluate(() => {
        const down = curScene().spots.find((spot) => spot.kind === "stair" && spot.to === "1F");
        return activateTarget(down);
      });
      assert.equal(activated, true, "√2층의 1층행 계단이 실행되어야 합니다.");
      await waitForScene(page, "1F");
      await assertPositionStable(page);

      await page.evaluate(() => {
        player.px = 0.69;
        player.py = 0.09;
        player.vx = player.vy = 0;
        camX = player.px;
        camY = player.py;
      });
      await waitForScene(page, "SQRT2");
      await assertPositionStable(page, 1100);
    }),
  },
  {
    name: "② 이동 NPC 탭 추적 후 탭한 객체와 대화",
    run: async (browser) => runWithPage(browser, "h.html?f=2F", async (page) => {
      const point = await page.evaluate(() => {
        const npc = SECURITY_NPCS.find((item) => item.scene === "2F");
        npc.x = 0.18;
        npc.y = 0.58;
        npc._pause = 0;
        npc._tgt = [0.82, 0.58];
        player.px = 0.78;
        player.py = 0.72;
        player.vx = player.vy = 0;
        camX = 0.5;
        camY = 0.65;
        resetWalkInArming();
        computeBgRect();
        return { x: s2x(npc.x), y: s2y(npc.y) };
      });
      await tapAt(page, point);
      await page.waitForFunction(
        () => autoTarget === SECURITY_NPCS.find((item) => item.scene === "2F"),
        null,
        { timeout: 2000 },
      );
      await page.waitForFunction(
        () => document.getElementById("exhibit").classList.contains("show")
          && document.getElementById("exhibitName").textContent.includes("보안"),
        null,
        { timeout: TEST_TIMEOUT_MS },
      );
      const state = await page.evaluate(() => ({
        scene: curSceneId(),
        autoTargetCleared: autoTarget === null,
      }));
      assert.equal(state.scene, "2F");
      assert.equal(state.autoTargetCleared, true);
    }),
  },
  {
    name: "③ 통행셀 없는 스팟 탭은 무효",
    run: async (browser) => runWithPage(browser, "h.html?f=2F", async (page) => {
      const setup = await page.evaluate(() => {
        const scene = curScene();
        const spot = {
          name: "완전히 막힌 스팟",
          kind: "info",
          icon: "⛔",
          info: "열리면 안 됩니다.",
          x: 0.3,
          y: 0.55,
        };
        scene.spots.push(spot);
        if(!scene.obstacles)scene.obstacles=[];
        scene.obstacles.push([0.1, 0.35, 0.5, 0.76]);
        player.px = 0.75;
        player.py = 0.78;
        player.vx = player.vy = 0;
        camX = 0.52;
        camY = 0.66;
        resetWalkInArming();
        computeBgRect();
        return {
          point: { x: s2x(spot.x), y: s2y(spot.y) },
          player: { x: player.px, y: player.py },
        };
      });
      await tapAt(page, setup.point);
      await page.waitForFunction(
        () => document.getElementById("toast").classList.contains("show")
          && document.getElementById("toast").textContent.includes("가까이 갈 수 없는"),
        null,
        { timeout: 3000 },
      );
      await delay(500);
      const state = await page.evaluate(() => ({
        x: player.px,
        y: player.py,
        autoPath: autoPath.length,
        autoTarget: autoTarget === null,
        modal: document.getElementById("exhibit").classList.contains("show"),
      }));
      assert.equal(state.autoPath, 0);
      assert.equal(state.autoTarget, true);
      assert.equal(state.modal, false);
      assert(Math.hypot(state.x - setup.player.x, state.y - setup.player.y) < 0.005);
    }),
  },
  {
    name: "④ 자동 경로가 문 앞을 지나도 비타깃 문 미발동",
    run: async (browser) => runWithPage(browser, "h.html?f=2F", async (page) => {
      const point = await page.evaluate(() => {
        const scene = curScene();
        const door = scene.spots.find((spot) => spot.kind === "door" && spot.room === "room_B");
        door.x = 0.5;
        door.y = 0.68;
        const target = {
          name: "문 너머 목표",
          kind: "info",
          icon: "🎯",
          info: "정확한 목표에 도착했습니다.",
          x: 0.86,
          y: 0.68,
        };
        scene.spots.push(target);
        player.px = 0.12;
        player.py = 0.68;
        player.vx = player.vy = 0;
        camX = 0.70;   // 목표(0.86)가 뷰포트 안에 들어오게 — 0.49면 탭 지점이 화면 밖 (하네스 결함 수리)
        camY = 0.65;
        resetWalkInArming();
        computeBgRect();
        return { x: s2x(target.x), y: s2y(target.y) };
      });
      await tapAt(page, point);
      await page.waitForFunction(
        () => curSceneId() !== "2F"
          || (document.getElementById("exhibit").classList.contains("show")
            && document.getElementById("exhibitName").textContent === "문 너머 목표"),
        null,
        { timeout: TEST_TIMEOUT_MS },
      );
      const state = await page.evaluate(() => ({
        scene: curSceneId(),
        name: document.getElementById("exhibitName").textContent,
      }));
      assert.equal(state.scene, "2F", `비타깃 문이 발동했습니다: ${JSON.stringify(state)}`);
      assert.equal(state.name, "문 너머 목표");
    }),
  },
  {
    name: "⑤ 씬 전환 후 이전 자동 경로 미재개",
    run: async (browser) => runWithPage(browser, "h.html?f=2F", async (page) => {
      const started = await page.evaluate(() => {
        player.px = 0.1;
        player.py = 0.82;
        player.vx = player.vy = 0;
        camX = 0.49;
        camY = 0.66;
        computeBgRect();
        resetWalkInArming();   // 텔레포트가 √2층행 계단 walk-in 반경 안이라 무장해제 필수 (하네스 결함 수리 — ④와 동일 패턴)
        return startAutoFloorMove({ x: 0.88, y: 0.82 });
      });
      assert.equal(started, true);
      await page.waitForFunction(() => player.px > 0.12 && autoPath.length > 0, null, { timeout: 4000 });
      const cleared = await page.evaluate(() => {
        const destination = FLOORS.findIndex((floor) => floor.id === "1F");
        startFade(() => enterFloor(destination));
        return {
          pathLength: autoPath.length,
          target: autoTarget,
          vx: player.vx,
          vy: player.vy,
        };
      });
      assert.equal(cleared.pathLength, 0);
      assert.equal(cleared.target, null);
      assert.equal(cleared.vx, 0);
      assert.equal(cleared.vy, 0);
      await waitForScene(page, "1F");
      await assertPositionStable(page, 1100);
    }),
  },
  {
    name: "⑥ 스팟·NPC 히트영역 겹침 시 탭한 쪽 실행",
    run: async (browser) => runWithPage(browser, "h.html?f=LOBBY_E", async (page) => {
      const points = await page.evaluate(() => {
        const npc = GUIDE_NPCS.find((item) => item.scene === "LOBBY_E");
        npc.x = 0.43;
        npc.y = 0.6;
        const spot = {
          name: "겹침 스팟",
          kind: "info",
          icon: "🔬",
          info: "스팟을 정확히 탭했습니다.",
          x: 0.49,
          y: 0.6,
        };
        curScene().spots.push(spot);
        player.px = 0.46;
        player.py = 0.72;
        player.vx = player.vy = 0;
        camX = 0.46;
        camY = 0.65;
        resetWalkInArming();
        computeBgRect();
        return {
          npc: { x: s2x(npc.x), y: s2y(npc.y) },
          spot: { x: s2x(spot.x), y: s2y(spot.y) },
          separation: Math.hypot(s2x(npc.x) - s2x(spot.x), s2y(npc.y) - s2y(spot.y)),
        };
      });
      assert(points.separation < 90, "두 대상의 90px 탭 히트영역이 겹쳐야 합니다.");

      await tapAt(page, points.npc);
      await page.waitForFunction(
        () => document.getElementById("exhibit").classList.contains("show")
          && document.getElementById("exhibitName").textContent.includes("S.C"),
        null,
        { timeout: 3000 },
      );
      await page.evaluate(() => closeModals());

      await tapAt(page, points.spot);
      await page.waitForFunction(
        () => document.getElementById("exhibit").classList.contains("show")
          && document.getElementById("exhibitName").textContent === "겹침 스팟",
        null,
        { timeout: 3000 },
      );
    }),
  },
];

async function main() {
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ["--disable-dev-shm-usage"],
    });
  } catch (error) {
    console.error(`브라우저 실행 실패: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  const results = [];
  try {
    for (const scenario of scenarios) {
      const startedAt = Date.now();
      try {
        await scenario.run(browser);
        results.push({ name: scenario.name, ok: true, durationMs: Date.now() - startedAt });
        console.log(`PASS ${scenario.name}`);
      } catch (error) {
        results.push({
          name: scenario.name,
          ok: false,
          durationMs: Date.now() - startedAt,
          error: error.stack || error.message,
        });
        console.error(`FAIL ${scenario.name}\n${error.stack || error.message}`);
      }
    }
  } finally {
    await browser.close();
  }

  const passed = results.filter((result) => result.ok).length;
  console.log(`tap_test: ${passed}/${results.length} 통과`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
