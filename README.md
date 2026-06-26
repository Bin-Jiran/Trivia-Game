# Arabic Multiplayer Trivia Game 🎮

A real-time multiplayer trivia game with Arabic questions, built on Node.js,
Express, and Socket.IO. Questions are generated on the fly by Claude
(Anthropic API), players join rooms with a 4-digit code, and scores are tracked
across three difficulty phases (easy → medium → hard) with a PostgreSQL-backed
leaderboard and player levels.

## Features

- Real-time gameplay over WebSockets (Socket.IO)
- AI-generated questions per category and difficulty (Claude)
- User registration / login with hashed passwords (bcrypt) and JWT auth
- Room-based multiplayer with host controls and "play again"
- Persistent total scores, game history, and animal-themed levels

## Tech stack

Node.js · Express · Socket.IO · PostgreSQL (`pg`) · JWT · bcryptjs · Anthropic API

## Prerequisites

- Node.js 18+ (uses the built-in `fetch`)
- A PostgreSQL database
- An Anthropic API key

## Run locally

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure environment variables**

   Copy the template and fill in your own values:

   ```bash
   cp .env.example .env
   ```

   | Variable            | Description                                        |
   | ------------------- | -------------------------------------------------- |
   | `DATABASE_URL`      | PostgreSQL connection string                       |
   | `ANTHROPIC_API_KEY` | API key for generating questions with Claude       |
   | `JWT_SECRET`        | Secret for signing auth tokens (long random value) |
   | `PORT`              | Port the server listens on (default `3000`)        |

   The required database tables (`users`, `game_history`) are created
   automatically on startup.

3. **Start the server**

   ```bash
   npm start
   ```

4. Open <http://localhost:3000> in your browser.

## Notes

`.env` and `node_modules/` are git-ignored — never commit your real secrets.
Use `.env.example` as the shared, secret-free template.
