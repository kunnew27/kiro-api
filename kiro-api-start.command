#!/bin/bash
# Kiro API Startup Script for macOS/Linux

cd "$(dirname "$0")"

echo "Starting Kiro API..."
echo ""

# Check if bun is installed
if ! command -v bun &> /dev/null; then
    echo "Error: Bun is not installed."
    echo "Please install Bun first: https://bun.sh"
    echo ""
    read -p "Press Enter to exit..."
    exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    bun install
    echo ""
fi

# Start the server
bun run start

# Keep terminal open on error
read -p "Press Enter to exit..."

