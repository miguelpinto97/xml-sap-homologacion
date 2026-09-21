CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  source TEXT NOT NULL UNIQUE,
  generated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS sheets (
  id SERIAL PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sheet_order INTEGER NOT NULL,
  column_count INTEGER NOT NULL,
  UNIQUE (document_id, name)
);

CREATE TABLE IF NOT EXISTS sheet_rows (
  id SERIAL PRIMARY KEY,
  sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  cells JSONB NOT NULL,
  UNIQUE (sheet_id, row_number)
);

CREATE INDEX IF NOT EXISTS sheet_rows_sheet_id_idx ON sheet_rows(sheet_id);

CREATE TABLE IF NOT EXISTS field_entries (
  sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  company TEXT NOT NULL,
  value TEXT NOT NULL,
  validated BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sheet_id, row_number, company)
);

CREATE INDEX IF NOT EXISTS field_entries_lookup_idx
  ON field_entries(sheet_id, row_number);

CREATE TABLE IF NOT EXISTS field_scopes (
  sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  company TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('cabecera', 'detalle')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sheet_id, row_number, company)
);

CREATE INDEX IF NOT EXISTS field_scopes_lookup_idx
  ON field_scopes(sheet_id, row_number);

CREATE TABLE IF NOT EXISTS field_omits (
  sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  company TEXT NOT NULL,
  omitted BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sheet_id, row_number, company)
);

CREATE INDEX IF NOT EXISTS field_omits_lookup_idx
  ON field_omits(sheet_id, row_number);

CREATE TABLE IF NOT EXISTS custom_fields (
  id SERIAL PRIMARY KEY,
  sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  company TEXT NOT NULL,
  field_name TEXT NOT NULL,
  description TEXT NOT NULL,
  sap_field TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'cabecera',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS custom_fields_lookup_idx
  ON custom_fields(sheet_id, company);
