// main.ts - 增强版在线对战服务器（完整技能系统）
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

// ========== 配置区域 ==========
const ROOM_PASSWORD = "2025";  // 房间密码，可以修改为您想要的密码
const PORT = parseInt(Deno.env.get("PORT") || "8000");  // 服务器端口
const ROOM_EXPIRE_TIME = 2 * 60 * 60 * 1000;  // 房间过期时间（2小时）
const MAX_ROOMS = 10; // 最多允许存在的房间数
// ==============================

interface GameRoom {
  id: string;
  players: Map<string, PlayerInfo>;
  gameState: GameState | null;
  created: number;
  gameStarted: boolean;
}

interface PlayerInfo {
  id: string;
  playerId: 1 | 2;
  ws: WebSocket;
  connected: boolean;
  name: string;
}

interface GameState {
  currentPlayer: 1 | 2;
  players: { 1: PlayerState; 2: PlayerState; };
  gameEnded: boolean;
  skillMode: SkillMode;
  playerEffects: { 1: PlayerEffects; 2: PlayerEffects; };
  timeLeft: number;
  turnCount: number;
  processing: boolean;
}

interface SkillMode {
  active: boolean;
  type: string | null;
  selectedCells: SelectedCell[];
  targetPlayer: number | null;
}

interface SelectedCell {
  playerId: 1 | 2;
  row: number;
  col: number;
}

interface PlayerState {
  hp: number;
  maxHp: number;
  clicksLeft: number;
  maxClicks: number;
  board: (number | null)[][];
}

interface PlayerEffects {
  healBlocked: boolean;
  healBlockTurns: number;
  doubleDamage: boolean;
}

const rooms = new Map<string, GameRoom>();
const roomTimers = new Map<string, any>();

function createInitialGameState(): GameState {
  return {
    currentPlayer: 1,
    players: {
      1: { hp: 2500, maxHp: 2500, clicksLeft: 5, maxClicks: 5, board: createRandomBoard() },
      2: { hp: 2500, maxHp: 2500, clicksLeft: 5, maxClicks: 5, board: createRandomBoard() }
    },
    gameEnded: false,
    skillMode: { active: false, type: null, selectedCells: [], targetPlayer: null },
    playerEffects: {
      1: { healBlocked: false, healBlockTurns: 0, doubleDamage: false },
      2: { healBlocked: false, healBlockTurns: 0, doubleDamage: false }
    },
    timeLeft: 30,
    turnCount: 1,
    processing: false
  };
}

function createRandomBoard(): (number | null)[][] {
  const board = Array(5).fill(null).map(() => Array(5).fill(null));
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      board[i][j] = Math.floor(Math.random() * 5) + 1;
    }
  }
  while (hasConnectedGroups(board)) {
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) {
        board[i][j] = Math.floor(Math.random() * 5) + 1;
      }
    }
  }
  return board;
}

function hasConnectedGroups(board: (number | null)[][]): boolean {
  return findAllConnectedGroups(board).length > 0;
}

function findAllConnectedGroups(board: (number | null)[][]) {
  const visited = Array(5).fill(null).map(() => Array(5).fill(false));
  const groups: any[] = [];
  
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      if (!visited[i][j] && board[i][j] !== null && board[i][j] !== 0 && board[i][j] !== 50) {
        const group: any[] = [];
        const queue = [{row: i, col: j}];
        visited[i][j] = true;
        
        while (queue.length > 0) {
          const cell = queue.shift()!;
          group.push(cell);
          
          [[0,1],[0,-1],[1,0],[-1,0]].forEach(([dr, dc]) => {
            const nr = cell.row + dr, nc = cell.col + dc;
            if (nr >= 0 && nr < 5 && nc >= 0 && nc < 5 && !visited[nr][nc] && board[nr][nc] === board[i][j]) {
              visited[nr][nc] = true;
              queue.push({row: nr, col: nc});
            }
          });
        }
        
        if (group.length >= 3) groups.push(group);
      }
    }
  }
  return groups;
}

function broadcastToRoom(room: GameRoom, message: any, excludePlayerId?: string) {
  room.players.forEach((player, playerId) => {
    if (player.connected && player.ws.readyState === WebSocket.OPEN && playerId !== excludePlayerId) {
      try {
        player.ws.send(JSON.stringify(message));
      } catch (error) {
        player.connected = false;
      }
    }
  });
}

function startRoomTimer(room: GameRoom) {
  if (!room.gameState || room.gameState.gameEnded) return;
  
  // 强制清理所有现有计时器
  clearRoomTimer(room);
  
  console.log('[Timer] 为房间 ' + room.id + ' 启动计时器，初始时间: ' + room.gameState.timeLeft + '秒');
  
  const timer = setInterval(() => {
    // 双重检查：确保房间和游戏状态仍然有效
    if (!room.gameState || room.gameState.gameEnded || !rooms.has(room.id)) {
      console.log('[Timer] 房间 ' + room.id + ' 状态无效，清理计时器');
      clearInterval(timer);
      roomTimers.delete(room.id);
      return;
    }
    
    // 检查是否还有连接的玩家
    const connectedPlayers = Array.from(room.players.values()).filter(p => p.connected);
    if (connectedPlayers.length === 0) {
      console.log('[Timer] 房间 ' + room.id + ' 无连接玩家，清理计时器');
      clearInterval(timer);
      roomTimers.delete(room.id);
      return;
    }
    
    room.gameState.timeLeft--;
    console.log('[Timer] 房间 ' + room.id + ' 剩余时间: ' + room.gameState.timeLeft + '秒');
    
    // 广播时间更新
    broadcastToRoom(room, { 
      type: "timerUpdate", 
      timeLeft: room.gameState.timeLeft,
      currentPlayer: room.gameState.currentPlayer
    });
    
    // 时间到，结束回合
    if (room.gameState.timeLeft <= 0) {
      console.log('[Timer] 房间 ' + room.id + ' 时间到，强制结束回合');
      clearInterval(timer);
      roomTimers.delete(room.id);
      
      try {
        handleEndTurn(room);
        broadcastToRoom(room, { 
          type: "gameStateUpdate", 
          gameState: room.gameState, 
          action: "timeUp" 
        });
      } catch (error) {
        console.error('[Timer] 结束回合时出错:', error);
      }
    }
  }, 1000);
  
  roomTimers.set(room.id, timer);
}

function clearRoomTimer(room: GameRoom) {
  if (roomTimers.has(room.id)) {
    const timer = roomTimers.get(room.id);
    clearInterval(timer);
    roomTimers.delete(room.id);
    console.log('[Timer] 清理房间 ' + room.id + ' 的计时器');
  }
}

function resetRoomTimer(room: GameRoom, newTime: number = 60) {
  if (!room.gameState || room.gameState.gameEnded) return;
  
  room.gameState.timeLeft = newTime;
  startRoomTimer(room);
  console.log('[Timer] 重置房间 ' + room.id + ' 计时器为 ' + newTime + '秒');
}

function handleWebSocket(ws: WebSocket, roomId: string) {
  const room = rooms.get(roomId);
  if (!room) {
    ws.close(1000, "房间不存在");
    return;
  }

  let playerId: string | null = null;
  let playerInfo: PlayerInfo | null = null;

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      
      switch (data.type) {
        case "join": {
          if (data.password !== ROOM_PASSWORD) {
            ws.send(JSON.stringify({type: "error", message: "密码错误"}));
            ws.close();
            return;
          }
          
          const connectedPlayers = Array.from(room.players.values()).filter(p => p.connected);
          let assignedPlayerId: 1 | 2;
          
          if (connectedPlayers.length === 0) {
            assignedPlayerId = 1;
          } else if (connectedPlayers.length === 1) {
            assignedPlayerId = 2;
          } else {
            ws.send(JSON.stringify({type: "error", message: "房间已满"}));
            ws.close();
            return;
          }
          
          const playerName = (typeof data.name === "string" && data.name.trim().length > 0)
            ? data.name.trim()
            : Math.floor(10000000 + Math.random() * 90000000).toString();

          const duplicate = Array.from(room.players.values()).find(
            (p) => p.connected && p.name === playerName,
          );
          if (duplicate) {
            ws.send(JSON.stringify({ type: "error", message: "用户名已存在" }));
            ws.close();
            return;
          }
          playerId = `player_${Date.now()}_${Math.random()}`;
          playerInfo = { id: playerId, playerId: assignedPlayerId, ws: ws, connected: true, name: playerName };
          room.players.set(playerId, playerInfo);
          
          const activePlayerCount = Array.from(room.players.values()).filter(p => p.connected).length;
          
          if (activePlayerCount === 1) {
            ws.send(
              JSON.stringify({
                type: "joined",
                playerId: assignedPlayerId,
                name: playerName,
                gameState: null,
                waiting: true,
              }),
            );
          } else if (activePlayerCount === 2) {
            room.gameState = createInitialGameState();
            room.gameStarted = true;
            
            const names: Record<string, string> = {};
            room.players.forEach((p) => {
              names[p.playerId] = p.name;
            });
            room.players.forEach((player) => {
              if (player.connected && player.ws.readyState === WebSocket.OPEN) {
                player.ws.send(
                  JSON.stringify({
                    type: "gameStarted",
                    playerId: player.playerId,
                    gameState: room.gameState,
                    names,
                  }),
                );
              }
            });
            
            startRoomTimer(room);
          }
          break;
        }
          
        case "cellClick": {
          if (!playerInfo || !room.gameState || !room.gameStarted) return;
          
          // 如果在技能模式下，处理技能选择
          if (room.gameState.skillMode.active) {
            const skillResult = handleSkillCellSelection(room, playerInfo.playerId, data.row, data.col, data.targetPlayerId);
            if (!skillResult.success) {
              ws.send(JSON.stringify({type: "error", message: skillResult.error}));
            }
          } else {
            // 正常的点击处理
            const result = handleCellClick(room, playerInfo.playerId, data.row, data.col);
            if (result.success) {
              broadcastToRoom(room, { type: "gameStateUpdate", gameState: room.gameState, action: "cellClick" });
            } else {
              ws.send(JSON.stringify({type: "error", message: result.error}));
            }
          }
          break;
        }
          
        case "useSkill": {
          if (!playerInfo || !room.gameState || !room.gameStarted) return;
          
          if (room.gameState.currentPlayer === playerInfo.playerId) {
            const skillResult = handleSkillUse(room, playerInfo.playerId, data.skillType, data.skillData);
            if (skillResult.success) {
              broadcastToRoom(room, { type: "gameStateUpdate", gameState: room.gameState, action: "useSkill" });
            } else {
              ws.send(JSON.stringify({type: "error", message: skillResult.error}));
            }
          }
          break;
        }
          
        case "cancelSkill": {
          if (!playerInfo || !room.gameState || !room.gameStarted) return;
          
          if (room.gameState.currentPlayer === playerInfo.playerId && room.gameState.skillMode.active) {
            cancelSkillMode(room);
            broadcastToRoom(room, { type: "gameStateUpdate", gameState: room.gameState, action: "cancelSkill" });
          }
          break;
        }
          
        case "endTurn": {
          if (!playerInfo || !room.gameState || !room.gameStarted) return;
          
          if (room.gameState.currentPlayer === playerInfo.playerId && !room.gameState.gameEnded) {
            handleEndTurn(room);
            broadcastToRoom(room, { type: "gameStateUpdate", gameState: room.gameState, action: "endTurn" });
          }
          break;
        }
          
        case "surrender": {
          if (!playerInfo || !room.gameState || !room.gameStarted) return;
          
          if (!room.gameState.gameEnded) {
            // 设置认输玩家的血量为0
            room.gameState.players[playerInfo.playerId].hp = 0;
            room.gameState.gameEnded = true;
            
            clearRoomTimer(room);
            
            const winnerId: 1 | 2 = playerInfo.playerId === 1 ? 2 : 1;
            console.log('[GameEnd] 玩家' + playerInfo.playerId + ' 认输，玩家' + winnerId + ' 获胜');
            
            // 发送游戏结束消息
            broadcastToRoom(room, { 
              type: "gameEnd", 
              winner: winnerId,
              loser: playerInfo.playerId,
              reason: "surrender",
              gameState: room.gameState,
              surrenderPlayer: playerInfo.playerId
            });
          }
          break;
        }
      }
    } catch (error) {
      ws.send(JSON.stringify({type: "error", message: "消息处理失败"}));
    }
  };

  ws.onclose = () => {
    if (playerId && playerInfo) {
      playerInfo.connected = false;
      
      const connectedPlayers = Array.from(room.players.values()).filter(p => p.connected);
      
      // 如果游戏已开始且有玩家掉线，立即判定另一方获胜
      if (room.gameStarted && room.gameState && !room.gameState.gameEnded) {
        const remainingPlayer = connectedPlayers.find(p => p.id !== playerId);
        if (remainingPlayer) {
          // 设置掉线玩家血量为0，游戏结束
          room.gameState.players[playerInfo.playerId].hp = 0;
          room.gameState.gameEnded = true;
          
          // 停止计时器
          clearRoomTimer(room);
          
          // 通知剩余玩家获胜，然后强制刷新页面
          broadcastToRoom(room, { 
            type: "playerDisconnected", 
            disconnectedPlayer: playerInfo.playerId,
            winner: remainingPlayer.playerId,
            message: "对手掉线，你获胜了！",
            forceRefresh: true
          });
          
          // 延迟1秒后关闭所有连接，让玩家看到胜利信息后强制刷新
          setTimeout(() => {
            clearRoomTimer(room);
            room.players.forEach(player => {
              if (player.ws.readyState === WebSocket.OPEN) {
                player.ws.close(1000, "游戏结束，刷新页面");
              }
            });
            // 清理房间
            rooms.delete(room.id);
          }, 1000);
          
          return;
        }
      }
      
      // 原有的清理逻辑
      if (connectedPlayers.length === 0) {
        clearRoomTimer(room);
        // 完全删除房间，而不是只清空内容
        rooms.delete(room.id);
      }
    }
  };
}

function handleCellClick(room: GameRoom, playerId: 1 | 2, row: number, col: number) {
  const gameState = room.gameState!;
  
  if (gameState.processing) return {success: false, error: "处理中"};
  if (playerId !== gameState.currentPlayer) return {success: false, error: "不是你的回合"};
  
  const player = gameState.players[playerId];
  if (player.clicksLeft < 1) return {success: false, error: "行动力不足"};
  if (player.board[row][col] === null || player.board[row][col] === 0 || player.board[row][col] === 50) {
    return {success: false, error: "无法点击"};
  }
  
  gameState.processing = true;
  player.board[row][col]!++;
  player.clicksLeft--;
  
  setTimeout(() => {
    processConnectedGroups(room, playerId, row, col);
  }, 100);
  
  return {success: true};
}

function processConnectedGroups(room: GameRoom, playerId: 1 | 2, clickedRow: number, clickedCol: number) {
  const gameState = room.gameState!;
  
  // 检查游戏是否已结束
  if (gameState.gameEnded) {
    console.log('[Process] 游戏已结束，停止处理连击');
    return;
  }
  
  const groups = findAllConnectedGroups(gameState.players[playerId].board);
  
  if (groups.length > 0) {
    processGroupsSequentially(room, playerId, groups);
  } else {
    gameState.processing = false;
    broadcastToRoom(room, { type: "gameStateUpdate", gameState: gameState, action: "complete" });
  }
}

function processGroupsSequentially(room: GameRoom, playerId: 1 | 2, groups: any[]) {
  const gameState = room.gameState!;
  const player = gameState.players[playerId];
  
  groups.forEach(group => {
    if (group.length >= 3) {
      const targetCell = group[0];
      const cellsToClear = group.slice(1);
      
      const baseValue = player.board[targetCell.row][targetCell.col]!;
      const damage = baseValue * cellsToClear.length;
      const finalDamage = gameState.playerEffects[playerId].doubleDamage ? damage * 2 : damage;
      
      const opponentPlayer: 1 | 2 = playerId === 1 ? 2 : 1;
      const oldHp = gameState.players[opponentPlayer].hp;
      gameState.players[opponentPlayer].hp = Math.max(0, gameState.players[opponentPlayer].hp - finalDamage);
      
      console.log('[Damage] 玩家' + playerId + ' 对 玩家' + opponentPlayer + ' 造成 ' + finalDamage + ' 伤害 (' + oldHp + ' -> ' + gameState.players[opponentPlayer].hp + ')');
      
      // 立即检查游戏结束
      if (gameState.players[opponentPlayer].hp <= 0) {
        gameState.gameEnded = true;
        clearRoomTimer(room);
        console.log('[GameEnd] 玩家' + opponentPlayer + ' 血量归零，玩家' + playerId + ' 获胜');
        
        // 立即广播游戏结束
        broadcastToRoom(room, { 
          type: "gameEnd", 
          winner: playerId,
          loser: opponentPlayer,
          reason: "hp_zero",
          gameState: gameState
        });
        return;
      }
      
      cellsToClear.forEach(cell => { player.board[cell.row][cell.col] = null; });
      player.board[targetCell.row][targetCell.col]!++;
      player.clicksLeft = Math.min(player.clicksLeft + 0.5, player.maxClicks);
    }
  });
  
  // 只有游戏未结束才继续重力
  if (!gameState.gameEnded) {
    setTimeout(() => { applyGravity(room, playerId); }, 200);
  }
}

function applyGravity(room: GameRoom, playerId: 1 | 2) {
  const gameState = room.gameState!;
  
  // 检查游戏是否已结束
  if (gameState.gameEnded) {
    console.log('[Gravity] 游戏已结束，停止重力处理');
    return;
  }
  
  const board = gameState.players[playerId].board;
  let hasFalling = false;
  
  for (let col = 0; col < 5; col++) {
    for (let row = 4; row > 0; row--) {
      if (board[row][col] === null) {
        let sourceRow = row - 1;
        while (sourceRow >= 0 && board[sourceRow][col] === null) sourceRow--;
        
        if (sourceRow >= 0) {
          board[row][col] = board[sourceRow][col];
          board[sourceRow][col] = null;
          hasFalling = true;
        }
      }
    }
  }
  
  for (let col = 0; col < 5; col++) {
    if (board[0][col] === null) {
      board[0][col] = Math.floor(Math.random() * 5) + 1;
      hasFalling = true;
    }
  }
  
  if (hasFalling) {
    setTimeout(() => { applyGravity(room, playerId); }, 100);
  } else {
    const newGroups = findAllConnectedGroups(board);
    if (newGroups.length > 0) {
      setTimeout(() => { processGroupsSequentially(room, playerId, newGroups); }, 200);
    } else {
      gameState.processing = false;
      broadcastToRoom(room, { type: "gameStateUpdate", gameState: gameState, action: "complete" });
    }
  }
}

function handleSkillUse(room: GameRoom, playerId: 1 | 2, skillType: string, skillData: any) {
  const gameState = room.gameState!;
  const player = gameState.players[playerId];
  const costs: Record<string, number> = { 
    swap: 200, mindclear: 200, modify: 100, block: 100, 
    destroy: 200, breakthrough: 300, sacrifice: 40, odin: 400 
  };
  const cost = costs[skillType] || 0;
  
  if (player.hp <= cost) return {success: false, error: "血量不足"};
  if (skillType === 'breakthrough' && gameState.turnCount < 4) return {success: false, error: "需要第4回合后使用"};
  
  // 扣除血量
  player.hp -= cost;
  
  // 200血量以上的技能时间翻倍
  if (cost >= 200) {
    const bonus = Math.floor(gameState.timeLeft / 2);
    gameState.timeLeft += bonus;
    broadcastToRoom(room, { type: "timeBonus", bonus: bonus, newTime: gameState.timeLeft });
  }
  
  // 检查死亡
  if (player.hp <= 0) {
    gameState.gameEnded = true;
    clearRoomTimer(room);
    console.log('[GameEnd] 玩家' + playerId + ' 使用技能' + skillType + '后死亡，玩家' + (playerId === 1 ? 2 : 1) + ' 获胜');
    
    // 立即广播游戏结束
    const winnerId: 1 | 2 = playerId === 1 ? 2 : 1;
    broadcastToRoom(room, { 
      type: "gameEnd", 
      winner: winnerId,
      loser: playerId,
      reason: "skill_suicide",
      skillType: skillType,
      gameState: gameState
    });
    
    return {success: true};
  }
  
  switch (skillType) {
    case "swap":
      return activateSwapSkill(room, playerId);
      
    case "modify":
      return activateModifySkill(room, playerId, skillData);
      
    case "block":
      return activateBlockSkill(room, playerId);
      
    case "destroy":
      return activateDestroySkill(room, playerId);
      
    case "breakthrough":
      return activateBreakthroughSkill(room, playerId);
      
    case "sacrifice":
      return activateSacrificeSkill(room, playerId);
      
    case "mindclear":
      return activateMindClearSkill(room, playerId);
      
    case "odin":
      return activateOdinSkill(room, playerId);
      
    default:
      return {success: false, error: "未知技能"};
  }
}

function activateSwapSkill(room: GameRoom, playerId: 1 | 2) {
  const gameState = room.gameState!;
  
  // 进入交换模式
  gameState.skillMode = {
    active: true,
    type: 'swap',
    selectedCells: [],
    targetPlayer: null
  };
  
  return {success: true};
}

function activateModifySkill(room: GameRoom, playerId: 1 | 2, skillData: any) {
  const gameState = room.gameState!;
  
  if (!skillData.target || !skillData.action) {
    return {success: false, error: "需要选择目标和操作"};
  }
  
  const targetPlayerId = skillData.target === 'self' ? playerId : (playerId === 1 ? 2 : 1);
  const isAdd = skillData.action === 'add';
  const player = gameState.players[targetPlayerId];
  
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      if (player.board[i][j] !== null && player.board[i][j] !== 0 && player.board[i][j] !== 50) {
        if (isAdd) {
          player.board[i][j]!++;
        } else if (player.board[i][j]! > 1) {
          player.board[i][j]!--;
        }
      }
    }
  }
  
  return {success: true};
}

function activateBlockSkill(room: GameRoom, playerId: 1 | 2) {
  const gameState = room.gameState!;
  const opponentId: 1 | 2 = playerId === 1 ? 2 : 1;
  
  gameState.playerEffects[opponentId].healBlocked = true;
  gameState.playerEffects[opponentId].healBlockTurns = 10;
  
  return {success: true};
}

function activateDestroySkill(room: GameRoom, playerId: 1 | 2) {
  const gameState = room.gameState!;
  const opponentId: 1 | 2 = playerId === 1 ? 2 : 1;
  const opponent = gameState.players[opponentId];
  const availableCells: {row: number, col: number}[] = [];
  
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      if (opponent.board[i][j] !== null && opponent.board[i][j] !== 0 && opponent.board[i][j] !== 50) {
        availableCells.push({row: i, col: j});
      }
    }
  }
  
  if (availableCells.length > 0) {
    const randomCell = availableCells[Math.floor(Math.random() * availableCells.length)];
    opponent.board[randomCell.row][randomCell.col] = 50;
  }
  
  return {success: true};
}

function activateBreakthroughSkill(room: GameRoom, playerId: 1 | 2) {
  const gameState = room.gameState!;
  const player = gameState.players[playerId];
  
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      if (player.board[i][j] !== null && player.board[i][j] !== 0 && 
          player.board[i][j] !== 50 && player.board[i][j]! < 4) {
        player.board[i][j] = 4;
      }
    }
  }
  
  player.clicksLeft = player.maxClicks;
  
  return {success: true};
}

function activateSacrificeSkill(room: GameRoom, playerId: 1 | 2) {
  const gameState = room.gameState!;
  const player = gameState.players[playerId];
  
  player.clicksLeft = Math.min(player.clicksLeft + 1, player.maxClicks);
  
  return {success: true};
}

function activateMindClearSkill(room: GameRoom, playerId: 1 | 2) {
  const gameState = room.gameState!;
  
  // 进入心意消除模式
  gameState.skillMode = {
    active: true,
    type: 'mindclear',
    selectedCells: [],
    targetPlayer: playerId
  };
  
  return {success: true};
}

function activateOdinSkill(room: GameRoom, playerId: 1 | 2) {
  const gameState = room.gameState!;
  
  gameState.playerEffects[playerId].doubleDamage = true;
  
  return {success: true};
}

function handleSkillCellSelection(room: GameRoom, playerId: 1 | 2, row: number, col: number, targetPlayerId: 1 | 2) {
  const gameState = room.gameState!;
  
  if (gameState.currentPlayer !== playerId) {
    return {success: false, error: "不是你的回合"};
  }
  
  const skillMode = gameState.skillMode;
  
  switch (skillMode.type) {
    case 'swap':
      return handleSwapSelection(room, playerId, row, col, targetPlayerId);
      
    case 'mindclear':
      return handleMindClearSelection(room, playerId, row, col);
      
    default:
      return {success: false, error: "未知技能模式"};
  }
}

function handleSwapSelection(room: GameRoom, playerId: 1 | 2, row: number, col: number, targetPlayerId: 1 | 2) {
  const gameState = room.gameState!;
  const skillMode = gameState.skillMode;
  const targetBoard = gameState.players[targetPlayerId].board;
  
  if (targetBoard[row][col] === null) {
    return {success: false, error: "不能选择空格子"};
  }
  
  const newCell: SelectedCell = { playerId: targetPlayerId, row, col };
  
  // 检查是否已选择这个格子
  const isSelected = skillMode.selectedCells.some(
    cell => cell.playerId === targetPlayerId && cell.row === row && cell.col === col
  );
  
  if (isSelected) {
    // 取消选择
    skillMode.selectedCells = skillMode.selectedCells.filter(
      cell => !(cell.playerId === targetPlayerId && cell.row === row && cell.col === col)
    );
  } else {
    // 添加选择
    skillMode.selectedCells.push(newCell);
    
    // 如果选择了两个格子，执行交换
    if (skillMode.selectedCells.length === 2) {
      const [cell1, cell2] = skillMode.selectedCells;
      const player1 = gameState.players[cell1.playerId];
      const player2 = gameState.players[cell2.playerId];
      
      // 交换数值
      const temp = player1.board[cell1.row][cell1.col];
      player1.board[cell1.row][cell1.col] = player2.board[cell2.row][cell2.col];
      player2.board[cell2.row][cell2.col] = temp;
      
      // 取消技能模式
      cancelSkillMode(room);
      
      broadcastToRoom(room, { 
        type: "skillExecuted", 
        skill: "swap", 
        cells: [cell1, cell2] 
      });
    }
  }
  
  broadcastToRoom(room, { type: "gameStateUpdate", gameState: gameState, action: "skillSelection" });
  return {success: true};
}

function handleMindClearSelection(room: GameRoom, playerId: 1 | 2, row: number, col: number) {
  const gameState = room.gameState!;
  const player = gameState.players[playerId];
  const targetValue = player.board[row][col];
  
  if (targetValue === null || targetValue === 0 || targetValue === 50) {
    return {success: false, error: "不能选择这个格子"};
  }
  
  // 找到所有相同数值的方块
  const sameCells: {row: number, col: number}[] = [];
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      if (player.board[i][j] === targetValue) {
        sameCells.push({row: i, col: j});
      }
    }
  }
  
  if (sameCells.length === 0) {
    cancelSkillMode(room);
    return {success: false, error: "没有找到相同数值的方块"};
  }
  
  // 计算伤害
  const baseDamage = targetValue * sameCells.length;
  const finalDamage = gameState.playerEffects[playerId].doubleDamage ? baseDamage * 2 : baseDamage;
  
  // 对对手造成伤害
  const opponentId: 1 | 2 = playerId === 1 ? 2 : 1;
  const oldHp = gameState.players[opponentId].hp;
  gameState.players[opponentId].hp = Math.max(0, gameState.players[opponentId].hp - finalDamage);
  
  console.log('[MindClear] 玩家' + playerId + ' 对 玩家' + opponentId + ' 造成 ' + finalDamage + ' 伤害 (' + oldHp + ' -> ' + gameState.players[opponentId].hp + ')');
  
  // 消除方块
  sameCells.forEach(cell => {
    player.board[cell.row][cell.col] = null;
  });
  
  // 检查游戏结束
  if (gameState.players[opponentId].hp <= 0) {
    gameState.gameEnded = true;
    clearRoomTimer(room);
    console.log('[GameEnd] 玩家' + opponentId + ' 被心意消除击败，玩家' + playerId + ' 获胜');
    
    // 取消技能模式
    cancelSkillMode(room);
    
    // 立即广播游戏结束
    broadcastToRoom(room, { 
      type: "gameEnd", 
      winner: playerId,
      loser: opponentId,
      reason: "mindclear_kill",
      gameState: gameState,
      skill: "mindclear", 
      targetValue: targetValue,
      damage: finalDamage,
      cellCount: sameCells.length
    });
    
    return {success: true};
  } else {
    // 应用重力
    setTimeout(() => { applyGravity(room, playerId); }, 200);
  }
  
  // 取消技能模式
  cancelSkillMode(room);
  
  broadcastToRoom(room, { 
    type: "skillExecuted", 
    skill: "mindclear", 
    targetValue: targetValue,
    damage: finalDamage,
    cellCount: sameCells.length
  });
  
  return {success: true};
}

function cancelSkillMode(room: GameRoom) {
  const gameState = room.gameState!;
  gameState.skillMode = {
    active: false,
    type: null,
    selectedCells: [],
    targetPlayer: null
  };
}

function handleEndTurn(room: GameRoom) {
  const gameState = room.gameState!;
  const currentPlayerData = gameState.players[gameState.currentPlayer];
  
  gameState.processing = false;
  
  // 回血处理
  if (!gameState.playerEffects[gameState.currentPlayer].healBlocked) {
    let maxValue = 0;
    currentPlayerData.board.forEach(row => {
      row.forEach(cell => {
        if (cell !== null && cell !== 0 && cell !== 50 && cell > maxValue) maxValue = cell;
      });
    });
    
    if (currentPlayerData.hp < currentPlayerData.maxHp) {
      const healAmount = Math.min(maxValue || 1, currentPlayerData.maxHp - currentPlayerData.hp);
      currentPlayerData.hp += healAmount;
    }
  }
  
  // 取消技能模式
  cancelSkillMode(room);
  
  // 切换玩家
  gameState.currentPlayer = gameState.currentPlayer === 1 ? 2 : 1;
  if (gameState.currentPlayer === 1) gameState.turnCount++;
  
  // 恢复行动力
  gameState.players[gameState.currentPlayer].clicksLeft = Math.min(
    gameState.players[gameState.currentPlayer].clicksLeft + 1, 
    gameState.players[gameState.currentPlayer].maxClicks
  );
  
  // 更新效果状态
  [1, 2].forEach(pid => {
    const pId = pid as 1 | 2;
    if (gameState.playerEffects[pId].healBlocked && gameState.playerEffects[pId].healBlockTurns > 0) {
      gameState.playerEffects[pId].healBlockTurns--;
      if (gameState.playerEffects[pId].healBlockTurns <= 0) {
        gameState.playerEffects[pId].healBlocked = false;
      }
    }
    gameState.playerEffects[pId].doubleDamage = false;
  });
  
  gameState.timeLeft = 60;
  resetRoomTimer(room, 60);
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  
  if (url.pathname === "/") {
    return new Response(getGameHTML(), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  } else if (url.pathname === "/ws") {
    const roomId = url.searchParams.get("room");
    if (!roomId) {
      return new Response("Room id required", { status: 400 });
    }

    let targetRoom = rooms.get(roomId);

    if (!targetRoom) {
      if (rooms.size >= MAX_ROOMS) {
        const { socket, response } = Deno.upgradeWebSocket(req);
        socket.onopen = () => {
          socket.send(JSON.stringify({
            type: "error",
            message: "房间数量已达上限"
          }));
          setTimeout(() => socket.close(), 500);
        };
        socket.onerror = () => socket.close();
        return response;
      }

      targetRoom = {
        id: roomId,
        players: new Map(),
        gameState: null,
        created: Date.now(),
        gameStarted: false
      };
      rooms.set(roomId, targetRoom);
    }

    const connectedPlayers = Array.from(targetRoom.players.values()).filter(p => p.connected);
    if (connectedPlayers.length >= 2) {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onopen = () => {
        socket.send(JSON.stringify({
          type: "error",
          message: "房间已满（2/2），请稍后再试"
        }));
        setTimeout(() => socket.close(), 500);
      };
      socket.onerror = () => socket.close();
      return response;
    }
    
    const { socket, response } = Deno.upgradeWebSocket(req);
    handleWebSocket(socket, targetRoom.id);
    return response;
  } else if (url.pathname === "/rooms") {
    const info = Array.from(rooms.values()).map((r) => {
      const playerNames: Record<string, string> = {};
      r.players.forEach((p) => {
        if (p.connected) playerNames[p.playerId] = p.name;
      });
      return {
        id: r.id,
        count: Object.keys(playerNames).length,
        players: playerNames,
      };
    });
    return new Response(JSON.stringify(info), {
      headers: { "content-type": "application/json" },
    });
  }

  return new Response("Not Found", { status: 404 });
}

function getGameHTML(): string {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>点我加一在线对战</title>
    <style>
* { margin: 0; padding: 0; box-sizing: border-box; user-select: none; }
body { font-family: Arial, sans-serif; background: #f4f4f4; color: #333; padding: 10px; min-height: 100vh; }
.container { background: white; border-radius: 10px; box-shadow: 0 0 20px rgba(0,0,0,0.1); padding: 20px; max-width: 1200px; margin: 0 auto; min-height: calc(100vh - 20px); }
.game-header { text-align: center; margin-bottom: 30px; }
h1 { color: #4a4a4a; margin-bottom: 20px; font-size: 2rem; }
.connection-status { padding: 10px 20px; border-radius: 20px; font-weight: bold; margin-bottom: 20px; text-align: center; }
.connection-status.connecting { background: rgba(255,193,7,0.2); color: #ff8f00; border: 2px solid #ffc107; }
.connection-status.connected { background: rgba(76,175,80,0.2); color: #2e7d32; border: 2px solid #4caf50; }
.connection-status.waiting { background: rgba(33,150,243,0.2); color: #1565c0; border: 2px solid #2196f3; }
.login-container { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 60vh; gap: 20px; }
.login-form { background: rgba(255,255,255,0.1); border-radius: 15px; padding: 30px; border: 2px solid rgba(255,255,255,0.2); max-width: 400px; width: 100%; }
.form-group { margin-bottom: 20px; }
.form-group label { display: block; margin-bottom: 5px; color: #333; font-weight: bold; }
.form-group input { width: 100%; padding: 12px; border: 2px solid rgba(255,255,255,0.3); border-radius: 8px; background: rgba(255,255,255,0.1); color: #333; font-size: 16px; }
.login-btn { width: 100%; padding: 12px 24px; background: #4caf50; color: white; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; transition: all 0.3s ease; }
.login-btn:hover { background: #388e3c; transform: translateY(-2px); }
.game-layout { display: flex; justify-content: space-between; gap: 30px; flex-wrap: wrap; }
.player-section { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 20px; min-width: 300px; }
.player-info { width: 100%; max-width: 300px; padding: 20px; border-radius: 15px; border: 3px solid transparent; background: rgba(255,255,255,0.1); }
.player-info.active { border-color: #ffeb3b; box-shadow: 0 0 15px rgba(255,235,59,0.4); }
.player1 .player-name { color: #2196f3; font-size: 1.4rem; font-weight: bold; margin-bottom: 15px; text-align: center; }
.player2 .player-name { color: #f44336; font-size: 1.4rem; font-weight: bold; margin-bottom: 15px; text-align: center; }
.hp-container { margin-bottom: 15px; }
.hp-label { font-size: 1rem; margin-bottom: 8px; color: #555; font-weight: 600; }
.hp-bar { width: 100%; height: 25px; background: #e0e0e0; border-radius: 15px; overflow: hidden; position: relative; border: 2px solid rgba(255,255,255,0.3); }
.hp-fill { height: 100%; border-radius: 10px; transition: width 0.5s ease; }
.player1 .hp-fill { background: linear-gradient(90deg, #2196f3, #42a5f5); }
.player2 .hp-fill { background: linear-gradient(90deg, #ff9800, #ffa726); }
.hp-text { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 0.9rem; color: #000; z-index: 10; }
.game-stats { width: 100%; max-width: 300px; padding: 15px; background: rgba(0,0,0,0.05); border-radius: 15px; }
.counter-label { font-weight: bold; color: #555; font-size: 0.9rem; margin-bottom: 5px; }
.game-board { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; width: 100%; max-width: 300px; aspect-ratio: 1; padding: 15px; background: rgba(255,255,255,0.1); border-radius: 15px; border: 2px solid rgba(255,255,255,0.2); }
.cell { background: #e0e0e0; border-radius: 8px; display: flex; justify-content: center; align-items: center; font-size: 16px; font-weight: bold; cursor: pointer; transition: transform 0.1s ease; box-shadow: 0 2px 5px rgba(0,0,0,0.1); min-height: 40px; }
.cell:hover { transform: scale(1.05); }
.cell.empty { background: transparent; box-shadow: none; }
.cell.disabled { opacity: 0.6; cursor: not-allowed; }
.cell.skill-selectable { border: 2px solid #4caf50; animation: pulse 1s infinite; }
.cell.skill-selected { background: #4caf50 !important; color: white; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
.cell[data-value="1"] { background: #a2d2ff; }
.cell[data-value="2"] { background: #bde0fe; }
.cell[data-value="3"] { background: #ffafcc; }
.cell[data-value="4"] { background: #ffc8dd; }
.cell[data-value="5"] { background: #cdb4db; }
.cell[data-value="6"] { background: #98f5e1; }
.cell[data-value="7"] { background: #8eecf5; }
.cell[data-value="8"] { background: #90dbf4; }
.cell[data-value="9"] { background: #f08080; }
.cell[data-value="10"] { background: #f4a261; }
.cell[data-value="50"] { background: #d32f2f; color: white; border: 2px solid #ffeb3b; }
.center-controls { display: flex; flex-direction: column; align-items: center; gap: 20px; min-width: 200px; padding: 0 20px; }
.current-turn { text-align: center; padding: 15px 25px; border-radius: 15px; background: rgba(255,255,255,0.1); border: 3px solid transparent; }
.current-turn.player1 { border-color: #2196f3; color: #2196f3; }
.current-turn.player2 { border-color: #f44336; color: #f44336; }
.timer-display { display: flex; align-items: center; gap: 5px; padding: 8px 16px; background: rgba(255,255,255,0.1); border-radius: 20px; font-weight: bold; }
.timer-value { font-size: 1.4rem; min-width: 30px; text-align: center; }
.skills-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; width: 100%; max-width: 300px; margin: 20px 0; }
.center-skill-btn { padding: 8px 10px; background: linear-gradient(135deg, #673ab7, #9c27b0); color: white; border: none; border-radius: 6px; font-size: 11px; cursor: pointer; transition: all 0.3s ease; text-align: center; }
.center-skill-btn:hover { background: linear-gradient(135deg, #7e57c2, #ba68c8); }
.center-skill-btn:disabled { background: #bdbdbd; opacity: 0.6; cursor: not-allowed; }
.center-skill-btn.active { background: linear-gradient(135deg, #4caf50, #66bb6a); box-shadow: 0 0 10px rgba(76, 175, 80, 0.5); }
.turn-counter { text-align: center; font-size: 1rem; font-weight: bold; color: #555; margin-top: 15px; padding: 8px 16px; background: rgba(255,255,255,0.1); border-radius: 20px; }
.turn-counter span { color: #4caf50; font-size: 1.2rem; }
.game-buttons { display: flex; flex-direction: column; gap: 15px; align-items: center; }
button { padding: 12px 24px; background: #4caf50; color: white; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; transition: all 0.3s ease; min-width: 140px; }
button:hover { background: #388e3c; transform: translateY(-2px); }
button:disabled { opacity: 0.6; cursor: not-allowed; }
#end-turn-btn { background: #2196f3; }
#end-turn-btn:hover:not(:disabled) { background: #1976d2; }
#surrender-btn { background: #f44336; }
#surrender-btn:hover:not(:disabled) { background: #d32f2f; }
.status-effects { font-size: 0.8rem; color: #666; margin-top: 10px; text-align: center; }
.status-effects.heal-blocked { color: #f44336; }
.status-effects.double-damage { color: #ffd700; text-shadow: 0 0 5px rgba(255, 215, 0, 0.5); }
.game-modal { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; opacity: 0; transition: opacity 0.3s ease; }
.game-modal.show { opacity: 1; }
.modal-content { background: white; border-radius: 10px; padding: 30px; max-width: 400px; width: 90%; text-align: center; }
.modal-content h2 { margin-bottom: 20px; color: #333; }
.skill-options { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 20px 0; }
.skill-option-btn { padding: 10px; background: #2196f3; color: white; border: none; border-radius: 5px; cursor: pointer; transition: all 0.3s ease; }
.skill-option-btn:hover { background: #1976d2; }
.modal-buttons { display: flex; justify-content: center; gap: 10px; margin-top: 20px; }
.modal-btn { padding: 10px 20px; background: #4caf50; color: white; border: none; border-radius: 5px; cursor: pointer; transition: all 0.3s ease; }
.modal-btn:hover { background: #388e3c; }
@media (max-width: 768px) {
    .game-layout { flex-direction: column; align-items: center; }
    .player-section { min-width: auto; width: 100%; max-width: 400px; }
}
    </style>
</head>
<body>
    <div class="container" id="app-container">
        <div class="login-container" id="login-container">
            <div class="login-form">
                <h2>🎮 点我加一在线对战</h2>
                <div class="form-group">
                    <label for="player-name">用户名（可选）</label>
                    <input type="text" id="player-name" placeholder="请输入用户名">
                </div>
                <div class="form-group">
                    <label for="room-password">房间密码</label>
                    <input type="password" id="room-password" placeholder="请输入房间密码" maxlength="50">
                </div>
                <div class="form-group">
                    <label for="room-id">房间</label>
                    <select id="room-id">
                        <option value="room1">房间1</option>
                        <option value="room2">房间2</option>
                        <option value="room3">房间3</option>
                        <option value="room4">房间4</option>
                        <option value="room5">房间5</option>
                        <option value="room6">房间6</option>
                        <option value="room7">房间7</option>
                        <option value="room8">房间8</option>
                        <option value="room9">房间9</option>
                        <option value="room10">房间10</option>
                    </select>
                </div>
                <button class="login-btn" id="join-btn">加入游戏</button>
                <div id="rooms-info" style="margin-top:20px;font-size:14px;"></div>
            </div>
            <div class="connection-status connecting" id="login-status">连接中...</div>
        </div>

        <div class="login-container" id="waiting-container" style="display: none;">
            <div class="login-form">
                <h2>🎮 等待对手</h2>
                <p style="text-align: center; margin: 20px 0;">等待第二个玩家加入...</p>
                <button class="login-btn" onclick="window.location.reload()">返回重新加入</button>
            </div>
            <div class="connection-status waiting">等待对手加入...</div>
        </div>

        <div class="game-content" id="game-content" style="display: none;">
            <div class="game-header">
                <h1>点我加一在线对战</h1>
                <div class="connection-status connected" id="connection-status">
                    已连接 - 你是玩家<span id="my-player-id">1</span>
                </div>
            </div>
            
            <div class="game-layout">
                <div class="player-section player1 active" id="player1-section">
                    <div class="player-info player1 active" id="player1-info">
                        <div class="player-name">玩家1</div>
                        <div class="hp-container">
                            <div class="hp-label">生命值</div>
                            <div class="hp-bar">
                                <div class="hp-fill" id="player1-hp-fill" style="width: 100%;"></div>
                                <div class="hp-text" id="player1-hp-text">2500 / 2500</div>
                            </div>
                        </div>
                        <div class="status-effects" id="player1-status"></div>
                    </div>
                    <div class="game-stats">
                        <div class="counter-label">行动力: <span id="player1-clicks-left">5</span></div>
                    </div>
                    <div class="game-board" id="player1-board" data-player="1"></div>
                </div>
                
                <div class="center-controls">
                    <div class="current-turn player1" id="current-turn-display">
                        <h3>玩家1 的回合</h3>
                        <div class="timer-display">
                            <span>剩余时间:</span>
                            <span class="timer-value" id="timer-value">30</span>
                            <span>秒</span>
                        </div>
                    </div>
                    
                    <div class="game-buttons">
                        <button id="end-turn-btn">结束回合</button>
                        <button id="surrender-btn">认输</button>
                        <button id="cancel-skill-btn" style="display: none;">取消技能</button>
                    </div>

                    <div class="skills-grid">
                        <button class="center-skill-btn" data-skill="swap" data-cost="200" title="可以交换场上任意两个方块">交换方块(-200)</button>
                        <button class="center-skill-btn" data-skill="modify" data-cost="100" title="己方或对方方块所有数值+1或者-1">数值±1(-100)</button>
                        <button class="center-skill-btn" data-skill="block" data-cost="100" title="禁用对方回血10回合">生命枯竭(-100)</button>
                        <button class="center-skill-btn" data-skill="destroy" data-cost="200" title="随机让对方一个方块变成50">挑衅(-200)</button>
                        <button class="center-skill-btn" data-skill="breakthrough" data-cost="300" title="把己方场上所有小于4的方块全部变成4，并恢复满行动力（需第4回合后）">搏命突围(-300)</button>
                        <button class="center-skill-btn" data-skill="sacrifice" data-cost="40" title="消耗40血量，获得1点行动力">苦肉(-40)</button>
                        <button class="center-skill-btn" data-skill="mindclear" data-cost="200" title="选择自己的一个方块，所有相同数值的方块被消除并造成伤害">心意消除(-200)</button>
                        <button class="center-skill-btn" data-skill="odin" data-cost="400" title="消耗400血量，当前回合所有攻击伤害翻倍">奥丁祝福(-400)</button>
                    </div>

                    <div class="turn-counter">第 <span id="turn-count">1</span> 回合</div>
                </div>
                
                <div class="player-section player2" id="player2-section">
                    <div class="player-info player2" id="player2-info">
                        <div class="player-name">玩家2</div>
                        <div class="hp-container">
                            <div class="hp-label">生命值</div>
                            <div class="hp-bar">
                                <div class="hp-fill" id="player2-hp-fill" style="width: 100%;"></div>
                                <div class="hp-text" id="player2-hp-text">2500 / 2500</div>
                            </div>
                        </div>
                        <div class="status-effects" id="player2-status"></div>
                    </div>
                    <div class="game-stats">
                        <div class="counter-label">行动力: <span id="player2-clicks-left">5</span></div>
                    </div>
                    <div class="game-board" id="player2-board" data-player="2"></div>
                </div>
            </div>
        </div>
    </div>

    <script>
        class OnlineBattleGame {
            constructor() {
                this.ws = null;
                this.myPlayerId = null;
                this.gameState = null;
                this.isConnected = false;
                this.processing = false;
                this.playerNames = {};

                this.initElements();
                this.initEventListeners();
                this.fetchRooms();
                setInterval(() => this.fetchRooms(), 1000);
            }

            initElements() {
                this.loginContainer = document.getElementById('login-container');
                this.waitingContainer = document.getElementById('waiting-container');
                this.gameContent = document.getElementById('game-content');
                this.nameInput = document.getElementById('player-name');
                this.roomPasswordInput = document.getElementById('room-password');
                this.roomSelect = document.getElementById('room-id');
                this.roomsInfo = document.getElementById('rooms-info');
                this.joinButton = document.getElementById('join-btn');
                this.connectionStatus = document.getElementById('connection-status');
                this.myPlayerIdSpan = document.getElementById('my-player-id');
                this.player1Board = document.getElementById('player1-board');
                this.player2Board = document.getElementById('player2-board');
                this.endTurnButton = document.getElementById('end-turn-btn');
                this.surrenderButton = document.getElementById('surrender-btn');
                this.cancelSkillButton = document.getElementById('cancel-skill-btn');
                this.timerValue = document.getElementById('timer-value');
            }

            initEventListeners() {
                this.joinButton.addEventListener('click', () => this.joinGame());
                this.roomPasswordInput.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') this.joinGame();
                });
                this.endTurnButton.addEventListener('click', () => this.endTurn());
                this.surrenderButton.addEventListener('click', () => this.showSurrenderConfirm());
                this.cancelSkillButton.addEventListener('click', () => this.cancelSkill());
                
                document.addEventListener('click', (e) => {
                    if (e.target.classList.contains('center-skill-btn')) {
                        this.handleSkillClick(e.target);
                    } else if (e.target.classList.contains('cell')) {
                        this.handleCellClick(e.target);
                    }
                });
            }

            async joinGame() {
                const password = this.roomPasswordInput.value.trim();
                if (!password) return;
                const name = this.nameInput.value.trim();
                const room = this.roomSelect.value;

                this.joinButton.disabled = true;
                
                try {
                    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                    const wsUrl = protocol + '//' + window.location.host + '/ws?room=' + encodeURIComponent(room);

                    this.ws = new WebSocket(wsUrl);
                    this.ws.onopen = () => this.sendMessage({ type: 'join', password: password, name: name });
                    this.ws.onmessage = (event) => this.handleMessage(JSON.parse(event.data));
                    this.ws.onclose = () => this.handleDisconnect();
                    this.ws.onerror = () => {
                        this.joinButton.disabled = false;
                        this.showMessage('连接失败', 'error');
                    };
                } catch (error) {
                    this.joinButton.disabled = false;
                    this.showMessage('连接失败', 'error');
                }
            }

            sendMessage(message) {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify(message));
                }
            }

            handleMessage(data) {
                switch (data.type) {
                    case 'joined':
                        if (data.waiting) {
                            this.handleWaitingForPlayer(data);
                        } else {
                            this.handleJoinSuccess(data);
                        }
                        break;
                    case 'gameStarted':
                        this.handleGameStarted(data);
                        break;
                    case 'gameStateUpdate':
                        this.handleGameStateUpdate(data);
                        break;
                    case 'gameEnd':
                        this.handleGameEnd(data);
                        break;
                    case 'timerUpdate':
                        this.handleTimerUpdate(data);
                        break;
                    case 'timeBonus':
                        this.handleTimeBonus(data);
                        break;
                    case 'skillExecuted':
                        this.handleSkillExecuted(data);
                        break;
                    case 'playerDisconnected':
                        this.handlePlayerDisconnected(data);
                        break;
                    case 'error':
                        this.showMessage(data.message, 'error');
                        this.joinButton.disabled = false;
                        this.processing = false;
                        break;
                }
            }

            handleWaitingForPlayer(data) {
                this.myPlayerId = data.playerId;
                this.playerNames[data.playerId] = data.name;
                this.loginContainer.style.display = 'none';
                this.waitingContainer.style.display = 'block';
                this.showMessage('等待对手加入...', 'info');
            }

            handleGameStarted(data) {
                this.myPlayerId = data.playerId;
                this.gameState = data.gameState;
                this.isConnected = true;
                if (data.names) {
                    this.playerNames = data.names;
                }

                this.loginContainer.style.display = 'none';
                this.waitingContainer.style.display = 'none';
                this.gameContent.style.display = 'block';

                this.myPlayerIdSpan.textContent = this.myPlayerId;
                this.updateGameDisplay();
                this.showMessage('游戏开始！', 'success');
            }

            handleGameStateUpdate(data) {
                this.gameState = data.gameState;
                
                if (data.action === 'complete') {
                    this.processing = false;
                }
                
                if (data.action === 'timeUp') {
                    this.showMessage('时间到！强制结束回合', 'info');
                }
                
                this.updateGameDisplay();
            }

            handleTimerUpdate(data) {
                if (this.gameState) {
                    this.gameState.timeLeft = data.timeLeft;
                    this.timerValue.textContent = data.timeLeft;
                    
                    // 如果计时器包含当前玩家信息，确保同步
                    if (data.currentPlayer && this.gameState.currentPlayer !== data.currentPlayer) {
                        this.gameState.currentPlayer = data.currentPlayer;
                        this.updateCurrentTurn();
                        this.updateSkillButtons();
                    }
                }
            }

            handleTimeBonus(data) {
                if (this.gameState) {
                    this.gameState.timeLeft = data.newTime;
                    this.timerValue.textContent = data.newTime;
                                            this.showMessage('技能奖励！时间增加：+' + data.bonus + '秒', 'success');
                }
            }

            handleSkillExecuted(data) {
                switch (data.skill) {
                    case 'swap':
                        this.showMessage('交换完成！', 'success');
                        break;
                    case 'mindclear':
                        this.showMessage('心意消除成功！消除' + data.cellCount + '个数值' + data.targetValue + '的方块，造成' + data.damage + '伤害！', 'success');
                        break;
                }
            }

            handlePlayerDisconnected(data) {
                const isWinner = data.winner === this.myPlayerId;
                const message = isWinner ? 
                    '对手掉线，你获胜了！页面即将刷新...' : 
                    '连接断开，游戏结束！页面即将刷新...';
                
                this.showMessage(message, isWinner ? 'success' : 'error');
                
                // 如果标记了强制刷新，则刷新页面
                if (data.forceRefresh) {
                    setTimeout(() => {
                        window.location.reload();
                    }, 1500);
                } else {
                    // 否则返回登录页面
                    setTimeout(() => {
                        this.returnToLogin();
                    }, 2000);
                }
            }

            returnToLogin() {
                // 重置所有状态
                this.ws = null;
                this.myPlayerId = null;
                this.gameState = null;
                this.isConnected = false;
                this.processing = false;
                
                // 显示登录界面，隐藏其他界面
                this.loginContainer.style.display = 'block';
                this.waitingContainer.style.display = 'none';
                this.gameContent.style.display = 'none';
                
                // 重置表单
                this.roomPasswordInput.value = '';
                this.joinButton.disabled = false;
                
                // 更新状态显示
                document.getElementById('login-status').textContent = '请输入密码加入游戏';
                document.getElementById('login-status').className = 'connection-status connecting';
            }

            handleDisconnect() {
                this.isConnected = false;
                
                // 如果在游戏中断开连接，显示消息后刷新页面
                if (this.gameState && !this.gameState.gameEnded) {
                    this.showMessage('连接已断开，页面即将刷新...', 'error');
                    setTimeout(() => {
                        window.location.reload();
                    }, 1500);
                } else {
                    this.showMessage('连接已断开', 'error');
                    // 如果不在游戏中，刷新页面
                    setTimeout(() => {
                        window.location.reload();
                    }, 1000);
                }
            }

            handleGameEnd(data) {
                // 更新游戏状态
                if (data.gameState) {
                    this.gameState = data.gameState;
                    this.updateGameDisplay();
                }
                
                const isWinner = data.winner === this.myPlayerId;
                let message = isWinner ? '🎉 你获胜了！' : '😔 你失败了！';
                
                // 根据结束原因添加详细信息
                switch (data.reason) {
                    case 'hp_zero':
                        message += isWinner ? ' 对手血量归零!' : ' 你的血量归零!';
                        break;
                    case 'mindclear_kill':
                        message += isWinner ? 
                            ' 心意消除造成' + data.damage + '伤害击败对手!' : 
                            ' 被对手心意消除击败!';
                        break;
                    case 'surrender':
                        message += isWinner ? ' 对手认输了!' : ' 你认输了!';
                        break;
                    case 'skill_suicide':
                        message += isWinner ? 
                            ' 对手使用技能' + data.skillType + '后血量不足死亡!' : 
                            ' 你使用技能' + data.skillType + '后血量不足死亡!';
                        break;
                    default:
                        message += ' 游戏结束!';
                        break;
                }
                
                message += '\\n\\n最终血量:\\n玩家1: ' + this.gameState.players[1].hp + 'HP\\n玩家2: ' + this.gameState.players[2].hp + 'HP';
                
                this.showMessage(message, isWinner ? 'success' : 'error');
                
                // 显示详细的胜利/失败弹窗
                setTimeout(() => {
                    alert(message);
                    
                    // 2秒后刷新页面
                    setTimeout(() => {
                        window.location.reload();
                    }, 2000);
                }, 500);
                
                // 停止处理状态
                this.processing = false;
            }

            updateGameDisplay() {
                if (!this.gameState) return;
                
                this.updateBoard(1);
                this.updateBoard(2);
                this.updatePlayerDisplay();
                this.updateHP();
                this.updateCurrentTurn();
                this.updateSkillButtons();
                this.updateStatusEffects();
                this.updateSkillMode();
                
                document.getElementById('turn-count').textContent = this.gameState.turnCount;
                this.timerValue.textContent = this.gameState.timeLeft;
                
                // 如果游戏结束，禁用所有交互
                if (this.gameState.gameEnded) {
                    this.endTurnButton.disabled = true;
                    this.surrenderButton.disabled = true;
                    this.cancelSkillButton.style.display = 'none';
                    
                    // 禁用所有技能按钮
                    document.querySelectorAll('.center-skill-btn').forEach(btn => {
                        btn.disabled = true;
                    });
                    
                    // 禁用所有棋盘交互
                    document.querySelectorAll('.cell').forEach(cell => {
                        cell.classList.add('disabled');
                        cell.style.cursor = 'not-allowed';
                    });
                }
            }

            updateBoard(playerId) {
                const board = playerId === 1 ? this.player1Board : this.player2Board;
                const gameBoard = this.gameState.players[playerId].board;
                
                board.innerHTML = '';
                
                for (let i = 0; i < 5; i++) {
                    for (let j = 0; j < 5; j++) {
                        const cell = document.createElement('div');
                        cell.classList.add('cell');
                        
                        const value = gameBoard[i][j];
                        if (value !== null) {
                            cell.textContent = value;
                            cell.setAttribute('data-value', value);
                        } else {
                            cell.classList.add('empty');
                        }
                        
                        cell.dataset.row = i;
                        cell.dataset.col = j;
                        cell.dataset.player = playerId;
                        
                        this.updateCellInteraction(cell, playerId, i, j);
                        board.appendChild(cell);
                    }
                }
            }

            updateCellInteraction(cell, playerId, row, col) {
                const value = this.gameState.players[playerId].board[row][col];
                
                // 技能模式下的交互
                if (this.gameState.skillMode.active) {
                    if (this.gameState.skillMode.type === 'swap') {
                        if (value !== null) {
                            cell.classList.add('skill-selectable');
                            // 检查是否已选中
                            const isSelected = this.gameState.skillMode.selectedCells.some(
                                c => c.playerId === playerId && c.row === row && c.col === col
                            );
                            if (isSelected) {
                                cell.classList.add('skill-selected');
                            }
                        }
                    } else if (this.gameState.skillMode.type === 'mindclear' && playerId === this.myPlayerId) {
                        if (value !== null && value !== 0 && value !== 50) {
                            cell.classList.add('skill-selectable');
                        }
                    }
                    return;
                }
                
                // 正常模式下的交互
                const canOperate = (
                    playerId === this.myPlayerId && 
                    this.gameState.currentPlayer === this.myPlayerId &&
                    this.gameState.players[this.myPlayerId].clicksLeft >= 1 &&
                    value !== null && value !== 0 && value !== 50 &&
                    !this.processing && !this.gameState.processing
                );
                
                if (canOperate) {
                    cell.classList.remove('disabled');
                } else {
                    cell.classList.add('disabled');
                }
            }

            updatePlayerDisplay() {
                document.getElementById('player1-clicks-left').textContent = this.gameState.players[1].clicksLeft.toFixed(1);
                document.getElementById('player2-clicks-left').textContent = this.gameState.players[2].clicksLeft.toFixed(1);
                if (this.playerNames[1]) {
                    document.querySelector('#player1-info .player-name').textContent = this.playerNames[1];
                }
                if (this.playerNames[2]) {
                    document.querySelector('#player2-info .player-name').textContent = this.playerNames[2];
                }
            }

            updateHP() {
                const player1 = this.gameState.players[1];
                const hp1Percent = (player1.hp / player1.maxHp) * 100;
                document.getElementById('player1-hp-fill').style.width = hp1Percent + '%';
                document.getElementById('player1-hp-text').textContent = player1.hp + ' / ' + player1.maxHp;
                
                const player2 = this.gameState.players[2];
                const hp2Percent = (player2.hp / player2.maxHp) * 100;
                document.getElementById('player2-hp-fill').style.width = hp2Percent + '%';
                document.getElementById('player2-hp-text').textContent = player2.hp + ' / ' + player2.maxHp;
            }

            updateCurrentTurn() {
                const currentPlayer = this.gameState.currentPlayer;
                const isMyTurn = currentPlayer === this.myPlayerId;
                
                document.getElementById('current-turn-display').className = 'current-turn player' + currentPlayer;
                document.getElementById('current-turn-display').innerHTML = 
                    '<h3>玩家' + currentPlayer + ' 的回合</h3>' +
                    '<div class="timer-display">' +
                        '<span>剩余时间:</span>' +
                        '<span class="timer-value" id="timer-value">' + this.gameState.timeLeft + '</span>' +
                        '<span>秒</span>' +
                    '</div>';
                
                this.timerValue = document.getElementById('timer-value');
            }

            updateSkillButtons() {
                const skillButtons = document.querySelectorAll('.center-skill-btn');
                const currentPlayer = this.gameState.players[this.myPlayerId];
                const isMyTurn = this.gameState.currentPlayer === this.myPlayerId;
                
                skillButtons.forEach(button => {
                    const cost = parseInt(button.dataset.cost);
                    const skillType = button.dataset.skill;
                    let disabled = !isMyTurn || this.gameState.gameEnded || currentPlayer.hp <= cost || this.processing;
                    
                    // 特殊条件检查
                    if (skillType === 'breakthrough' && this.gameState.turnCount < 4) {
                        disabled = true;
                        button.title = button.title + ' (需要第4回合后)';
                    }
                    
                    button.disabled = disabled;
                    
                    // 高亮激活的技能
                    if (this.gameState.skillMode.active && this.gameState.skillMode.type === skillType) {
                        button.classList.add('active');
                    } else {
                        button.classList.remove('active');
                    }
                });
                
                // 更新结束回合按钮状态
                this.endTurnButton.disabled = !isMyTurn || this.gameState.gameEnded || this.processing;
                
                // 更新认输按钮状态
                this.surrenderButton.disabled = this.gameState.gameEnded;
            }

            updateStatusEffects() {
                // 玩家1状态
                const player1Status = document.getElementById('player1-status');
                let p1Status = [];
                if (this.gameState.playerEffects[1].healBlocked) {
                    p1Status.push('回血被禁用 (' + this.gameState.playerEffects[1].healBlockTurns + '回合)');
                    player1Status.classList.add('heal-blocked');
                } else {
                    player1Status.classList.remove('heal-blocked');
                }
                if (this.gameState.playerEffects[1].doubleDamage) {
                    p1Status.push('攻击力翻倍 ⚡');
                    player1Status.classList.add('double-damage');
                } else {
                    player1Status.classList.remove('double-damage');
                }
                player1Status.textContent = p1Status.join(' | ');
                
                // 玩家2状态
                const player2Status = document.getElementById('player2-status');
                let p2Status = [];
                if (this.gameState.playerEffects[2].healBlocked) {
                    p2Status.push('回血被禁用 (' + this.gameState.playerEffects[2].healBlockTurns + '回合)');
                    player2Status.classList.add('heal-blocked');
                } else {
                    player2Status.classList.remove('heal-blocked');
                }
                if (this.gameState.playerEffects[2].doubleDamage) {
                    p2Status.push('攻击力翻倍 ⚡');
                    player2Status.classList.add('double-damage');
                } else {
                    player2Status.classList.remove('double-damage');
                }
                player2Status.textContent = p2Status.join(' | ');
            }

            updateSkillMode() {
                if (this.gameState.skillMode.active && this.gameState.currentPlayer === this.myPlayerId) {
                    this.cancelSkillButton.style.display = 'block';
                } else {
                    this.cancelSkillButton.style.display = 'none';
                }
            }

            handleCellClick(cellElement) {
                const playerId = parseInt(cellElement.dataset.player);
                const row = parseInt(cellElement.dataset.row);
                const col = parseInt(cellElement.dataset.col);
                
                // 技能模式下的处理
                if (this.gameState.skillMode.active) {
                    if (this.gameState.currentPlayer !== this.myPlayerId) return;
                    
                    this.processing = true;
                    this.sendMessage({ 
                        type: 'cellClick', 
                        row: row, 
                        col: col,
                        targetPlayerId: playerId
                    });
                    
                    setTimeout(() => { this.processing = false; }, 1000);
                    return;
                }
                
                // 正常点击处理
                if (this.gameState.gameEnded || this.processing || this.gameState.processing) return;
                if (playerId !== this.myPlayerId || this.gameState.currentPlayer !== this.myPlayerId) return;
                
                const cellValue = this.gameState.players[playerId].board[row][col];
                if (cellValue === null || cellValue === 0 || cellValue === 50) return;
                if (this.gameState.players[this.myPlayerId].clicksLeft < 1) return;
                
                this.processing = true;
                this.sendMessage({ type: 'cellClick', row: row, col: col });
                
                setTimeout(() => { this.processing = false; }, 3000);
            }

            handleSkillClick(button) {
                if (this.gameState.gameEnded || this.gameState.currentPlayer !== this.myPlayerId || this.processing) return;
                
                const skillType = button.dataset.skill;
                
                // 如果是数值修改技能，显示选择界面
                if (skillType === 'modify') {
                    this.showModifySkillModal();
                    return;
                }
                
                this.sendMessage({ type: 'useSkill', skillType: skillType, skillData: {} });
            }

            showModifySkillModal() {
                const modal = document.createElement('div');
                modal.className = 'game-modal';
                modal.innerHTML = '<div class="modal-content">' +
                    '<h2>数字修改技能</h2>' +
                    '<div class="modal-message">选择目标和操作：</div>' +
                    '<div class="skill-options">' +
                        '<button class="skill-option-btn" data-target="self" data-action="add">己方 +1</button>' +
                        '<button class="skill-option-btn" data-target="self" data-action="sub">己方 -1</button>' +
                        '<button class="skill-option-btn" data-target="opponent" data-action="add">对方 +1</button>' +
                        '<button class="skill-option-btn" data-target="opponent" data-action="sub">对方 -1</button>' +
                    '</div>' +
                    '<div class="modal-buttons">' +
                        '<button class="modal-btn" id="cancel-modify">取消</button>' +
                    '</div>' +
                '</div>';
                
                document.body.appendChild(modal);
                
                setTimeout(() => {
                    modal.classList.add('show');
                    
                    document.getElementById('cancel-modify').addEventListener('click', () => {
                        document.body.removeChild(modal);
                    });
                    
                    document.querySelectorAll('.skill-option-btn').forEach(btn => {
                        btn.addEventListener('click', () => {
                            const target = btn.dataset.target;
                            const action = btn.dataset.action;
                            
                            this.sendMessage({ 
                                type: 'useSkill', 
                                skillType: 'modify', 
                                skillData: { target: target, action: action }
                            });
                            
                            document.body.removeChild(modal);
                        });
                    });
                }, 10);
            }

            endTurn() {
                if (this.gameState.gameEnded || this.gameState.currentPlayer !== this.myPlayerId) return;
                
                this.sendMessage({ type: 'endTurn' });
            }

            showSurrenderConfirm() {
                if (this.gameState.gameEnded) return;
                
                const modal = document.createElement('div');
                modal.className = 'game-modal';
                modal.innerHTML = '<div class="modal-content">' +
                    '<h2>确认认输</h2>' +
                    '<div class="modal-message">你确定要认输吗？这将结束本局游戏。</div>' +
                    '<div class="modal-buttons">' +
                        '<button class="modal-btn" id="confirm-surrender" style="background: #f44336;">确认认输</button>' +
                        '<button class="modal-btn" id="cancel-surrender">取消</button>' +
                    '</div>' +
                '</div>';
                
                document.body.appendChild(modal);
                
                setTimeout(() => {
                    modal.classList.add('show');
                    
                    document.getElementById('cancel-surrender').addEventListener('click', () => {
                        document.body.removeChild(modal);
                    });
                    
                    document.getElementById('confirm-surrender').addEventListener('click', () => {
                        this.sendMessage({ type: 'surrender' });
                        document.body.removeChild(modal);
                    });
                }, 10);
            }

            cancelSkill() {
                this.sendMessage({ type: 'cancelSkill' });
            }

            // 移除原来的 handleGameEnd 函数，现在由服务器主动发送游戏结束消息

            handleDisconnect() {
                this.isConnected = false;
                this.showMessage('连接已断开', 'error');
            }

            showMessage(text, type = 'info') {
                const message = document.createElement('div');
                message.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:1001;padding:10px 20px;border-radius:5px;font-size:14px;font-weight:bold;';
                
                if (type === 'error') {
                    message.style.background = '#f44336';
                    message.style.color = 'white';
                } else if (type === 'success') {
                    message.style.background = '#4caf50';
                    message.style.color = 'white';
                } else {
                    message.style.background = '#2196f3';
                    message.style.color = 'white';
                }
                
                message.textContent = text;
                document.body.appendChild(message);
                
                setTimeout(() => {
                    if (message && document.body.contains(message)) {
                        document.body.removeChild(message);
                    }
                }, 2000);
            }

            async fetchRooms() {
                try {
                    const res = await fetch('/rooms');
                    const data = await res.json();
                    this.roomsInfo.innerHTML = data.map(r => {
                        const parts = [];
                        if (r.players['1']) parts.push('玩家1' + r.players['1']);
                        if (r.players['2']) parts.push('玩家2' + r.players['2']);
                        const names = parts.join(', ');
                        return '<div>' + r.id + ' (' + r.count + '/2): ' + names + '</div>';
                    }).join('');
                } catch (e) {}
            }
        }

        document.addEventListener('DOMContentLoaded', () => {
            new OnlineBattleGame();
        });
    </script>
</body>
</html>`;
}

setInterval(() => {
  const now = Date.now();
  
  rooms.forEach((room, roomId) => {
    if (now - room.created > ROOM_EXPIRE_TIME) {
      console.log('[Cleanup] 清理过期房间: ' + roomId);
      clearRoomTimer(room);
      room.players.forEach(player => {
        if (player.ws.readyState === WebSocket.OPEN) {
          player.ws.close(1000, "房间已过期");
        }
      });
      rooms.delete(roomId);
    }
  });
}, 10 * 60 * 1000);

console.log('🎮 点我加一在线对战服务器启动在端口 ' + PORT);
console.log('🔑 房间密码: ' + ROOM_PASSWORD);
console.log('✨ 技能系统已启用 - 包含8个完整技能');
console.log('⏱️  新增结束回合功能 - 玩家可以主动结束回合');
console.log('🏠 多房间模式 - 最多同时存在10个房间，每个房间最多2人');

await serve(handler, { port: PORT });
