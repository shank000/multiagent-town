@echo off
chcp 65001 >nul
title multiagent-town M0 试玩
echo ================================================
echo  multiagent-town M0 试玩  ^(4 agent: 林晚晴/陈默/沈屿/周岚^)
echo ================================================
echo.
echo [1/3] 快速跑 1 游戏日 ^(虚拟时钟 3600x, 约 2 秒^)
wsl bash -c "export PATH=/home/administrator/.local/bin:$PATH && cd /mnt/d/workspace/dsh/multiagent-town && pnpm town --until-minutes 1440 --speed 60"
echo.
echo [2/3] 回放第 1 天事件时间线 ^(前 40 条^)
wsl bash -c "export PATH=/home/administrator/.local/bin:$PATH && cd /mnt/d/workspace/dsh/multiagent-town && pnpm replay --day 1 | head -40"
echo.
echo [3/3] 实时观察台 ^(60x, 观察中... 按 Ctrl+C 停止^)
wsl bash -c "export PATH=/home/administrator/.local/bin:$PATH && cd /mnt/d/workspace/dsh/multiagent-town && pnpm town"
echo.
pause
