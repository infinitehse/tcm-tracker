-- ============================================
-- HSE Score Tracker — Supabase Schema
-- Run this in: Supabase Dashboard > SQL Editor
-- ============================================

CREATE TABLE IF NOT EXISTS inspection_scores (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  inspector_email   TEXT NOT NULL,
  inspector_name    TEXT NOT NULL,
  date              DATE NOT NULL,
  package           TEXT NOT NULL,
  overall_compliance INTEGER,

  -- 20 HSE Categories
  permits_to_work           INTEGER,
  ppe                       INTEGER,
  housekeeping              INTEGER,
  environmental_compliance  INTEGER,
  facilities_inspection     INTEGER,
  cranes_and_lifting        INTEGER,
  general_site_safety       INTEGER,
  site_supervision          INTEGER,
  laydown_safety            INTEGER,
  chemical_handling         INTEGER,
  excavations               INTEGER,
  fire_prevention           INTEGER,
  traffic_safety            INTEGER,
  marine                    INTEGER,
  confined_spaces           INTEGER,
  fall_protection           INTEGER,
  hand_power_tools          INTEGER,
  scaffolds_ladders         INTEGER,
  vehicles_mobile_heavy     INTEGER,
  electrical_compliance     INTEGER,

  created_at  TIMESTAMPTZ DEFAULT now(),

  -- Prevent duplicate entries for same inspector/date/package
  UNIQUE(inspector_email, date, package)
);

-- Enable Row Level Security
ALTER TABLE inspection_scores ENABLE ROW LEVEL SECURITY;

-- Allow read/write access with anon key (adjust for production)
CREATE POLICY "Allow all operations"
  ON inspection_scores
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Index for fast queries by date and inspector
CREATE INDEX idx_scores_date ON inspection_scores (date DESC);
CREATE INDEX idx_scores_inspector ON inspection_scores (inspector_name, package, date DESC);
