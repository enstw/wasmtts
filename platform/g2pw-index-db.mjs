// g2pW 全文 index 共用 schema 與分類；fixture slice 與後續全文 feeder 共用。

export function differenceCategory(character, matcha, g2pw) {
  if (!matcha) return 'unalignable';
  if (matcha === g2pw) return 'agreement';
  const parts = (phone) => phone.match(/^(.+?)([1-5])$/u)?.slice(1) ?? [phone, null];
  const [matchaBase, matchaTone] = parts(matcha);
  const [g2pwBase, g2pwTone] = parts(g2pw);
  if (matchaBase !== g2pwBase) return 'polyphone';
  if (character === '一' || character === '不') return 'tone_sandhi';
  if (matchaTone === '5' || g2pwTone === '5') return 'neutral_tone';
  return 'tone_disagreement';
}

export function initializeG2pwIndex(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('building', 'complete', 'failed')),
      source_sha256 TEXT NOT NULL,
      model_sha256 TEXT NOT NULL,
      lexicon_sha256 TEXT NOT NULL,
      fst_sha256 TEXT NOT NULL,
      profile_sha256 TEXT NOT NULL,
      backend TEXT NOT NULL,
      runtime TEXT NOT NULL,
      last_sentence_id INTEGER NOT NULL DEFAULT -1
    );
    CREATE TABLE IF NOT EXISTS sentences (
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      source_sentence_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      source_text TEXT,
      PRIMARY KEY (run_id, source_sentence_id)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS occurrences (
      run_id INTEGER NOT NULL,
      source_sentence_id INTEGER NOT NULL,
      character_offset INTEGER NOT NULL,
      character TEXT NOT NULL,
      previous_character TEXT NOT NULL,
      following_character TEXT NOT NULL,
      matcha_phone TEXT,
      g2pw_phone TEXT NOT NULL,
      confidence REAL NOT NULL,
      category TEXT NOT NULL,
      PRIMARY KEY (run_id, source_sentence_id, character_offset),
      FOREIGN KEY (run_id, source_sentence_id)
        REFERENCES sentences(run_id, source_sentence_id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS occurrence_difference_roi
      ON occurrences(run_id, character, category, previous_character, following_character);
    CREATE TABLE IF NOT EXISTS review_decisions (
      id INTEGER PRIMARY KEY,
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      character TEXT NOT NULL,
      matcha_phone TEXT NOT NULL,
      g2pw_phone TEXT NOT NULL,
      category TEXT NOT NULL,
      scope_type TEXT NOT NULL CHECK (scope_type IN ('group', 'phrase')),
      scope_value TEXT NOT NULL DEFAULT '',
      scope_offset INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN (
        'needs_context', 'accepted', 'implemented', 'rejected_current_correct',
        'rejected_model_error', 'rejected_regional_difference', 'deferred', 'superseded'
      )),
      rationale TEXT NOT NULL DEFAULT '',
      source_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(run_id, character, matcha_phone, g2pw_phone, category,
        scope_type, scope_value, scope_offset)
    );
    CREATE INDEX IF NOT EXISTS review_decision_lookup
      ON review_decisions(run_id, character, matcha_phone, g2pw_phone, category, status);
  `);
  // 既有 architecture-slice database 可直接升級，不必刪除本機稽核結果。
  const runColumns = new Set(db.prepare("SELECT name FROM pragma_table_info('runs')").all()
    .map(({name}) => name));
  if (!runColumns.has('last_sentence_id')) {
    db.exec('ALTER TABLE runs ADD COLUMN last_sentence_id INTEGER NOT NULL DEFAULT -1');
  }
  const sentenceColumns = new Set(db.prepare("SELECT name FROM pragma_table_info('sentences')").all()
    .map(({name}) => name));
  if (!sentenceColumns.has('source_text')) db.exec('ALTER TABLE sentences ADD COLUMN source_text TEXT');
}
