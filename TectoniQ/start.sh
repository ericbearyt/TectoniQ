#!/bin/bash

# Exit script if any command fails
set -e

# Get workspace directory (directory of this script)
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

echo "🚀 Starting TectoniQ backend and frontend..."

# Ensure we clean up background processes on exit
cleanup() {
    echo "👋 Shutting down backend and frontend..."
    if [ ! -z "$BACKEND_PID" ]; then
        kill "$BACKEND_PID" 2>/dev/null || true
    fi
    if [ ! -z "$FRONTEND_PID" ]; then
        kill "$FRONTEND_PID" 2>/dev/null || true
    fi
    exit 0
}
trap cleanup SIGINT SIGTERM EXIT

# 1. Start Python Flask backend in the background
echo "🧠 Starting backend Flask server on http://localhost:5050..."
backend/.venv/bin/python backend/app.py > backend.log 2>&1 &
BACKEND_PID=$!

# Wait for backend to be ready
echo "Waiting for backend health check..."
for i in {1..10}; do
    if curl -s http://localhost:5050/api/health > /dev/null; then
        echo "✅ Backend is healthy!"
        break
    fi
    if [ $i -eq 10 ]; then
        echo "❌ Backend failed to start. Logs:"
        cat backend.log
        exit 1
    fi
    sleep 1
done

# 2. Start frontend static server on http://localhost:3050
echo "💻 Starting frontend server on http://localhost:3050..."
npx -y serve -l 3050 . > frontend.log 2>&1 &
FRONTEND_PID=$!

echo "✅ Both servers are running!"
echo "   - Frontend: http://localhost:3050"
echo "   - Backend:  http://localhost:5050"
echo ""
echo "Press Ctrl+C to stop both servers."

# Keep the script running to hold the background processes
while true; do
    sleep 1
done
