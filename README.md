# HSE Score Tracker

AI-powered extraction of HSE inspection scores from dashboard screenshots.  
Built with Next.js + Claude Vision + Supabase.

## Quick Start

### 1. Supabase Setup
1. Go to [supabase.com](https://supabase.com) → create a new project (or use existing)
2. Open **SQL Editor** → paste contents of `supabase-schema.sql` → Run
3. Go to **Settings > API** → copy your Project URL and `anon` public key

### 2. Local Development
```bash
git clone <your-repo>
cd hse-tracker
npm install
cp .env.local.example .env.local
# Edit .env.local with your keys
npm run dev
```
Open http://localhost:3000

### 3. Deploy to Vercel
1. Push to GitHub
2. Go to [vercel.com](https://vercel.com) → Import repository
3. Add Environment Variables:
   - `ANTHROPIC_API_KEY` = your Anthropic key
   - `NEXT_PUBLIC_SUPABASE_URL` = your Supabase project URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = your Supabase anon key
4. Deploy

## Usage
1. Upload dashboard screenshots (one per inspector per location per day)
2. Click "Extract Scores" — AI reads all 20 category scores
3. Review the color-coded table
4. Save to database and/or export to Excel

## Color Coding
- 🟢 Green = 100% (Full Compliant)
- 🟡 Amber = 90–99% (Partially Compliant)
- 🔴 Red = Below 90%
- 🔵 Blue highlight = Score changed from previous day
- 🟣 Purple highlight = Same non-100% score as previous day (suspicious)
