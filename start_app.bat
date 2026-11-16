@echo off
echo ============================================================================
echo   Tracker Connect - Roadside Assistance ^& Fleet CAD Command Platform
echo   Starting Command Server on http://localhost:5050 ...
echo ============================================================================
set PATH=C:\Program Files\dotnet;C:\Program Files\nodejs;%PATH%
cd /d "%~dp0backend"
start "" "http://localhost:5050"
dotnet run --urls "http://localhost:5050"
