require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const { neon } = require('@neondatabase/serverless');

const port = Number(process.env.PORT || 8765);
const dataPath = path.join(__dirname, 'homologacion_campos_sap.json');
const webDir = path.join(__dirname, 'Web');
const companies = [
  'Antares Aduanas',
  'Antares Logistics',
  'Transmeridian / Mercator',
  'Contrans',
  'Transportes Meridian'
];

function getSql() {
  if (!process.env.DATABASE_URL) {
    throw new Error('Falta DATABASE_URL. Copia .env.example como .env y pega la cadena de Neon.');
  }
  return neon(process.env.DATABASE_URL);
}

const app = express();
app.use(express.json());

async function createSchema(sql) {
  await sql`CREATE TABLE IF NOT EXISTS documents (
    id SERIAL PRIMARY KEY,
    source TEXT NOT NULL UNIQUE,
    generated_at TIMESTAMPTZ NOT NULL
  )`;
  await sql`CREATE TABLE IF NOT EXISTS sheets (
    id SERIAL PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sheet_order INTEGER NOT NULL,
    column_count INTEGER NOT NULL,
    UNIQUE (document_id, name)
  )`;
  await sql`CREATE TABLE IF NOT EXISTS sheet_rows (
    id SERIAL PRIMARY KEY,
    sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    row_number INTEGER NOT NULL,
    cells JSONB NOT NULL,
    UNIQUE (sheet_id, row_number)
  )`;
  await sql`CREATE INDEX IF NOT EXISTS sheet_rows_sheet_id_idx ON sheet_rows(sheet_id)`;
  await sql`CREATE TABLE IF NOT EXISTS field_entries (
    sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    row_number INTEGER NOT NULL,
    company TEXT NOT NULL,
    value TEXT NOT NULL,
    validated BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (sheet_id, row_number, company)
  )`;
  await sql`CREATE INDEX IF NOT EXISTS field_entries_lookup_idx ON field_entries(sheet_id, row_number)`;
  await sql`CREATE TABLE IF NOT EXISTS field_scopes (
    sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    row_number INTEGER NOT NULL,
    company TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('cabecera', 'detalle')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (sheet_id, row_number, company)
  )`;
  await sql`CREATE INDEX IF NOT EXISTS field_scopes_lookup_idx ON field_scopes(sheet_id, row_number)`;
  await sql`CREATE TABLE IF NOT EXISTS field_omits (
    sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    row_number INTEGER NOT NULL,
    company TEXT NOT NULL,
    omitted BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (sheet_id, row_number, company)
  )`;
  await sql`CREATE INDEX IF NOT EXISTS field_omits_lookup_idx ON field_omits(sheet_id, row_number)`;
  await sql`CREATE TABLE IF NOT EXISTS custom_fields (
    id SERIAL PRIMARY KEY,
    sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    company TEXT NOT NULL,
    field_name TEXT NOT NULL,
    description TEXT NOT NULL,
    sap_field TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`ALTER TABLE custom_fields ADD COLUMN IF NOT EXISTS sap_field TEXT NOT NULL DEFAULT ''`;
  await sql`ALTER TABLE custom_fields ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'cabecera'`;
  await sql`CREATE INDEX IF NOT EXISTS custom_fields_lookup_idx ON custom_fields(sheet_id, company)`;
}

async function seedSheets(sql, data, documentId, existingNames = new Set()) {
  for (let sheetOrder = 0; sheetOrder < data.sheets.length; sheetOrder += 1) {
    const sheet = data.sheets[sheetOrder];
    if (existingNames.has(sheet.name)) continue;
    const sheetRows = await sql`
      INSERT INTO sheets (document_id, name, sheet_order, column_count)
      VALUES (${documentId}, ${sheet.name}, ${sheetOrder}, ${sheet.columnCount})
      RETURNING id
    `;
    const sheetId = sheetRows[0].id;
    await sql`
      INSERT INTO sheet_rows (sheet_id, row_number, cells)
      SELECT ${sheetId}, item.row, item.cells
      FROM jsonb_to_recordset(${JSON.stringify(sheet.rows)}::jsonb)
        AS item(row INTEGER, cells JSONB)
    `;
  }
}

async function seedDatabase(sql) {
  const source = 'Homologacion_Campos_XML_SAP.xlsx';
  let data;
  try {
    data = JSON.parse(await fs.readFile(dataPath, 'utf8'));
  } catch (error) {
    // En Netlify/Lambda el JSON semilla puede no estar incluido en el bundle.
    // Si la BD ya fue sembrada antes, no es un error fatal.
    console.warn('Semilla JSON no disponible, se omite seed:', error.message);
    return;
  }
  const existing = await sql`SELECT id FROM documents WHERE source = ${source}`;
  if (existing.length) {
    const sheetRows = await sql`SELECT name FROM sheets WHERE document_id = ${existing[0].id}`;
    await seedSheets(sql, data, existing[0].id, new Set(sheetRows.map(sheet => sheet.name)));
    return;
  }

  const documentRows = await sql`
    INSERT INTO documents (source, generated_at)
    VALUES (${source}, ${data.generatedAt})
    RETURNING id
  `;
  await seedSheets(sql, data, documentRows[0].id);
  console.log(`Datos iniciales cargados en Neon: ${data.sheetCount} hojas.`);
}

async function getSheets(sql) {
  const documentRows = await sql`
    SELECT id, source, generated_at AS "generatedAt"
    FROM documents
    WHERE source = 'Homologacion_Campos_XML_SAP.xlsx'
  `;
  if (!documentRows.length) return null;

  const document = documentRows[0];
  const sheetRows = await sql`
    SELECT id, name, sheet_order AS "sheetOrder", column_count AS "columnCount"
    FROM sheets
    WHERE document_id = ${document.id}
    ORDER BY sheet_order
  `;
  const rows = await sql`
    SELECT sheet_id AS "sheetId", row_number AS row, cells
    FROM sheet_rows
    WHERE sheet_id IN (SELECT id FROM sheets WHERE document_id = ${document.id})
    ORDER BY sheet_id, row_number
  `;

  return {
    source: document.source,
    generatedAt: document.generatedAt,
    sheetCount: sheetRows.length,
    sheets: sheetRows.map(sheet => ({
      name: sheet.name,
      columnCount: sheet.columnCount,
      rows: rows.filter(row => row.sheetId === sheet.id).map(row => ({ row: row.row, cells: row.cells }))
    }))
  };
}

app.get('/api/sheets', async (_request, response) => {
  try {
    const data = await getSheets(getSql());
    response.json(data || { source: null, generatedAt: null, sheetCount: 0, sheets: [] });
  } catch (error) {
    console.error('Error consultando Neon:', error);
    response.status(500).json({ error: 'No se pudieron consultar los datos.' });
  }
});

app.get('/api/field-values', async (request, response) => {
  const company = String(request.query.company || '');
  if (!companies.includes(company)) {
    response.status(400).json({ error: 'Empresa no valida.', companies });
    return;
  }
  try {
    const sql = getSql();
    const rows = await sql`
      SELECT s.name AS "sheetName", entry.row_number AS row, entry.company,
        entry.value, entry.validated
      FROM field_entries entry
      JOIN sheets s ON s.id = entry.sheet_id
      ORDER BY s.sheet_order, entry.row_number, entry.company
    `;
    const entries = new Map();
    rows.forEach(row => {
      const key = `${row.sheetName}:${row.row}`;
      if (!entries.has(key)) entries.set(key, { sheet: row.sheetName, row: row.row, own: null, others: [] });
      const item = entries.get(key);
      const value = { company: row.company, value: row.value, validated: row.validated };
      if (row.company === company) item.own = value;
      else item.others.push(value);
    });
    response.json({ companies, entries: [...entries.values()] });
  } catch (error) {
    console.error('Error consultando valores Campo SAP:', error);
    response.status(500).json({ error: 'No se pudieron consultar los valores.' });
  }
});

app.post('/api/field-values', async (request, response) => {
  const { company, sheetName, row, value, validated = false } = request.body || {};
  if (!companies.includes(company) || !sheetName || !Number.isInteger(row)) {
    response.status(400).json({ error: 'Empresa, hoja o fila no validas.' });
    return;
  }
  try {
    const sql = getSql();
    const sheetRows = await sql`
      SELECT s.id
      FROM sheets s
      JOIN documents d ON d.id = s.document_id
      WHERE d.source = 'Homologacion_Campos_XML_SAP.xlsx' AND s.name = ${sheetName}
    `;
    if (!sheetRows.length) {
      response.status(404).json({ error: 'Hoja no encontrada.' });
      return;
    }
    const cleanValue = String(value || '').trim();
    if (!cleanValue) {
      await sql`DELETE FROM field_entries WHERE sheet_id = ${sheetRows[0].id} AND row_number = ${row} AND company = ${company}`;
      response.json({ saved: true, deleted: true });
      return;
    }
    await sql`
      INSERT INTO field_entries (sheet_id, row_number, company, value, validated)
      VALUES (${sheetRows[0].id}, ${row}, ${company}, ${cleanValue}, ${Boolean(validated)})
      ON CONFLICT (sheet_id, row_number, company)
      DO UPDATE SET value = EXCLUDED.value, validated = EXCLUDED.validated, updated_at = NOW()
    `;
    response.json({ saved: true });
  } catch (error) {
    console.error('Error guardando valor Campo SAP:', error);
    response.status(500).json({ error: 'No se pudo guardar el valor.' });
  }
});

app.get('/api/field-scopes', async (request, response) => {
  const company = String(request.query.company || '');
  if (!companies.includes(company)) {
    response.status(400).json({ error: 'Empresa no valida.', companies });
    return;
  }
  try {
    const sql = getSql();
    const rows = await sql`
      SELECT s.name AS "sheetName", scope.row_number AS row, scope.company, scope.scope
      FROM field_scopes scope
      JOIN sheets s ON s.id = scope.sheet_id
      ORDER BY s.sheet_order, scope.row_number, scope.company
    `;
    const entries = new Map();
    rows.forEach(row => {
      const key = `${row.sheetName}:${row.row}`;
      if (!entries.has(key)) entries.set(key, { sheet: row.sheetName, row: row.row, own: null, others: [] });
      const item = entries.get(key);
      const value = { company: row.company, scope: row.scope };
      if (row.company === company) item.own = value;
      else item.others.push(value);
    });
    response.json({ companies, entries: [...entries.values()] });
  } catch (error) {
    console.error('Error consultando ambitos Cabecera/Detalle:', error);
    response.status(500).json({ error: 'No se pudieron consultar los ambitos.' });
  }
});

app.post('/api/field-scopes', async (request, response) => {
  const { company, sheetName, row, scope } = request.body || {};
  if (!companies.includes(company) || !sheetName || !Number.isInteger(row)) {
    response.status(400).json({ error: 'Empresa, hoja o fila no validas.' });
    return;
  }
  const cleanScope = String(scope || '').trim().toLowerCase();
  try {
    const sql = getSql();
    const sheetRows = await sql`
      SELECT s.id
      FROM sheets s
      JOIN documents d ON d.id = s.document_id
      WHERE d.source = 'Homologacion_Campos_XML_SAP.xlsx' AND s.name = ${sheetName}
    `;
    if (!sheetRows.length) {
      response.status(404).json({ error: 'Hoja no encontrada.' });
      return;
    }
    if (!cleanScope) {
      await sql`DELETE FROM field_scopes WHERE sheet_id = ${sheetRows[0].id} AND row_number = ${row} AND company = ${company}`;
      response.json({ saved: true, deleted: true });
      return;
    }
    if (!['cabecera', 'detalle'].includes(cleanScope)) {
      response.status(400).json({ error: 'Ambito no valido (cabecera o detalle).' });
      return;
    }
    await sql`
      INSERT INTO field_scopes (sheet_id, row_number, company, scope)
      VALUES (${sheetRows[0].id}, ${row}, ${company}, ${cleanScope})
      ON CONFLICT (sheet_id, row_number, company)
      DO UPDATE SET scope = EXCLUDED.scope, updated_at = NOW()
    `;
    response.json({ saved: true });
  } catch (error) {
    console.error('Error guardando ambito Cabecera/Detalle:', error);
    response.status(500).json({ error: 'No se pudo guardar el ambito.' });
  }
});

app.get('/api/field-omits', async (request, response) => {
  const company = String(request.query.company || '');
  if (!companies.includes(company)) {
    response.status(400).json({ error: 'Empresa no valida.', companies });
    return;
  }
  try {
    const sql = getSql();
    const rows = await sql`
      SELECT s.name AS "sheetName", omit.row_number AS row, omit.company, omit.omitted
      FROM field_omits omit
      JOIN sheets s ON s.id = omit.sheet_id
      WHERE omit.omitted = TRUE
      ORDER BY s.sheet_order, omit.row_number, omit.company
    `;
    const entries = new Map();
    rows.forEach(row => {
      const key = `${row.sheetName}:${row.row}`;
      if (!entries.has(key)) entries.set(key, { sheet: row.sheetName, row: row.row, own: null, others: [] });
      const item = entries.get(key);
      const value = { company: row.company, omitted: row.omitted };
      if (row.company === company) item.own = value;
      else item.others.push(value);
    });
    response.json({ companies, entries: [...entries.values()] });
  } catch (error) {
    console.error('Error consultando omitidos:', error);
    response.status(500).json({ error: 'No se pudieron consultar los omitidos.' });
  }
});

app.post('/api/field-omits', async (request, response) => {
  const { company, sheetName, row, omitted = false } = request.body || {};
  if (!companies.includes(company) || !sheetName || !Number.isInteger(row)) {
    response.status(400).json({ error: 'Empresa, hoja o fila no validas.' });
    return;
  }
  try {
    const sql = getSql();
    const sheetRows = await sql`
      SELECT s.id
      FROM sheets s
      JOIN documents d ON d.id = s.document_id
      WHERE d.source = 'Homologacion_Campos_XML_SAP.xlsx' AND s.name = ${sheetName}
    `;
    if (!sheetRows.length) {
      response.status(404).json({ error: 'Hoja no encontrada.' });
      return;
    }
    if (!omitted) {
      await sql`DELETE FROM field_omits WHERE sheet_id = ${sheetRows[0].id} AND row_number = ${row} AND company = ${company}`;
      response.json({ saved: true, deleted: true });
      return;
    }
    await sql`
      INSERT INTO field_omits (sheet_id, row_number, company, omitted)
      VALUES (${sheetRows[0].id}, ${row}, ${company}, TRUE)
      ON CONFLICT (sheet_id, row_number, company)
      DO UPDATE SET omitted = TRUE, updated_at = NOW()
    `;
    response.json({ saved: true });
  } catch (error) {
    console.error('Error guardando omitido:', error);
    response.status(500).json({ error: 'No se pudo guardar el omitido.' });
  }
});

app.get('/api/custom-fields', async (request, response) => {
  const company = String(request.query.company || '');
  if (!companies.includes(company)) {
    response.status(400).json({ error: 'Empresa no valida.' });
    return;
  }
  try {
    const sql = getSql();
    const rows = await sql`
      SELECT s.name AS "sheetName", f.id, field_name AS "fieldName", description, sap_field AS "sapField",
        COALESCE(scope, 'cabecera') AS scope
      FROM custom_fields f
      JOIN sheets s ON s.id = f.sheet_id
      WHERE f.company = ${company}
      ORDER BY f.created_at, f.id
    `;
    response.json(rows);
  } catch (error) {
    console.error('Error consultando campos nuevos:', error);
    response.status(500).json({ error: 'No se pudieron consultar los campos nuevos.' });
  }
});

app.get('/api/custom-fields/all', async (_request, response) => {
  try {
    const sql = getSql();
    const rows = await sql`
      SELECT s.name AS "sheetName", f.id, f.company, field_name AS "fieldName",
        description, sap_field AS "sapField", COALESCE(scope, 'cabecera') AS scope
      FROM custom_fields f
      JOIN sheets s ON s.id = f.sheet_id
      ORDER BY s.sheet_order, f.created_at, f.id
    `;
    response.json(rows);
  } catch (error) {
    console.error('Error consultando todos los campos nuevos:', error);
    response.status(500).json({ error: 'No se pudieron consultar los campos nuevos.' });
  }
});

app.post('/api/custom-fields', async (request, response) => {
  const { company, sheetName, fieldName, description, sapField, scope } = request.body || {};
  const cleanScope = String(scope || '').trim().toLowerCase();
  if (!companies.includes(company) || !sheetName || !String(fieldName || '').trim() || !String(description || '').trim() || !String(sapField || '').trim()) {
    response.status(400).json({ error: 'Empresa, hoja, campo, descripcion y Campo SAP son obligatorios.' });
    return;
  }
  if (!['cabecera', 'detalle'].includes(cleanScope)) {
    response.status(400).json({ error: 'Ambito no valido (cabecera o detalle).' });
    return;
  }
  try {
    const sql = getSql();
    const sheetRows = await sql`
      SELECT s.id
      FROM sheets s
      JOIN documents d ON d.id = s.document_id
      WHERE d.source = 'Homologacion_Campos_XML_SAP.xlsx' AND s.name = ${sheetName}
    `;
    if (!sheetRows.length) {
      response.status(404).json({ error: 'Hoja no encontrada.' });
      return;
    }
    const inserted = await sql`
      INSERT INTO custom_fields (sheet_id, company, field_name, description, sap_field, scope)
      VALUES (${sheetRows[0].id}, ${company}, ${String(fieldName).trim()}, ${String(description).trim()}, ${String(sapField).trim()}, ${cleanScope})
      RETURNING id, field_name AS "fieldName", description, sap_field AS "sapField", scope
    `;
    response.status(201).json(inserted[0]);
  } catch (error) {
    console.error('Error guardando campo nuevo:', error);
    response.status(500).json({ error: 'No se pudo guardar el campo nuevo.' });
  }
});

app.delete('/api/custom-fields/:id', async (request, response) => {
  const company = String(request.query.company || '');
  const id = Number(request.params.id);
  if (!companies.includes(company) || !Number.isInteger(id)) {
    response.status(400).json({ error: 'Empresa o campo no valido.' });
    return;
  }
  try {
    const sql = getSql();
    const deleted = await sql`
      DELETE FROM custom_fields
      WHERE id = ${id} AND company = ${company}
      RETURNING id
    `;
    if (!deleted.length) {
      response.status(404).json({ error: 'El campo no existe o no pertenece a esta empresa.' });
      return;
    }
    response.json({ deleted: true, id });
  } catch (error) {
    console.error('Error eliminando campo nuevo:', error);
    response.status(500).json({ error: 'No se pudo eliminar el campo nuevo.' });
  }
});

// Frontend estatico (carpeta Web). En Netlify el publish es Web/, en local Express lo sirve.
app.use(express.static(webDir));
app.get(/^\/(?!api\/).*/, (_request, response) => {
  response.sendFile(path.join(webDir, 'index.html'));
});

let initPromise = null;
async function initializeDatabase() {
  if (!initPromise) {
    initPromise = (async () => {
      const sql = getSql();
      await createSchema(sql);
      await seedDatabase(sql);
    })().catch(error => {
      initPromise = null;
      throw error;
    });
  }
  return initPromise;
}

async function start() {
  await initializeDatabase();
  app.listen(port, () => console.log(`Aplicacion disponible en http://localhost:${port}`));
}

module.exports = { app, initializeDatabase, start, companies };

// Solo escucha automaticamente al ejecutar `node server.js` directamente.
// Al ser requerido desde Netlify Functions, no arranca el servidor.
if (require.main === module) {
  start().catch(error => {
    console.error('No se pudo iniciar la aplicacion:', error.message);
    process.exit(1);
  });
}
