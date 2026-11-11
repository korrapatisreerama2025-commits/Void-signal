import React, { useEffect, useRef, useState, useCallback } from 'react';
import type {
  GameRunStats,
  GameState,
  KillerDrone,
  LaserBarrier,
  MissionConfig,
  PlayMode,
  RadioMessage,
  SentinelDrone,
  SonarWave,
  TacticalBeacon,
} from './game/types';
import {
  CAMPAIGN_MISSIONS,
  DRONE_SPEED,
  MAX_SHIELDS,
  MAX_STAMINA,
  PLAYER_RADIUS,
  SPRINT_SPEED,
  TILE_SIZE,
  WALK_SPEED,
  calculateGameStats,
  getAINavigatorCues,
  isElectricTileShocking,
  resolvePlayerMovement,
  updateLaserBarriers,
  updateSentinelDrones,
  createDefaultKillerDrone,
  updateKillerDrone,
  createExploredGrid,
  updateExploredTiles,
  getClosestThreat,
  type ClosestThreat,
  getDiscoveredDatacores,
  type DiscoveredDatacore,
  getNavigatorViewTransform,
} from './game/rules';
import { gameRenderer } from './game/canvasRenderer';
import { sound } from './game/audio';
import { comms, type CommsPayload } from './game/commsChannel';
import { TitleScreen } from './components/TitleScreen';
import { MissionBriefingModal } from './components/MissionBriefingModal';
import { TacticalHUD } from './components/TacticalHUD';
import { StatusModals } from './components/StatusModals';
import { COLOR_THEMES, type ColorThemeId } from './game/themes';
import { OperativeVignette } from './components/OperativeVignette';

export default function App() {
  // Game State Machine
  const [gameState, setGameState] = useState<GameState>('title');
  const [playMode, setPlayMode] = useState<PlayMode>('splitscreen');
  const [missionIdx, setMissionIdx] = useState<number>(0);
  const [dualRole, setDualRole] = useState<'navigator' | 'operative'>('navigator');

  // React State for HUD (throttled / discrete changes only)
  const [hudShields, setHudShields] = useState<number>(MAX_SHIELDS);
  const [hudStamina, setHudStamina] = useState<number>(MAX_STAMINA);
  const [hudHackCharges, setHudHackCharges] = useState<number>(3);
  const [hudHasKey, setHudHasKey] = useState<boolean>(false);
  const [hudDatacores, setHudDatacores] = useState<number>(0);
  const [hudTotalDatacores, setHudTotalDatacores] = useState<number>(0);
  const [hudElapsedTime, setHudElapsedTime] = useState<number>(0);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [selectedTool, setSelectedTool] = useState<'ping' | 'beacon' | 'hack'>('ping');
  const [activeRadioMessage, setActiveRadioMessage] = useState<RadioMessage | null>(null);
  const [runStats, setRunStats] = useState<GameRunStats | null>(null);
  const [fogOfWar, setFogOfWar] = useState<boolean>(true);
  const [threatOverlay, setThreatOverlay] = useState<boolean>(true);
  const [hudThreat, setHudThreat] = useState<ClosestThreat | null>(null);
  const [hudDiscoveredDatacores, setHudDiscoveredDatacores] = useState<DiscoveredDatacore[]>([]);
  const [hudPlayerPos, setHudPlayerPos] = useState<{ x: number; y: number }>({ x: 72, y: 72 });
  const [activeTheme, setActiveTheme] = useState<ColorThemeId>('cyber_neon');
  const [hudSpeedRatio, setHudSpeedRatio] = useState<number>(0);
  const [hudIsDashing, setHudIsDashing] = useState<boolean>(false);
  const [hudOperativeThreat, setHudOperativeThreat] = useState<ClosestThreat | null>(null);
  const [hudKillerDrone, setHudKillerDrone] = useState<KillerDrone | null>(null);

  // Canvas Refs
  const navCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const operCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Live mutable simulation state in refs (completely decoupled from 60fps React reconciliation)
  const sim = useRef({
    mission: CAMPAIGN_MISSIONS[0],
    playerX: 72,
    playerY: 72,
    playerVx: 0,
    playerVy: 0,
    playerAngle: 0,
    isDashing: false,
    shields: MAX_SHIELDS,
    stamina: MAX_STAMINA,
    hasKeycard: false,
    doorStates: {} as Record<string, boolean>,
    datacores: 0,
    totalDatacores: 0,
    hackCharges: 3,
    elapsedTime: 0,
    alarmsTriggered: 0,
    pingsEmitted: 0,
    hacksUsed: 0,
    lasers: [] as LaserBarrier[],
    drones: [] as SentinelDrone[],
    beacons: [] as TacticalBeacon[],
    sonarWaves: [] as SonarWave[],
    exploredGrid: [] as boolean[][],
    fogOfWarEnabled: true,
    threatOverlayEnabled: true,
    keysHeld: new Set<string>(),
    justPressed: new Set<string>(),
    mousePos: { x: 0, y: 0 },
    screenshake: 0,
    hitstop: 0,
    lastFootstepTime: 0,
    whistleTimer: 0,
    aiGuidanceTimer: 0,
    invincibleTimer: 0,
    activeTheme: 'cyber_neon' as ColorThemeId,
    killerDrone: null as KillerDrone | null,
  });

  // Sync dataset.state with body
  useEffect(() => {
    document.body.dataset.state = gameState;
  }, [gameState]);

  // BroadcastChannel listener for multi-window / multi-tab mode
  useEffect(() => {
    const unsubscribe = comms.subscribe((payload: CommsPayload) => {
      if (payload.type === 'PING_EMITTED') {
        sim.current.sonarWaves.push(payload.data);
        sound.playSonarPing();
      } else if (payload.type === 'BEACON_PLACED') {
        sim.current.beacons.push(payload.data);
        sound.playSonarPing();
      } else if (payload.type === 'HACK_TRIGGERED') {
        const laser = sim.current.lasers.find((l) => l.id === payload.data.laserId);
        if (laser) {
          laser.isHacked = true;
          laser.hackTimer = 4.0;
        }
        sound.playEmpHack();
      } else if (payload.type === 'RADIO_MESSAGE') {
        setActiveRadioMessage(payload.data);
        sound.speakRadio(payload.data.text);
      } else if (payload.type === 'PLAYER_UPDATE' && playMode === 'dual_window') {
        if (dualRole === 'navigator') {
          sim.current.playerX = payload.data.x;
          sim.current.playerY = payload.data.y;
          sim.current.playerAngle = payload.data.angle;
          sim.current.isDashing = payload.data.isDashing;
        }
      }
    });
    return unsubscribe;
  }, [playMode, dualRole]);

  // Handle autostart query parameter & Enter/Space to start
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('autostart') === '1' && gameState === 'title') {
      handleStartGame('splitscreen', 0);
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      sim.current.keysHeld.add(e.code);
      sim.current.justPressed.add(e.code);

      // Title screen quick-action: Open briefing
      if (gameState === 'title' && (e.code === 'Enter' || e.code === 'Space')) {
        setGameState('briefing');
        return;
      }

      // Victory / Gameover quick-action
      if (gameState === 'gameover' && (e.code === 'Enter' || e.code === 'KeyR')) {
        handleRestart();
        return;
      }

      // In-game hotkeys
      if (gameState === 'playing') {
        if (e.code === 'Escape' || e.code === 'KeyP') {
          setGameState('paused');
        } else if (e.code === 'KeyM') {
          const muted = sound.toggleMute();
          setIsMuted(muted);
        } else if (e.code === 'KeyR') {
          handleRestart();
        } else if (e.code === 'Digit1') {
          setSelectedTool('ping');
        } else if (e.code === 'Digit2') {
          setSelectedTool('beacon');
        } else if (e.code === 'Digit3') {
          setSelectedTool('hack');
        } else if (e.code === 'KeyE') {
          triggerOperativePing();
        } else if (e.code === 'KeyF') {
          if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(() => {});
          } else {
            document.exitFullscreen().catch(() => {});
          }
        }
      } else if (gameState === 'paused') {
        if (e.code === 'Escape' || e.code === 'KeyP') {
          setGameState('playing');
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      sim.current.keysHeld.delete(e.code);
    };

    const handleBlur = () => {
      sim.current.keysHeld.clear();
      sim.current.justPressed.clear();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    document.addEventListener('visibilitychange', handleBlur);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('visibilitychange', handleBlur);
    };
  }, [gameState, playMode, missionIdx]);

  // Load and start a mission
  const handleStartGame = useCallback(
    (mode: PlayMode, mIdx: number) => {
      const template = CAMPAIGN_MISSIONS[mIdx] || CAMPAIGN_MISSIONS[0];
      // Clone deep
      const missionCopy: MissionConfig = {
        ...template,
        grid: template.grid.map((row) => [...row]),
        lasers: template.lasers.map((l) => ({ ...l })),
        drones: template.drones.map((d) => ({
          ...d,
          waypoints: d.waypoints.map((w) => ({ ...w })),
        })),
      };

      // Count total datacores
      let dCount = 0;
      for (const row of missionCopy.grid) {
        for (const cell of row) {
          if (cell === 5) dCount++;
        }
      }

      sim.current.mission = missionCopy;
      sim.current.playerX = missionCopy.startPos.x;
      sim.current.playerY = missionCopy.startPos.y;
      sim.current.playerVx = 0;
      sim.current.playerVy = 0;
      sim.current.playerAngle = 0;
      sim.current.isDashing = false;
      sim.current.shields = MAX_SHIELDS;
      sim.current.stamina = MAX_STAMINA;
      sim.current.hasKeycard = false;
      sim.current.doorStates = {};
      sim.current.datacores = 0;
      sim.current.totalDatacores = dCount;
      sim.current.hackCharges = missionCopy.hackCharges;
      sim.current.elapsedTime = 0;
      sim.current.alarmsTriggered = 0;
      sim.current.pingsEmitted = 0;
      sim.current.hacksUsed = 0;
      sim.current.lasers = missionCopy.lasers;
      sim.current.drones = missionCopy.drones;
      sim.current.beacons = [];
      sim.current.sonarWaves = [];

      // Spawn / Initialize the relentless Apex Killer Rover
      const killer = missionCopy.killerDrone
        ? { ...missionCopy.killerDrone }
        : createDefaultKillerDrone(missionCopy.grid, missionCopy.startPos.x, missionCopy.startPos.y);
      sim.current.killerDrone = killer;
      setHudKillerDrone(killer);
      setHudSpeedRatio(0);
      setHudIsDashing(false);
      setHudOperativeThreat(null);

      const explored = createExploredGrid(missionCopy.grid.length, missionCopy.grid[0].length);
      updateExploredTiles(missionCopy.startPos.x, missionCopy.startPos.y, explored, 160);
      sim.current.exploredGrid = explored;
      sim.current.fogOfWarEnabled = fogOfWar;
      sim.current.threatOverlayEnabled = threatOverlay;
      sim.current.screenshake = 0;
      sim.current.hitstop = 0;
      sim.current.whistleTimer = 0;
      sim.current.invincibleTimer = 0;
      setHudThreat(null);

      setPlayMode(mode);
      setMissionIdx(mIdx);
      setHudShields(MAX_SHIELDS);
      setHudStamina(MAX_STAMINA);
      setHudHackCharges(missionCopy.hackCharges);
      setHudHasKey(false);
      setHudDatacores(0);
      setHudTotalDatacores(dCount);
      setHudElapsedTime(0);
      setHudPlayerPos({ x: missionCopy.startPos.x, y: missionCopy.startPos.y });
      const initialDiscovered = getDiscoveredDatacores(missionCopy.grid, explored, {});
      setHudDiscoveredDatacores(initialDiscovered);
      setRunStats(null);
      setGameState('playing');

      // Tactical radio intro message
      const introMsg: RadioMessage = {
        id: `m_${Date.now()}`,
        sender: 'AI_OVERWATCH',
        text: `Infiltration initiated: ${missionCopy.title}. Acoustic sync active.`,
        time: Date.now(),
      };
      setActiveRadioMessage(introMsg);
      sound.speakRadio(introMsg.text);
    },
    []
  );

  const handleRestart = () => {
    handleStartGame(playMode, missionIdx);
  };

  const handleNextMission = () => {
    if (missionIdx < CAMPAIGN_MISSIONS.length - 1) {
      setMissionIdx(missionIdx + 1);
      setGameState('briefing');
    } else {
      setGameState('title');
    }
  };

  // Operative Echolocation Pulse
  const triggerOperativePing = () => {
    sim.current.whistleTimer = 0.6;
    sim.current.pingsEmitted++;
    sound.playWhistle();
    updateExploredTiles(sim.current.playerX, sim.current.playerY, sim.current.exploredGrid, 280);

    // Spawn audible ripple
    const wave: SonarWave = {
      x: sim.current.playerX,
      y: sim.current.playerY,
      radius: 10,
      maxRadius: 260,
      color: '#00ffcc',
      speed: 280,
      opacity: 0.9,
      isFromOperative: true,
    };
    sim.current.sonarWaves.push(wave);
    comms.broadcast({ type: 'PING_EMITTED', data: wave });
  };

  // Navigator Tool Interaction (Drop Ping, Beacon, or Hack)
  const handleNavigatorAction = (worldX: number, worldY: number) => {
    if (gameState !== 'playing') return;

    if (selectedTool === 'ping') {
      const wave: SonarWave = {
        x: worldX,
        y: worldY,
        radius: 12,
        maxRadius: 220,
        color: '#00f0ff',
        speed: 280,
        opacity: 0.9,
        isFromOperative: false,
      };
      sim.current.sonarWaves.push(wave);
      sim.current.pingsEmitted++;
      sound.playSonarPing();
      comms.broadcast({ type: 'PING_EMITTED', data: wave });
    } else if (selectedTool === 'beacon') {
      const beacon: TacticalBeacon = {
        id: `b_${Date.now()}`,
        x: worldX,
        y: worldY,
        type: 'waypoint',
        label: `ALPHA-${sim.current.beacons.length + 1}`,
        createdAt: Date.now(),
        life: 15.0,
      };
      sim.current.beacons.push(beacon);
      sound.playSonarPing();
      comms.broadcast({ type: 'BEACON_PLACED', data: beacon });
    } else if (selectedTool === 'hack') {
      if (sim.current.hackCharges > 0) {
        // Find nearest laser to hack
        let nearestLaser: LaserBarrier | null = null;
        let minDist2 = 80 * 80;
        for (const laser of sim.current.lasers) {
          const midX = (laser.x1 + laser.x2) / 2;
          const midY = (laser.y1 + laser.y2) / 2;
          const d2 = (midX - worldX) ** 2 + (midY - worldY) ** 2;
          if (d2 < minDist2) {
            minDist2 = d2;
            nearestLaser = laser;
          }
        }

        if (nearestLaser) {
          nearestLaser.isHacked = true;
          nearestLaser.hackTimer = 4.5;
          sim.current.hackCharges--;
          sim.current.hacksUsed++;
          setHudHackCharges(sim.current.hackCharges);
          sound.playEmpHack();
          gameRenderer.spawnBurst(
            (nearestLaser.x1 + nearestLaser.x2) / 2,
            (nearestLaser.y1 + nearestLaser.y2) / 2,
            '#00f0ff',
            16,
            100
          );
          comms.broadcast({
            type: 'HACK_TRIGGERED',
            data: { laserId: nearestLaser.id },
          });
        }
      }
    }
  };

  // Quick Tactical Radio Speech Dispatch
  const handleQuickRadio = (text: string) => {
    const msg: RadioMessage = {
      id: `m_${Date.now()}`,
      sender: 'NAVIGATOR',
      text,
      time: Date.now(),
    };
    setActiveRadioMessage(msg);
    sound.speakRadio(text);
    comms.broadcast({ type: 'RADIO_MESSAGE', data: msg });
  };

  // Main 60fps Decoupled Simulation & Render Loop
  useEffect(() => {
    let animId: number;
    let lastTime = performance.now();

    const loop = (time: number) => {
      const rawDt = (time - lastTime) / 1000;
      lastTime = time;
      const dt = Math.min(rawDt, 0.05); // Clamped dt

      const s = sim.current;

      if (gameState === 'playing') {
        // Hitstop logic
        if (s.hitstop > 0) {
          s.hitstop -= dt;
        } else {
          s.elapsedTime += dt;
          if (s.invincibleTimer > 0) s.invincibleTimer -= dt;
          if (s.whistleTimer > 0) s.whistleTimer -= dt;

          // 1. Process Operative Movement
          let moveX = 0;
          let moveY = 0;
          if (s.keysHeld.has('KeyW') || s.keysHeld.has('ArrowUp')) moveY -= 1;
          if (s.keysHeld.has('KeyS') || s.keysHeld.has('ArrowDown')) moveY += 1;
          if (s.keysHeld.has('KeyA') || s.keysHeld.has('ArrowLeft')) moveX -= 1;
          if (s.keysHeld.has('KeyD') || s.keysHeld.has('ArrowRight')) moveX += 1;

          const wantsDash = s.keysHeld.has('ShiftLeft') || s.keysHeld.has('ShiftRight');
          const isMoving = moveX !== 0 || moveY !== 0;

          if (wantsDash && isMoving && s.stamina > 10) {
            s.isDashing = true;
            s.stamina = Math.max(0, s.stamina - dt * 35);
          } else {
            s.isDashing = false;
            s.stamina = Math.min(MAX_STAMINA, s.stamina + dt * 20);
          }

          if (isMoving) {
            const mag = Math.hypot(moveX, moveY);
            const speed = s.isDashing ? SPRINT_SPEED : WALK_SPEED;
            s.playerVx = (moveX / mag) * speed;
            s.playerVy = (moveY / mag) * speed;
            s.playerAngle = Math.atan2(moveY, moveX);

            // Footstep audio & ripples
            const footstepInterval = s.isDashing ? 0.22 : 0.38;
            if (time - s.lastFootstepTime > footstepInterval * 1000) {
              s.lastFootstepTime = time;
              const pan = (s.playerX - 350) / 350;
              sound.playFootstep(pan);

              // Sonar footstep wave
              s.sonarWaves.push({
                x: s.playerX,
                y: s.playerY,
                radius: 4,
                maxRadius: s.isDashing ? 85 : 45,
                color: s.isDashing ? '#ff0077' : '#ffffff',
                speed: 120,
                opacity: 0.7,
                isFromOperative: s.isDashing, // Dashing alerts drones!
              });
            }
          } else {
            s.playerVx = 0;
            s.playerVy = 0;
          }

          // Wall collision resolution
          const moveRes = resolvePlayerMovement(
            s.playerX,
            s.playerY,
            s.playerVx,
            s.playerVy,
            dt,
            s.mission.grid,
            s.doorStates
          );
          s.playerX = moveRes.x;
          s.playerY = moveRes.y;
          updateExploredTiles(s.playerX, s.playerY, s.exploredGrid, s.whistleTimer > 0 ? 280 : 155);

          if (moveRes.collided && isMoving) {
            // Tactile wall spark
            gameRenderer.spawnBurst(s.playerX, s.playerY, '#00f0ff', 2, 40);
          }

          // Broadcast movement to dual window tab
          if (playMode === 'dual_window' && dualRole === 'operative') {
            comms.broadcast({
              type: 'PLAYER_UPDATE',
              data: {
                x: s.playerX,
                y: s.playerY,
                angle: s.playerAngle,
                isDashing: s.isDashing,
              },
            });
          }

          // 2. Check Item / Tile Interactions (Keys, Datacores, Doors, Extraction)
          const currentGX = Math.floor(s.playerX / TILE_SIZE);
          const currentGY = Math.floor(s.playerY / TILE_SIZE);

          if (
            currentGY >= 0 &&
            currentGY < s.mission.grid.length &&
            currentGX >= 0 &&
            currentGX < s.mission.grid[0].length
          ) {
            const currentTile = s.mission.grid[currentGY][currentGX];

            // Keycard
            if (currentTile === 4 && !s.hasKeycard) {
              s.hasKeycard = true;
              s.mission.grid[currentGY][currentGX] = 0;
              s.doorStates['key_collected'] = true;
              setHudHasKey(true);
              sound.playSuccessChime();
              gameRenderer.spawnBurst(s.playerX, s.playerY, '#ffd700', 16, 90);
              const keyMsg: RadioMessage = {
                id: `k_${Date.now()}`,
                sender: 'OPERATIVE',
                text: 'Security keycard secured! Blast doors unlocking.',
                time: Date.now(),
              };
              setActiveRadioMessage(keyMsg);
              sound.speakRadio(keyMsg.text);

              // Auto-unlock all doors on map
              for (let r = 0; r < s.mission.grid.length; r++) {
                for (let c = 0; c < s.mission.grid[0].length; c++) {
                  if (s.mission.grid[r][c] === 2) {
                    s.doorStates[`${c},${r}`] = true;
                  }
                }
              }
            }

            // Datacore
            if (currentTile === 5) {
              s.mission.grid[currentGY][currentGX] = 0;
              s.doorStates[`datacore_${currentGX}_${currentGY}`] = true;
              s.datacores++;
              setHudDatacores(s.datacores);
              sound.playSuccessChime();
              gameRenderer.spawnBurst(s.playerX, s.playerY, '#00ffc8', 14, 80);
            }

            // Extraction Victory Zone!
            if (currentTile === 6) {
              if (s.hasKeycard) {
                const stats = calculateGameStats(
                  s.mission.id,
                  s.mission.title,
                  s.elapsedTime,
                  s.alarmsTriggered,
                  s.datacores,
                  s.totalDatacores,
                  s.pingsEmitted,
                  s.hacksUsed,
                  s.shields
                );
                setRunStats(stats);
                setGameState('gameover');
                sound.playVictoryFanfare();
                return;
              }
            }
          }

          // 3. Update Lasers & Collisions
          const laserUpdate = updateLaserBarriers(
            s.lasers,
            dt,
            s.elapsedTime,
            s.playerX,
            s.playerY,
            PLAYER_RADIUS
          );

          if (laserUpdate.hit && s.invincibleTimer <= 0) {
            s.shields--;
            s.invincibleTimer = 1.2;
            s.hitstop = 0.08;
            s.screenshake = 14;
            s.alarmsTriggered++;
            setHudShields(s.shields);
            sound.playDamageSting();
            sound.playAlarmPulse();
            gameRenderer.spawnBurst(s.playerX, s.playerY, '#ff0055', 20, 120);

            if (s.shields <= 0) {
              const stats = calculateGameStats(
                s.mission.id,
                s.mission.title,
                s.elapsedTime,
                s.alarmsTriggered,
                s.datacores,
                s.totalDatacores,
                s.pingsEmitted,
                s.hacksUsed,
                0
              );
              setRunStats(stats);
              setGameState('gameover');
              return;
            }
          }

          // 4. Update Electric Floor Shock
          if (
            currentGY >= 0 &&
            currentGY < s.mission.grid.length &&
            currentGX >= 0 &&
            currentGX < s.mission.grid[0].length
          ) {
            if (s.mission.grid[currentGY][currentGX] === 7) {
              const { isShocking } = isElectricTileShocking(
                currentGX,
                currentGY,
                s.elapsedTime
              );
              if (isShocking && s.invincibleTimer <= 0) {
                s.shields--;
                s.invincibleTimer = 1.2;
                s.hitstop = 0.08;
                s.screenshake = 14;
                s.alarmsTriggered++;
                setHudShields(s.shields);
                sound.playDamageSting();
                gameRenderer.spawnBurst(s.playerX, s.playerY, '#ffffff', 20, 110);

                if (s.shields <= 0) {
                  const stats = calculateGameStats(
                    s.mission.id,
                    s.mission.title,
                    s.elapsedTime,
                    s.alarmsTriggered,
                    s.datacores,
                    s.totalDatacores,
                    s.pingsEmitted,
                    s.hacksUsed,
                    0
                  );
                  setRunStats(stats);
                  setGameState('gameover');
                  return;
                }
              }
            }
          }

          // 5. Update Drones & Alert System
          const isPlayerLoud = s.isDashing || s.whistleTimer > 0;
          const droneRes = updateSentinelDrones(
            s.drones,
            dt,
            s.mission.grid,
            s.playerX,
            s.playerY,
            isPlayerLoud
          );

          if (droneRes.droneCollided && s.invincibleTimer <= 0) {
            s.shields--;
            s.invincibleTimer = 1.2;
            s.hitstop = 0.08;
            s.screenshake = 16;
            s.alarmsTriggered++;
            setHudShields(s.shields);
            sound.playDamageSting();
            sound.playAlarmPulse();
            gameRenderer.spawnBurst(s.playerX, s.playerY, '#ffaa00', 20, 130);

            if (s.shields <= 0) {
              const stats = calculateGameStats(
                s.mission.id,
                s.mission.title,
                s.elapsedTime,
                s.alarmsTriggered,
                s.datacores,
                s.totalDatacores,
                s.pingsEmitted,
                s.hacksUsed,
                0
              );
              setRunStats(stats);
              setGameState('gameover');
              return;
            }
          }

          // 5.5. Update Apex Killer Drone (Relentless Non-Stop Random Corridor Hunter)
          if (s.killerDrone) {
            const killerRes = updateKillerDrone(
              s.killerDrone,
              dt,
              s.mission.grid,
              s.doorStates,
              s.playerX,
              s.playerY
            );

            if (killerRes.collided && s.invincibleTimer <= 0) {
              s.shields--;
              s.invincibleTimer = 1.6;
              s.hitstop = 0.12;
              s.screenshake = 22;
              s.alarmsTriggered++;
              setHudShields(s.shields);
              sound.playDamageSting();
              sound.playAlarmPulse();
              gameRenderer.spawnBurst(s.playerX, s.playerY, '#ff0055', 28, 160);

              const strikeMsg: RadioMessage = {
                id: `killer_strike_${Date.now()}`,
                sender: 'SYSTEM',
                text: 'CRITICAL ALERT! APEX KILLER STRIKE // SHIELD DISRUPTED!',
                time: Date.now(),
                urgent: true,
              };
              setActiveRadioMessage(strikeMsg);

              if (s.shields <= 0) {
                const stats = calculateGameStats(
                  s.mission.id,
                  s.mission.title,
                  s.elapsedTime,
                  s.alarmsTriggered,
                  s.datacores,
                  s.totalDatacores,
                  s.pingsEmitted,
                  s.hacksUsed,
                  0
                );
                setRunStats(stats);
                setGameState('gameover');
                return;
              }
            }
          }

          // 6. Update Sonar Waves
          for (let i = s.sonarWaves.length - 1; i >= 0; i--) {
            const w = s.sonarWaves[i];
            w.radius += w.speed * dt;
            w.opacity = 1 - w.radius / w.maxRadius;
            if (w.radius >= w.maxRadius) {
              s.sonarWaves.splice(i, 1);
            }
          }

          // 7. Update Beacons
          for (let i = s.beacons.length - 1; i >= 0; i--) {
            s.beacons[i].life -= dt;
            if (s.beacons[i].life <= 0) {
              s.beacons.splice(i, 1);
            }
          }

          // 8. AI Navigator Mode: Autonomous Tactical Over-watch
          if (playMode === 'solo_runner') {
            s.aiGuidanceTimer += dt;
            if (s.aiGuidanceTimer >= 4.0) {
              s.aiGuidanceTimer = 0;
              const cues = getAINavigatorCues(
                s.playerX,
                s.playerY,
                s.mission.grid,
                s.lasers,
                s.drones,
                s.mission.extractionPos,
                s.hasKeycard,
                s.elapsedTime
              );

              // Dispatch advice
              const adviceMsg: RadioMessage = {
                id: `ai_${Date.now()}`,
                sender: 'AI_OVERWATCH',
                text: cues.adviceText,
                time: Date.now(),
                urgent: cues.hazardAhead,
              };
              setActiveRadioMessage(adviceMsg);
              sound.speakRadio(cues.adviceText);

              // Auto-emit helpful sonar ping
              const pingWave: SonarWave = {
                x: s.playerX,
                y: s.playerY,
                radius: 10,
                maxRadius: 180,
                color: cues.hazardAhead ? '#ff0055' : '#00f0ff',
                speed: 240,
                opacity: 0.9,
                isFromOperative: false,
              };
              s.sonarWaves.push(pingWave);
            }
          }

          // 9. Particles and Camera Screenshake Decay
          gameRenderer.updateParticles(dt);
          if (s.screenshake > 0) {
            s.screenshake = Math.max(0, s.screenshake - dt * 25);
          }

          // Throttled HUD update (every ~200ms)
          setHudElapsedTime(s.elapsedTime);
          setHudStamina(s.stamina);
          setHudPlayerPos({ x: s.playerX, y: s.playerY });

          const speed = Math.hypot(s.playerVx, s.playerVy);
          setHudSpeedRatio(Math.min(1, speed / SPRINT_SPEED));
          setHudIsDashing(s.isDashing);

          const discovered = getDiscoveredDatacores(s.mission.grid, s.exploredGrid, s.doorStates);
          setHudDiscoveredDatacores(discovered);

          if (s.threatOverlayEnabled) {
            const nearestThreat = getClosestThreat(
              s.playerX,
              s.playerY,
              s.lasers,
              s.drones,
              360,
              s.killerDrone
            );
            setHudThreat(nearestThreat);
          } else {
            setHudThreat(null);
          }

          const opThreat = getClosestThreat(
            s.playerX,
            s.playerY,
            s.lasers,
            s.drones,
            280,
            s.killerDrone
          );
          setHudOperativeThreat(opThreat);
          setHudKillerDrone(s.killerDrone ? { ...s.killerDrone } : null);
        }
      }

      // Clear edge-triggered single frame inputs
      s.justPressed.clear();

      // RENDER PHASES
      const shakeX = (Math.random() - 0.5) * s.screenshake;
      const shakeY = (Math.random() - 0.5) * s.screenshake;

      // 1. Render Navigator Canvas (if active in layout)
      if (navCanvasRef.current) {
        const navCanvas = navCanvasRef.current;
        const navCtx = navCanvas.getContext('2d');
        if (navCtx) {
          gameRenderer.renderNavigatorView(
            navCtx,
            navCanvas.width,
            navCanvas.height,
            s.mission,
            s.playerX,
            s.playerY,
            s.playerAngle,
            s.isDashing,
            s.lasers,
            s.drones,
            s.beacons,
            s.sonarWaves,
            s.doorStates,
            s.elapsedTime,
            shakeX,
            shakeY,
            s.mousePos,
            selectedTool,
            s.exploredGrid,
            s.fogOfWarEnabled,
            s.whistleTimer,
            s.threatOverlayEnabled,
            s.activeTheme,
            s.killerDrone
          );
        }
      }

      // 2. Render Operative Canvas (if active in layout)
      if (operCanvasRef.current) {
        const operCanvas = operCanvasRef.current;
        const operCtx = operCanvas.getContext('2d');
        if (operCtx) {
          gameRenderer.renderOperativeView(
            operCtx,
            operCanvas.width,
            operCanvas.height,
            s.mission,
            s.playerX,
            s.playerY,
            s.playerAngle,
            s.isDashing,
            s.lasers,
            s.drones,
            s.beacons,
            s.sonarWaves,
            s.doorStates,
            s.elapsedTime,
            shakeX,
            shakeY,
            s.whistleTimer,
            s.activeTheme,
            s.killerDrone
          );
        }
      }

      animId = requestAnimationFrame(loop);
    };

    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
  }, [gameState, playMode, selectedTool, dualRole]);

  // Window Resize Observer for Isolated Canvas Elements
  useEffect(() => {
    const handleResize = () => {
      if (navCanvasRef.current) {
        navCanvasRef.current.width = navCanvasRef.current.parentElement?.clientWidth || 800;
        navCanvasRef.current.height = navCanvasRef.current.parentElement?.clientHeight || 600;
      }
      if (operCanvasRef.current) {
        operCanvasRef.current.width = operCanvasRef.current.parentElement?.clientWidth || 800;
        operCanvasRef.current.height = operCanvasRef.current.parentElement?.clientHeight || 600;
      }
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [gameState, playMode, dualRole]);

  // Navigator Canvas Click / Mousemove Routing
  const handleNavCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    sim.current.mousePos = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  };

  const handleNavCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    // Convert to map coordinates via dynamic zoom & offset transform
    const transform = getNavigatorViewTransform(
      e.currentTarget.width,
      e.currentTarget.height,
      sim.current.mission.width,
      sim.current.mission.height
    );
    const worldX = (clickX - transform.offsetX) / transform.zoom;
    const worldY = (clickY - transform.offsetY) / transform.zoom;
    handleNavigatorAction(worldX, worldY);
  };

  // Determine whether to show Navigator view, Operative view, or Split Screen
  const showSplit = playMode === 'splitscreen';
  const showNavOnly =
    playMode === 'solo_navigator' || (playMode === 'dual_window' && dualRole === 'navigator');
  const showOperOnly =
    playMode === 'solo_runner' || (playMode === 'dual_window' && dualRole === 'operative');

  const currentMission = CAMPAIGN_MISSIONS[missionIdx] || CAMPAIGN_MISSIONS[0];

  return (
    <main className="relative w-screen h-screen bg-[#030712] overflow-hidden select-none">
      {/* 1. TITLE SCREEN */}
      {(gameState === 'title' || gameState === 'briefing') && (
        <TitleScreen
          onStart={(mode, mIdx) => {
            setPlayMode(mode);
            setMissionIdx(mIdx);
            setGameState('briefing');
          }}
          selectedMode={playMode}
          setSelectedMode={setPlayMode}
          selectedMissionIdx={missionIdx}
          setSelectedMissionIdx={setMissionIdx}
          activeTheme={activeTheme}
          onSelectTheme={(t) => {
            setActiveTheme(t);
            sim.current.activeTheme = t;
          }}
        />
      )}

      {/* 1.5. PRE-MISSION BRIEFING MODAL */}
      {gameState === 'briefing' && (
        <MissionBriefingModal
          mission={currentMission}
          mode={playMode}
          onCommence={() => handleStartGame(playMode, missionIdx)}
          onBack={() => setGameState('title')}
          activeTheme={activeTheme}
        />
      )}

      {/* 2. LIVE GAMEPLAY DUAL/SINGLE VIEWPORTS */}
      {gameState !== 'title' && gameState !== 'briefing' && (
        <div className="relative w-full h-full flex flex-col md:flex-row">
          {/* Navigator Viewport (The Blueprint Eye) */}
          {(showSplit || showNavOnly) && (
            <div
              className={`relative flex flex-col border-b md:border-b-0 md:border-r overflow-hidden ${
                showSplit ? 'w-full h-1/2 md:h-full md:w-1/2' : 'w-full h-full'
              }`}
              style={{
                backgroundColor: COLOR_THEMES[activeTheme]?.navBg || '#050b14',
                borderColor: `${COLOR_THEMES[activeTheme]?.primaryAccent || '#00f0ff'}33`,
              }}
            >
              {/* Header Label */}
              <div
                className="absolute top-16 left-4 z-20 pointer-events-none flex items-center gap-2 px-2.5 py-1 rounded border backdrop-blur-xs"
                style={{
                  backgroundColor: `${COLOR_THEMES[activeTheme]?.navBg || '#050b14'}d9`,
                  borderColor: `${COLOR_THEMES[activeTheme]?.primaryAccent || '#00f0ff'}40`,
                }}
              >
                <span
                  className="w-2 h-2 rounded-full"
                  style={{
                    backgroundColor: COLOR_THEMES[activeTheme]?.primaryAccent || '#00f0ff',
                    boxShadow: `0 0 6px ${COLOR_THEMES[activeTheme]?.primaryAccent || '#00f0ff'}`,
                  }}
                />
                <span
                  className="font-mono text-[10px] tracking-widest font-bold uppercase"
                  style={{ color: COLOR_THEMES[activeTheme]?.primaryAccent || '#00f0ff' }}
                >
                  THE EYE // TACTICAL BLUEPRINT (CANNOT MOVE)
                </span>
              </div>

              {/* Threat Proximity Overlay Status */}
              <div
                className={`absolute top-16 right-4 z-20 pointer-events-none flex items-center gap-2 px-2.5 py-1 rounded border transition-all ${
                  threatOverlay
                    ? hudThreat
                      ? hudThreat.isCritical
                        ? 'bg-rose-950/90 border-rose-500/80 text-rose-300 shadow-[0_0_15px_rgba(255,0,68,0.4)] animate-pulse'
                        : 'bg-rose-950/60 border-rose-600/50 text-rose-400 shadow-[0_0_8px_rgba(255,0,68,0.2)]'
                      : 'bg-[#050b14]/80 border-cyan-500/20 text-cyan-500/70'
                    : 'bg-[#050b14]/60 border-neutral-800 text-neutral-500'
                }`}
              >
                <span
                  className={`w-2 h-2 rounded-full ${
                    threatOverlay
                      ? hudThreat
                        ? 'bg-rose-500 shadow-[0_0_8px_#ff0055]'
                        : 'bg-emerald-500/60'
                      : 'bg-neutral-600'
                  } ${hudThreat?.isCritical && threatOverlay ? 'animate-ping' : ''}`}
                />
                <span className="font-mono text-[10px] tracking-wider font-bold uppercase">
                  {threatOverlay
                    ? hudThreat
                      ? `THREAT PROXIMITY: ${hudThreat.name} [${hudThreat.distance}m]`
                      : 'THREAT PROXIMITY: CLEAR'
                    : 'THREAT OVERLAY: OFF'}
                </span>
              </div>

              <canvas
                ref={navCanvasRef}
                onMouseMove={handleNavCanvasMouseMove}
                onClick={handleNavCanvasClick}
                className="w-full h-full cursor-crosshair"
              />
            </div>
          )}

          {/* Operative Viewport (The Blind Runner) */}
          {(showSplit || showOperOnly) && (
            <div
              className={`relative flex flex-col overflow-hidden ${
                showSplit ? 'w-full h-1/2 md:h-full md:w-1/2' : 'w-full h-full'
              }`}
              style={{
                backgroundColor: COLOR_THEMES[activeTheme]?.operBg || '#020307',
              }}
            >
              {/* Header Label */}
              <div
                className="absolute top-16 left-4 z-20 pointer-events-none flex items-center gap-2 px-2.5 py-1 rounded border backdrop-blur-xs"
                style={{
                  backgroundColor: `${COLOR_THEMES[activeTheme]?.operBg || '#020307'}d9`,
                  borderColor: `${COLOR_THEMES[activeTheme]?.secondaryAccent || '#f43f5e'}40`,
                }}
              >
                <span
                  className="w-2 h-2 rounded-full animate-pulse"
                  style={{
                    backgroundColor: COLOR_THEMES[activeTheme]?.secondaryAccent || '#f43f5e',
                    boxShadow: `0 0 6px ${COLOR_THEMES[activeTheme]?.secondaryAccent || '#f43f5e'}`,
                  }}
                />
                <span
                  className="font-mono text-[10px] tracking-widest font-bold uppercase"
                  style={{ color: COLOR_THEMES[activeTheme]?.secondaryAccent || '#f43f5e' }}
                >
                  THE OPERATIVE // PITCH DARKNESS (MOVE & LISTEN)
                </span>
              </div>

              {/* Dynamic CSS Pitch Darkness Vignette Overlay */}
              <OperativeVignette
                speedRatio={hudSpeedRatio}
                isDashing={hudIsDashing}
                threat={hudOperativeThreat}
                activeTheme={activeTheme}
              />

              <canvas
                ref={operCanvasRef}
                className="w-full h-full"
              />
            </div>
          )}
        </div>
      )}

      {/* 3. TACTICAL HUD (Rendered when in playing or paused) */}
      {(gameState === 'playing' || gameState === 'paused') && (
        <TacticalHUD
          mode={playMode}
          missionTitle={currentMission.title}
          missionNumber={currentMission.id}
          shields={hudShields}
          maxShields={MAX_SHIELDS}
          stamina={hudStamina}
          hackCharges={hudHackCharges}
          maxHackCharges={currentMission.hackCharges}
          hasKeycard={hudHasKey}
          datacores={hudDatacores}
          totalDatacores={hudTotalDatacores}
          elapsedTime={hudElapsedTime}
          isMuted={isMuted}
          onToggleMute={() => {
            const muted = sound.toggleMute();
            setIsMuted(muted);
          }}
          onPause={() => setGameState('paused')}
          onOperativePing={triggerOperativePing}
          onNavigatorToolSelect={setSelectedTool}
          selectedNavigatorTool={selectedTool}
          onQuickComms={handleQuickRadio}
          activeRadioMessage={activeRadioMessage}
          activeViewRole={dualRole}
          onSwitchViewRole={(role) => {
            if (role === 'navigator' || role === 'operative') {
              setDualRole(role);
            }
          }}
          fogOfWar={fogOfWar}
          onToggleFog={() => {
            const next = !fogOfWar;
            setFogOfWar(next);
            sim.current.fogOfWarEnabled = next;
          }}
          threatOverlay={threatOverlay}
          onToggleThreatOverlay={() => {
            const next = !threatOverlay;
            setThreatOverlay(next);
            sim.current.threatOverlayEnabled = next;
          }}
          missionGrid={sim.current.mission?.grid || currentMission.grid}
          playerX={hudPlayerPos.x}
          playerY={hudPlayerPos.y}
          discoveredDatacores={hudDiscoveredDatacores}
          isNavigatorVisible={showSplit || showNavOnly}
          killerDrone={hudKillerDrone}
          activeTheme={activeTheme}
          onSelectTheme={(t) => {
            setActiveTheme(t);
            sim.current.activeTheme = t;
          }}
        />
      )}

      {/* 4. STATUS MODALS (Pause, Victory, Game Over) */}
      {(gameState === 'paused' || gameState === 'gameover') && (
        <StatusModals
          state={
            gameState === 'paused'
              ? 'paused'
              : runStats && runStats.shieldsRemaining > 0
              ? 'victory'
              : 'gameover'
          }
          stats={runStats}
          onResume={() => setGameState('playing')}
          onRestart={handleRestart}
          onTitle={() => setGameState('title')}
          onNextMission={handleNextMission}
          hasNextMission={missionIdx < CAMPAIGN_MISSIONS.length - 1}
          activeTheme={activeTheme}
        />
      )}
    </main>
  );
}
