Deploy
Deploy on Railway

Full deployment guide → docs/deployment.md

Quick Start
1. Clone
git clone https://github.com/dark-sarge/Airflex.git
cd Airflex
2. Set up the server
cd server
cp .env.example .env   # fill in your values
npm install
npm run dev
Server runs on http://localhost:3001.

curl http://localhost:3001/health
# → {"status":"ok","version":"1.0.0","timestamp":"..."}
3. Check the API
# List active trades
curl "http://localhost:3001/api/v1/trades?page=1&limit=10"
Full setup instructions → docs/getting-started.md

Environment Variables.
Minimum required variables to start the server:

DATABASE_URL=postgresql://user:password@localhost:5432/airflex
JWT_SECRET=a_long_random_string_at_least_32_characters
ESCROW_CONTRACT_ADDRESS=CCBJ235OCBFZXBFSUUUT4PMG7RRCAXZXMUEB2L7CTTQ5NRSNO4P2SLNP
Full reference → docs/environment.md

