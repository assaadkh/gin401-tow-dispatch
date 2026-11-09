@echo off
echo ============================================================================
echo   GIN401 Lab Project - Roadside Assistance ^& Towing CAD Dispatch System
echo   Starting Standalone C# ADO.NET Backend + Built React.js Frontend...
echo ============================================================================
set PATH=C:\Program Files\dotnet;C:\Program Files\nodejs;%PATH%
cd /d "%~dp0backend"
start "" "http://localhost:5050"
dotnet run --urls "http://localhost:5050"
