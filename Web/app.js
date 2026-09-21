const state = { data: null, activeSheet: 0, query: '', company: '', fieldValues: new Map(), customFields: [], allCustomFields: [], scopes: new Map(), omits: new Map() };
const tabs = document.querySelector('#tabs');
const tableView = document.querySelector('#table-view');
const search = document.querySelector('#search');
const clearSearch = document.querySelector('#clear-search');
const resultCount = document.querySelector('#result-count');
const emptyState = document.querySelector('#empty-state');
const summary = document.querySelector('#summary');
const companyGate = document.querySelector('#company-gate');
const companyOptions = document.querySelector('#company-options');
const floatingFieldButton = document.querySelector('#open-field-panel');
const floatingFieldPanel = document.querySelector('#floating-field-panel');
const closeFieldPanel = document.querySelector('#close-field-panel');
const floatingFieldForm = document.querySelector('#floating-field-form');
const newFieldScopeButton = document.querySelector('#new-field-scope');
const toast = document.querySelector('#toast');
let toastTimer = null;

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 5000);
}

function focusCustomRow(key) {
  const row = tableView.querySelector(`[data-custom-key="${CSS.escape(key)}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 2600);
}
const companies = ['Antares Aduanas', 'Antares Logistics', 'Transmeridian / Mercator', 'Contrans', 'Transportes Meridian'];
const exclusiveCompanyByCode = {
  TMR: 'Transmeridian / Mercator',
  AL: 'Antares Logistics',
  TM: 'Transportes Meridian',
  CTR: 'Contrans'
};

function text(value) {
  return value == null ? '' : String(value);
}

function isHiddenSheet(sheet) {
  return /^(OV_CAB|OV_DET|SN_)/i.test(sheet.name) || sheet.name === 'Hoja5';
}

function isAntaresOnlySheet(sheet) {
  return sheet.name.startsWith('Antares Aduanas - ');
}

function isVisibleSheet(sheet) {
  if (state.company === 'Antares Aduanas') return isAntaresOnlySheet(sheet);
  return !isHiddenSheet(sheet) && !isAntaresOnlySheet(sheet);
}

function isCommonBlock(block) {
  return /Campos Comunes \(Con datos en todas las empresas\)/i.test(block.subtitle);
}

function isAntaresDirectoryBlock(sheet) {
  return sheet.name === 'Antares Aduanas - Clientes y Proveedores';
}

function isVisibleBlock(block) {
  const match = block.subtitle.match(/Campos Exclusivos de\s+([A-Z]+)\s+\(Con Datos\)/i);
  if (!match) return true;
  return exclusiveCompanyByCode[match[1].toUpperCase()] === state.company;
}

function isExclusiveBlock(block) {
  return /Campos Exclusivos de\s+[A-Z]+\s+\(Con Datos\)/i.test(block.subtitle);
}

function companyCode() {
  return Object.entries({
    TMR: 'Transmeridian / Mercator',
    AL: 'Antares Logistics',
    CTR: 'Contrans',
    TM: 'Transportes Meridian'
  }).find(([, company]) => company === state.company)?.[0] || '';
}

function isPresenceBlock(block) {
  return /Campos Parcialmente Compartidos \(Con Datos en algunas empresas\)|Campos Vacios \(Sin datos en todas las empresas donde estan presentes\)/i.test(block.subtitle);
}

function presenceColumns(block) {
  if (!block.header) return [];
  return block.header.cells.map((value, index) => {
    const match = text(value).match(/(?:Tiene|Presente).*\b(TMR|AL|CTR|TM)\s*\?/i);
    return match ? { index, code: match[1].toUpperCase() } : null;
  }).filter(Boolean);
}

function filterPresenceRows(block) {
  if (!isPresenceBlock(block) || !block.header) return block;
  const code = companyCode();
  if (!code) return { ...block, rows: [] };
  const presenceIndex = presenceColumns(block).find(column => column.code === code)?.index;
  if (presenceIndex === undefined) return { ...block, rows: [] };
  return {
    ...block,
    rows: block.rows.filter(row => /^(si|sí|presente|yes|y)$/i.test(text(row.cells[presenceIndex]).trim()))
  };
}

function presenceSummary(block, row) {
  return presenceColumns(block)
    .filter(column => /^(si|sí|presente|yes|y)$/i.test(text(row.cells[column.index]).trim()))
    .map(column => column.code)
    .join(', ');
}

function exclusiveSubtitle() {
  const code = companyCode();
  return code ? `Campos Exclusivos de ${code} (Con Datos)` : '';
}

function addGeneratedExclusiveBlock(sheet, blocks) {
  const subtitle = exclusiveSubtitle();
  const code = companyCode();
  const existingExclusive = blocks.some(block => {
    const match = block.subtitle.match(/Campos Exclusivos de\s+([A-Z]+)\s+\(Con Datos\)/i);
    return match && match[1].toUpperCase() === code;
  });
  if (!subtitle || existingExclusive) return blocks;
  return [...blocks, {
    subtitle,
    generatedExclusive: true,
    header: { row: 0, cells: ['Campo / Tag XML', 'Descripcion'] },
    rows: []
  }];
}

function fieldKey(sheet, row) {
  return `${sheet}:${row}`;
}

function entryFor(sheet, row) {
  return state.fieldValues.get(fieldKey(sheet, row)) || { own: null, others: [] };
}

async function loadFieldValues() {
  const response = await fetch(`/api/field-values?company=${encodeURIComponent(state.company)}`);
  if (!response.ok) throw new Error('No se pudieron cargar los valores Campo SAP.');
  const data = await response.json();
  state.fieldValues = new Map(data.entries.map(entry => [fieldKey(entry.sheet, entry.row), entry]));
}

async function loadCustomFields() {
  const response = await fetch(`/api/custom-fields?company=${encodeURIComponent(state.company)}`);
  if (!response.ok) throw new Error('No se pudieron cargar los campos nuevos.');
  state.customFields = await response.json();
}

async function loadCustomFieldsAll() {
  const response = await fetch('/api/custom-fields/all');
  if (!response.ok) throw new Error('No se pudieron cargar los campos de otras empresas.');
  state.allCustomFields = await response.json();
}

async function reloadCustomFields() {
  await loadCustomFields();
  await loadCustomFieldsAll();
}

function customFieldKey(name) {
  return String(name || '').trim().toLowerCase();
}

// Agrupa los campos nuevos de la hoja por nombre: propios, de otras empresas y
// compartidos (mismo nombre en 2+ empresas -> se muestran en Parcialmente Compartidos).
function sheetCustomGroups(sheetName) {
  const mine = state.customFields.filter(field => field.sheetName === sheetName);
  const others = (state.allCustomFields || []).filter(field => field.sheetName === sheetName && field.company !== state.company);
  const byKey = new Map();
  [...mine, ...others].forEach(field => {
    const key = customFieldKey(field.fieldName);
    if (!byKey.has(key)) byKey.set(key, { key, sample: field, companies: new Set(), mine: null, others: [] });
    const group = byKey.get(key);
    group.companies.add(field.company);
    if (field.company === state.company) group.mine = field;
    else group.others.push(field);
  });
  const shared = new Set();
  byKey.forEach((group, key) => { if (group.companies.size >= 2) shared.add(key); });
  return { mine, others, byKey, shared };
}

async function reuseCustomField(field, button) {
  button.disabled = true;
  try {
    if (hasCustomField(field.sheetName, field.fieldName)) throw new Error('Ya lo tienes en tu lista.');
    const response = await fetch('/api/custom-fields', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        company: state.company,
        sheetName: field.sheetName,
        fieldName: field.fieldName,
        description: field.description,
        sapField: field.sapField,
        scope: field.scope
      })
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || 'No se pudo reutilizar.');
    }
    await reloadCustomFields();
    const reusedKey = customFieldKey(field.fieldName);
    const reusedGroups = sheetCustomGroups(field.sheetName);
    renderTable();
    if (reusedGroups.shared.has(reusedKey)) {
      showToast(`"${field.fieldName}" reutilizado: se movio a Parcialmente Compartidos.`);
    } else {
      showToast(`"${field.fieldName}" agregado a tu lista.`);
    }
    focusCustomRow(reusedKey);
  } catch (error) {
    button.disabled = false;
    button.textContent = error.message;
  }
}

function reuseButton(field) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'reuse-button';
  button.textContent = 'Reutilizar';
  button.title = `Agregar "${field.fieldName}" a la lista de ${state.company}`;
  button.addEventListener('click', () => reuseCustomField(field, button));
  return button;
}

function buildOtherFieldRow(field) {
  const tr = document.createElement('tr');
  tr.className = 'custom-field-row other-field-row';
  tr.dataset.customKey = customFieldKey(field.fieldName);
  const rowNumber = document.createElement('td');
  rowNumber.className = 'row-number';
  rowNumber.textContent = 'Nuevo';
  tr.append(rowNumber);
  const nameCell = document.createElement('td');
  nameCell.textContent = field.fieldName;
  tr.append(nameCell);
  const descriptionCell = document.createElement('td');
  descriptionCell.textContent = field.description;
  tr.append(descriptionCell);
  const sapCell = document.createElement('td');
  sapCell.className = 'custom-sap-cell';
  sapCell.textContent = field.sapField || 'Pendiente';
  tr.append(sapCell);
  const scopeCell = document.createElement('td');
  scopeCell.className = `custom-scope-cell${field.scope === 'detalle' ? ' is-detalle' : ''}`;
  scopeCell.textContent = scopeLabel(field.scope === 'detalle' ? 'detalle' : 'cabecera');
  tr.append(scopeCell);
  const companyCell = document.createElement('td');
  companyCell.className = 'custom-company-cell';
  companyCell.textContent = field.company;
  tr.append(companyCell);
  const actionCell = document.createElement('td');
  actionCell.className = 'custom-action-cell';
  if (hasCustomField(field.sheetName, field.fieldName)) {
    const done = document.createElement('span');
    done.className = 'already-mine';
    done.textContent = 'En tu lista';
    actionCell.append(done);
  } else {
    actionCell.append(reuseButton(field));
  }
  tr.append(actionCell);
  return tr;
}

function buildSharedFieldRow(group, inExcelBlock = false) {
  const source = group.mine || group.sample;
  const tr = document.createElement('tr');
  tr.className = 'custom-field-row shared-field-row';
  tr.dataset.customKey = group.key;
  const rowNumber = document.createElement('td');
  rowNumber.className = 'row-number';
  rowNumber.textContent = `x${group.companies.size}`;
  tr.append(rowNumber);
  const nameCell = document.createElement('td');
  nameCell.textContent = group.sample.fieldName;
  tr.append(nameCell);
  const descriptionCell = document.createElement('td');
  descriptionCell.textContent = group.sample.description;
  tr.append(descriptionCell);
  // En bloques del Excel la tabla trae columnas Presente en / Campo SAP / Omitir:
  // se rellenan para que Ambito y Empresas queden alineados.
  if (inExcelBlock) {
    tr.append(placeholderCell());
    tr.append(placeholderCell());
  }
  const scopeCell = document.createElement('td');
  scopeCell.className = `custom-scope-cell${source.scope === 'detalle' ? ' is-detalle' : ''}`;
  scopeCell.textContent = scopeLabel(source.scope === 'detalle' ? 'detalle' : 'cabecera');
  tr.append(scopeCell);
  if (inExcelBlock) tr.append(placeholderCell());
  const companiesCell = document.createElement('td');
  companiesCell.className = 'custom-company-cell';
  companiesCell.textContent = inExcelBlock
    ? `Empresas: ${[...group.companies].join(', ')}`
    : [...group.companies].join(', ');
  tr.append(companiesCell);
  const actionCell = document.createElement('td');
  actionCell.className = 'custom-action-cell';
  if (group.mine) {
    const quit = document.createElement('button');
    quit.type = 'button';
    quit.className = 'custom-delete';
    quit.textContent = 'Quitar';
    quit.title = `Quitar mi aporte (solo elimina el de ${state.company})`;
    quit.addEventListener('click', async () => {
      quit.disabled = true;
      try {
        await deleteCustomField(group.mine);
      } catch (error) {
        quit.disabled = false;
        quit.textContent = error.message;
      }
    });
    actionCell.append(quit);
  } else {
    actionCell.append(reuseButton(group.sample));
  }
  tr.append(actionCell);
  return tr;
}

function placeholderCell() {
  const cell = document.createElement('td');
  cell.className = 'placeholder-cell';
  cell.textContent = '—';
  return cell;
}

function hasCustomField(sheetName, name) {
  const key = customFieldKey(name);
  return state.customFields.some(item => item.sheetName === sheetName && customFieldKey(item.fieldName) === key);
}

function blockTableShell(title, headers) {
  const section = document.createElement('details');
  section.className = 'table-block';
  section.open = true;
  const subtitle = document.createElement('summary');
  subtitle.textContent = title;
  section.append(subtitle);
  const scroll = document.createElement('div');
  scroll.className = 'table-scroll';
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  const numberHeader = document.createElement('th');
  numberHeader.className = 'row-number';
  numberHeader.textContent = '#';
  headerRow.append(numberHeader);
  headers.forEach(text => {
    const cell = document.createElement('th');
    cell.textContent = text;
    headerRow.append(cell);
  });
  thead.append(headerRow);
  table.append(thead);
  const tbody = document.createElement('tbody');
  table.append(tbody);
  scroll.append(table);
  section.append(scroll);
  return { section, tbody };
}

function buildOthersBlock(groups) {
  const rows = groups.others.filter(field => !groups.shared.has(customFieldKey(field.fieldName)));
  if (!rows.length) return null;
  const { section, tbody } = blockTableShell(
    'Campos Nuevos en Otras Empresas',
    ['Campo / Tag XML', 'Descripcion', 'Campo SAP', 'Ambito', 'Empresa', '']
  );
  rows.forEach(field => tbody.append(buildOtherFieldRow(field)));
  return section;
}

function buildSharedSection(groups) {
  const shared = [...groups.byKey.values()].filter(group => groups.shared.has(group.key));
  if (!shared.length) return null;
  const { section, tbody } = blockTableShell(
    'Campos Parcialmente Compartidos (Con Datos en algunas empresas)',
    ['Campo / Tag XML', 'Descripcion', 'Ambito', 'Presente en', '']
  );
  shared.forEach(group => tbody.append(buildSharedFieldRow(group)));
  return section;
}

function scopeKey(sheet, row) {
  return `${sheet}:${row}`;
}

function scopeEntryFor(sheet, row) {
  return state.scopes.get(scopeKey(sheet, row)) || { own: null, others: [] };
}

async function loadScopes() {
  const response = await fetch(`/api/field-scopes?company=${encodeURIComponent(state.company)}`);
  if (!response.ok) throw new Error('No se pudieron cargar los ambitos Cabecera/Detalle.');
  const data = await response.json();
  state.scopes = new Map(data.entries.map(entry => [scopeKey(entry.sheet, entry.row), entry]));
}

function originalScope(block, item) {
  if (!block.header) return null;
  const nivelIndex = block.header.cells.findIndex(value => /^nivel$/i.test(text(value).trim()));
  if (nivelIndex < 0) return null;
  const raw = text(item.cells[nivelIndex]).trim().toLowerCase();
  if (raw === 'cabecera') return 'cabecera';
  if (raw === 'detalle') return 'detalle';
  return null;
}

function scopeLabel(scope) {
  return scope === 'detalle' ? 'Detalle' : 'Cabecera';
}

async function saveScope(sheet, row, scope, control) {
  control.disabled = true;
  try {
    const response = await fetch('/api/field-scopes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company: state.company, sheetName: sheet, row, scope })
    });
    if (!response.ok) throw new Error('No se pudo guardar el ambito.');
    await loadScopes();
    renderTable();
    showToast(`Ambito guardado: ${scopeLabel(scope)}.`);
  } catch (error) {
    control.disabled = false;
    control.title = error.message;
  }
}

function createScopeCell(sheet, block, item) {
  const entry = scopeEntryFor(sheet, item.row);
  const original = originalScope(block, item);
  const current = entry.own?.scope || original || 'cabecera';
  const cell = document.createElement('td');
  cell.className = 'scope-cell';
  if (entry.own && entry.own.scope !== original) cell.classList.add('scope-modified');
  const control = document.createElement('button');
  control.type = 'button';
  control.className = `scope-switch${current === 'detalle' ? ' is-detalle' : ''}`;
  control.setAttribute('role', 'switch');
  control.setAttribute('aria-checked', current === 'detalle');
  const suggestion = entry.others.length ? ` (aporte de ${entry.others[0].company}: ${scopeLabel(entry.others[0].scope)})` : '';
  control.title = `Origen Excel: ${original ? scopeLabel(original) : 'sin dato'}${suggestion}. Clic para cambiar.`;
  const knob = document.createElement('span');
  knob.className = 'scope-knob';
  knob.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'scope-label';
  label.textContent = scopeLabel(current);
  control.append(knob, label);
  control.addEventListener('click', () => {
    saveScope(sheet, item.row, current === 'detalle' ? 'cabecera' : 'detalle', control);
  });
  cell.append(control);
  return cell;
}

function omitKey(sheet, row) {
  return `${sheet}:${row}`;
}

function omitEntryFor(sheet, row) {
  return state.omits.get(omitKey(sheet, row)) || { own: null, others: [] };
}

function isOmitted(sheet, row) {
  return omitEntryFor(sheet, row).own?.omitted === true;
}

async function loadOmits() {
  const response = await fetch(`/api/field-omits?company=${encodeURIComponent(state.company)}`);
  if (!response.ok) throw new Error('No se pudieron cargar los omitidos.');
  const data = await response.json();
  state.omits = new Map(data.entries.map(entry => [omitKey(entry.sheet, entry.row), entry]));
}

async function saveOmit(sheet, row, omitted, control) {
  control.disabled = true;
  try {
    const response = await fetch('/api/field-omits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company: state.company, sheetName: sheet, row, omitted })
    });
    if (!response.ok) throw new Error('No se pudo guardar.');
    await loadOmits();
    renderTable();
    showToast(omitted ? 'Campo omitido para tu empresa.' : 'Campo incluido nuevamente.');
  } catch (error) {
    control.disabled = false;
    control.title = error.message;
  }
}

function createOmitCell(sheet, item) {
  const entry = omitEntryFor(sheet, item.row);
  const omitted = entry.own?.omitted === true;
  const cell = document.createElement('td');
  cell.className = 'omit-cell';
  const control = document.createElement('button');
  control.type = 'button';
  control.className = `scope-switch omit-switch${omitted ? ' is-omitted' : ''}`;
  control.setAttribute('role', 'switch');
  control.setAttribute('aria-checked', omitted);
  const suggestion = entry.others.length
    ? ` Omitido tambien por ${entry.others.map(other => other.company).join(', ')}.`
    : '';
  control.title = omitted ? `Omitido por ${state.company}.${suggestion} Clic para incluir.` : `Incluido.${suggestion} Clic para omitir.`;
  const knob = document.createElement('span');
  knob.className = 'scope-knob';
  knob.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'scope-label';
  label.textContent = omitted ? 'Omitido' : 'Incluido';
  control.append(knob, label);
  control.addEventListener('click', () => {
    saveOmit(sheet, item.row, !omitted, control);
  });
  cell.append(control);
  return cell;
}

function renderCompanyOptions() {
  companies.forEach(company => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'company-option';
    button.textContent = company;
    button.addEventListener('click', async () => {
      state.company = company;
      companyGate.classList.add('hidden');
      floatingFieldButton.hidden = false;
      try {
        await loadFieldValues();
        await reloadCustomFields();
        await loadScopes();
        await loadOmits();
        if (state.data) {
          const firstVisibleSheet = state.data.sheets.findIndex(isVisibleSheet);
          if (firstVisibleSheet >= 0) state.activeSheet = firstVisibleSheet;
          renderSummary();
          renderTabs();
          renderTable();
        }
      } catch (error) {
        resultCount.textContent = error.message;
      }
    });
    companyOptions.append(button);
  });
}

function customFieldsForBlock(sheetName, block) {
  const code = block.subtitle.match(/Campos Exclusivos de\s+([A-Z]+)\s+\(Con Datos\)/i)?.[1]?.toUpperCase();
  if (state.company === 'Antares Aduanas' && isAntaresOnlySheet({ name: sheetName })) {
    return state.customFields.filter(field => field.sheetName === sheetName);
  }
  if (!code || exclusiveCompanyByCode[code] !== state.company) return [];
  return state.customFields.filter(field => field.sheetName === sheetName);
}

function targetCustomFieldBlock(sheet) {
  // Misma tuberia que renderTable: si la empresa no tiene bloque exclusivo en el
  // Excel, se usa la seccion exclusiva generada (vacia) en vez de fallar.
  const blocks = addGeneratedExclusiveBlock(sheet, makeBlocks(sheet).filter(isVisibleBlock));
  if (state.company === 'Antares Aduanas') return blocks[0] || null;
  return blocks.find(block => {
    const code = block.subtitle.match(/Campos Exclusivos de\s+([A-Z]+)\s+\(Con Datos\)/i)?.[1]?.toUpperCase();
    return code && exclusiveCompanyByCode[code] === state.company;
  }) || null;
}

async function addCustomField(sheetName, block, form) {
  const inputs = [...form.querySelectorAll('input')];
  const [fieldInput, descriptionInput, sapInput] = inputs;
  const submit = form.querySelector('button');
  submit.disabled = true;
  try {
    const response = await fetch('/api/custom-fields', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company: state.company, sheetName, fieldName: fieldInput.value, description: descriptionInput.value, sapField: sapInput.value })
    });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || 'No se pudo agregar el campo.');
    }
    fieldInput.value = '';
    descriptionInput.value = '';
    await loadCustomFields();
    renderTable();
  } catch (error) {
    submit.disabled = false;
    submit.textContent = error.message;
  }
}

async function saveFloatingCustomField(event) {
  event.preventDefault();
  const formData = new FormData(floatingFieldForm);
  const sheet = state.data?.sheets[state.activeSheet];
  const targetBlock = sheet && targetCustomFieldBlock(sheet);
  if (!sheet || !targetBlock) {
    floatingFieldForm.querySelector('button[type="submit"]').textContent = 'No hay sección exclusiva';
    return;
  }
  const submit = floatingFieldForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const response = await fetch('/api/custom-fields', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        company: state.company,
        sheetName: sheet.name,
        fieldName: formData.get('fieldName'),
        description: formData.get('description'),
        sapField: formData.get('sapField'),
        scope: formData.get('scope')
      })
    });
    if (!response.ok) throw new Error('No se pudo guardar el campo.');
    floatingFieldForm.reset();
    setCreateScope('cabecera');
    submit.disabled = false;
    submit.textContent = 'Guardar campo';
    floatingFieldPanel.hidden = true;
    await reloadCustomFields();
    const createdName = String(formData.get('fieldName') || '').trim();
    const createdKey = customFieldKey(createdName);
    const createdGroups = sheetCustomGroups(sheet.name);
    renderTable();
    if (createdGroups.shared.has(createdKey)) {
      const others = [...createdGroups.byKey.get(createdKey).companies].filter(company => company !== state.company);
      showToast(`"${createdName}" ya existe en ${others.join(', ')}: se movio a Parcialmente Compartidos.`);
    } else {
      showToast(`"${createdName}" guardado en ${targetBlock.subtitle}.`);
    }
    focusCustomRow(createdKey);
  } catch (error) {
    submit.disabled = false;
    submit.textContent = error.message;
  }
}

function setCreateScope(scope) {
  const normalized = scope === 'detalle' ? 'detalle' : 'cabecera';
  floatingFieldForm.querySelector('input[name="scope"]').value = normalized;
  newFieldScopeButton.classList.toggle('is-detalle', normalized === 'detalle');
  newFieldScopeButton.setAttribute('aria-checked', normalized === 'detalle');
  newFieldScopeButton.querySelector('.scope-label').textContent = scopeLabel(normalized);
}

async function deleteCustomField(field) {
  if (!window.confirm(`Eliminar el campo nuevo "${field.fieldName}"?`)) return;
  const response = await fetch(`/api/custom-fields/${field.id}?company=${encodeURIComponent(state.company)}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('No se pudo eliminar el campo nuevo.');
  await reloadCustomFields();
  renderTable();
  showToast(`"${field.fieldName}" eliminado de tu lista.`);
}

function rowType(cells, index, sheet) {
  const filled = cells.filter(value => text(value).trim());
  if (isAntaresOnlySheet(sheet) && filled.length === 1) return 'section-row';
  if (filled.length === 1 && index < 5) return 'title-row';
  if (index === 0 && (sheet.name.includes('_') || sheet.name === 'Hoja5')) return 'header-row';
  if (index === 0 && isAntaresOnlySheet(sheet)) return 'header-row';
  if (filled.length <= 2 && filled.some(value => /^\d+\./.test(text(value).trim()))) return 'section-row';
  if (filled.length >= 2 && filled.some(value => /campo \/ tag xml|nombreobjeto|nombrecampo|nombre$/i.test(text(value)))) return 'header-row';
  return '';
}

function makeBlocks(sheet) {
  const blocks = [];
  let current = { subtitle: sheet.name, header: null, rows: [] };
  sheet.rows.forEach((item, index) => {
    const type = rowType(item.cells, index, sheet);
    const values = item.cells.filter(value => text(value).trim());
    if (type === 'title-row') {
      if (!current.header && current.rows.length === 0 && values.length) current.subtitle = values.join(' | ');
      return;
    }
    if (type === 'section-row') {
      if (current.header || current.rows.length) blocks.push(current);
      current = { subtitle: values.join(' | '), header: null, rows: [] };
      return;
    }
    if (type === 'header-row' && !current.header) {
      current.header = item;
      return;
    }
    current.rows.push(item);
  });
  if (current.header || current.rows.length) blocks.push(current);
  return blocks.map(block => {
    if (!block.header) return block;
    const firstColumn = block.header.cells.findIndex(value => text(value).trim());
    const lastColumn = block.header.cells.reduce((last, value, index) => text(value).trim() ? index : last, -1);
    if (firstColumn <= 0 && lastColumn === block.header.cells.length - 1) return block;
    return {
      ...block,
      header: { ...block.header, cells: block.header.cells.slice(firstColumn, lastColumn + 1) },
      rows: block.rows.map(row => ({ ...row, cells: row.cells.slice(firstColumn, lastColumn + 1) }))
    };
  });
}

function renderTabs() {
  tabs.replaceChildren();
  state.data.sheets.forEach((sheet, index) => {
    if (!isVisibleSheet(sheet)) return;
    const button = document.createElement('button');
    button.className = `tab${index === state.activeSheet ? ' active' : ''}`;
    button.type = 'button';
    button.textContent = sheet.name;
    button.setAttribute('aria-selected', index === state.activeSheet);
    button.addEventListener('click', () => {
      state.activeSheet = index;
      state.query = '';
      search.value = '';
      renderTabs();
      renderTable();
    });
    tabs.append(button);
  });
}

async function saveFieldValue(sheet, row, input, button, suggestedValue, hasOtherValue) {
  const value = input.value.trim();
  const current = entryFor(sheet, row);
  const validated = Boolean(hasOtherValue && value === suggestedValue);
  button.disabled = true;
  try {
    const response = await fetch('/api/field-values', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company: state.company, sheetName: sheet, row, value, validated })
    });
    if (!response.ok) throw new Error('No se pudo guardar el valor.');
    await loadFieldValues();
        if (state.data) {
          renderSummary();
          renderTabs();
          renderTable();
        }
  } catch (error) {
    button.disabled = false;
    button.textContent = error.message;
  }
}

function createFieldEntryCell(sheet, item) {
  const entry = entryFor(sheet, item.row);
  const suggestedValue = entry.others[0]?.value || '';
  const cell = document.createElement('td');
  cell.className = 'field-entry-cell';
  if (entry.own?.value) cell.classList.add('field-entry-owned');
  const wrapper = document.createElement('div');
  wrapper.className = 'field-entry';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = entry.own?.value || suggestedValue;
  if (entry.own?.value) input.classList.add('field-value-owned');
  input.placeholder = 'Ingresar valor';
  input.title = entry.others.length ? `Valor informado por ${entry.others[0].company}` : 'Campo SAP';
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'field-save';
  const hasOtherValue = !entry.own && Boolean(suggestedValue);
  action.textContent = hasOtherValue ? 'Estoy de acuerdo' : 'Guardar';
  action.addEventListener('click', () => saveFieldValue(sheet, item.row, input, action, suggestedValue, hasOtherValue));
  input.addEventListener('input', () => {
    action.textContent = hasOtherValue && input.value.trim() === suggestedValue ? 'Estoy de acuerdo' : 'Guardar';
  });
  if (hasOtherValue) {
    const alert = document.createElement('span');
    alert.className = 'field-alert';
    alert.textContent = 'Validar';
    wrapper.append(alert);
  }
  wrapper.append(input, action);
  cell.append(wrapper);
  return cell;
}

function renderTable() {
  const sheet = state.data.sheets[state.activeSheet];
  const query = state.query.trim().toLocaleLowerCase();
  const blocks = addGeneratedExclusiveBlock(sheet, makeBlocks(sheet).filter(isVisibleBlock)).map(filterPresenceRows);
  const groups = sheetCustomGroups(sheet.name);
  const visibleRows = blocks.reduce((total, block) => total + block.rows.filter(item => !query || item.cells.some(value => text(value).toLocaleLowerCase().includes(query))).length, 0);
  tableView.replaceChildren();
  let sharedSectionShown = false;
  blocks.forEach(block => {
    const matchingRows = block.rows.filter(item => !query || item.cells.some(value => text(value).toLocaleLowerCase().includes(query)) || block.subtitle.toLocaleLowerCase().includes(query));
    if (!matchingRows.length && !block.generatedExclusive) return;
    const section = document.createElement('details');
    section.className = 'table-block';
    section.open = true;
    const subtitle = document.createElement('summary');
    subtitle.textContent = block.subtitle;
    section.append(subtitle);
    const newFields = customFieldsForBlock(sheet.name, block)
      .filter(field => !groups.shared.has(customFieldKey(field.fieldName)));
    const scroll = document.createElement('div');
    scroll.className = 'table-scroll';
    const currentTable = document.createElement('table');
    const valueColumns = new Set();
    const commonBlock = isCommonBlock(block);
    const directoryBlock = isAntaresDirectoryBlock(sheet);
    const editableFieldBlock = commonBlock
      || isAntaresOnlySheet(sheet)
      || (isExclusiveBlock(block) && isVisibleBlock(block))
      || (isPresenceBlock(block) && Boolean(companyCode()));
    // La columna Nivel del Excel se oculta: su valor ya vive en el switch Cabecera/Detalle.
    const nivelIndex = (!directoryBlock && editableFieldBlock && block.header)
      ? block.header.cells.findIndex(value => /^nivel$/i.test(text(value).trim()))
      : -1;
    const headerCells = block.header && nivelIndex >= 0
      ? block.header.cells.filter((_, index) => index !== nivelIndex)
      : block.header?.cells;
    const rowCells = item => nivelIndex >= 0
      ? item.cells.filter((_, index) => index !== nivelIndex)
      : item.cells;
    if (directoryBlock) currentTable.classList.add('directory-table');
    if (block.header) {
      const thead = document.createElement('thead');
      const headerRow = document.createElement('tr');
      const numberHeader = document.createElement('th');
      numberHeader.className = 'row-number';
      numberHeader.textContent = '#';
      headerRow.append(numberHeader);
      if (directoryBlock) {
        ['NOMBRE CAMPO', 'DESCRIPCION'].forEach(value => {
          const fieldHeader = document.createElement('th');
          fieldHeader.textContent = value;
          headerRow.append(fieldHeader);
        });
        const fieldHeader = document.createElement('th');
        fieldHeader.className = 'field-header';
        fieldHeader.textContent = 'Campo SAP';
        headerRow.append(fieldHeader);
      } else {
        const descriptionIndex = headerCells.findIndex(value => /DESCRIP/i.test(text(value)));
        const fieldInsertIndex = descriptionIndex >= 0 ? descriptionIndex + 1 : Math.min(2, headerCells.length);
        headerCells.forEach((value, index) => {
          if (isPresenceBlock(block) && index === fieldInsertIndex) {
            const presenceHeader = document.createElement('th');
            presenceHeader.textContent = 'Presente en';
            headerRow.append(presenceHeader);
          }
          if (editableFieldBlock && index === fieldInsertIndex) {
            const fieldHeader = document.createElement('th');
            fieldHeader.className = 'field-header';
            fieldHeader.textContent = 'Campo SAP';
            headerRow.append(fieldHeader);
            const scopeHeader = document.createElement('th');
            scopeHeader.className = 'scope-header';
            scopeHeader.textContent = 'Cabecera / Detalle';
            headerRow.append(scopeHeader);
            const omitHeader = document.createElement('th');
            omitHeader.className = 'omit-header';
            omitHeader.textContent = 'Omitir';
            headerRow.append(omitHeader);
          }
          const cell = document.createElement('th');
          cell.textContent = text(value);
          if (isPresenceBlock(block) && /(?:Tiene|Presente).*\b(?:TMR|AL|CTR|TM)\s*\?/i.test(text(value))) {
            cell.className = 'presence-column';
          }
          if (/valor/i.test(text(value))) {
            valueColumns.add(index);
            cell.className = 'value-column';
            cell.dataset.column = index;
          }
          headerRow.append(cell);
        });
      }
      currentTable.dataset.valueColumns = [...valueColumns].join(',');
      if (valueColumns.size) {
        currentTable.className = 'values-collapsed';
        const valuesHeader = document.createElement('th');
        valuesHeader.className = 'values-control-column';
        valuesHeader.textContent = 'Ver Valores';
        headerRow.append(valuesHeader);
      }
      thead.append(headerRow);
      currentTable.append(thead);
    }
    const tbody = document.createElement('tbody');
    matchingRows.forEach(item => {
      const tr = document.createElement('tr');
      if (!directoryBlock && editableFieldBlock && isOmitted(sheet.name, item.row)) tr.classList.add('row-omitted');
      const rowNumber = document.createElement('td');
      rowNumber.className = 'row-number';
      rowNumber.textContent = item.row;
      tr.append(rowNumber);
      if (directoryBlock) {
        const fieldCell = document.createElement('td');
        fieldCell.textContent = text(item.cells[0]);
        tr.append(fieldCell);
        const descriptionCell = document.createElement('td');
        const descriptionIndex = block.header.cells.findIndex(value => /DESCRIP/i.test(text(value)));
        descriptionCell.textContent = text(item.cells[descriptionIndex >= 0 ? descriptionIndex : 1]);
        tr.append(descriptionCell, createFieldEntryCell(sheet.name, item));
      } else {
        const columnCount = headerCells ? headerCells.length : sheet.columnCount;
        const cells = rowCells(item);
        const descriptionIndex = headerCells?.findIndex(value => /DESCRIP/i.test(text(value))) ?? -1;
        const fieldInsertIndex = descriptionIndex >= 0 ? descriptionIndex + 1 : Math.min(2, columnCount);
        for (let index = 0; index < columnCount; index += 1) {
          if (isPresenceBlock(block) && index === fieldInsertIndex) {
            const presenceCell = document.createElement('td');
            presenceCell.textContent = presenceSummary(block, item);
            tr.append(presenceCell);
          }
          if (editableFieldBlock && index === fieldInsertIndex) tr.append(createFieldEntryCell(sheet.name, item));
          if (editableFieldBlock && index === fieldInsertIndex) tr.append(createScopeCell(sheet.name, block, item));
          if (editableFieldBlock && index === fieldInsertIndex) tr.append(createOmitCell(sheet.name, item));
          const cell = document.createElement('td');
          cell.textContent = text(cells[index]);
          if (isPresenceBlock(block) && /(?:Tiene|Presente).*\b(?:TMR|AL|CTR|TM)\s*\?/i.test(text(headerCells?.[index]))) {
            cell.className = 'presence-column';
          }
          if (block.header && valueColumns.has(index)) {
            cell.className = 'value-column';
            cell.dataset.column = index;
            cell.title = text(item.cells[index]);
          }
          tr.append(cell);
        }
      }
      if (valueColumns.size) {
        const controlCell = document.createElement('td');
        controlCell.className = 'values-control-column';
        const control = document.createElement('button');
        control.className = 'values-control';
        control.type = 'button';
        control.textContent = 'Ver Valores';
        control.addEventListener('click', () => {
          const collapsed = currentTable.classList.toggle('values-collapsed');
          currentTable.querySelectorAll('.values-control').forEach(button => {
            button.textContent = collapsed ? 'Ver Valores' : 'Ocultar Valores';
          });
        });
        controlCell.append(control);
        tr.append(controlCell);
      }
      tbody.append(tr);
    });
    newFields.forEach(field => {
      const tr = document.createElement('tr');
      tr.className = 'custom-field-row';
      tr.dataset.customId = field.id;
      tr.dataset.customKey = customFieldKey(field.fieldName);
      const rowNumber = document.createElement('td');
      rowNumber.className = 'row-number';
      rowNumber.textContent = 'Nuevo';
      tr.append(rowNumber);
      const fieldCell = document.createElement('td');
      fieldCell.textContent = field.fieldName;
      tr.append(fieldCell);
      const descriptionCell = document.createElement('td');
      descriptionCell.textContent = field.description;
      tr.append(descriptionCell);
      if (isPresenceBlock(block)) tr.append(placeholderCell());
      const sapCell = document.createElement('td');
      sapCell.className = 'custom-sap-cell';
      sapCell.textContent = field.sapField || 'Pendiente';
      tr.append(sapCell);
      const scopeBadge = document.createElement('td');
      scopeBadge.className = `custom-scope-cell${field.scope === 'detalle' ? ' is-detalle' : ''}`;
      scopeBadge.textContent = scopeLabel(field.scope === 'detalle' ? 'detalle' : 'cabecera');
      tr.append(scopeBadge);
      tr.append(placeholderCell());
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'custom-delete';
      deleteButton.textContent = 'Eliminar';
      deleteButton.title = 'Eliminar únicamente este campo nuevo';
      deleteButton.addEventListener('click', async () => {
        deleteButton.disabled = true;
        try {
          await deleteCustomField(field);
        } catch (error) {
          deleteButton.disabled = false;
          deleteButton.textContent = error.message;
        }
      });
      const actionCell = document.createElement('td');
      actionCell.className = 'custom-action-cell';
      actionCell.append(deleteButton);
      tr.append(actionCell);
      tbody.append(tr);
    });
    if (/parcialmente compartidos/i.test(block.subtitle) && groups.shared.size) {
      [...groups.byKey.values()]
        .filter(group => groups.shared.has(group.key))
        .forEach(group => tbody.append(buildSharedFieldRow(group, true)));
      sharedSectionShown = true;
    }
    currentTable.append(tbody);
    scroll.append(currentTable);
    section.append(scroll);
    tableView.append(section);
  });
  const othersBlock = buildOthersBlock(groups);
  if (othersBlock) tableView.append(othersBlock);
  if (groups.shared.size && !sharedSectionShown) {
    const sharedSection = buildSharedSection(groups);
    if (sharedSection) tableView.append(sharedSection);
  }
  emptyState.hidden = visibleRows > 0;
  if (visibleRows === 0) tableView.append(emptyState);
  resultCount.textContent = `${visibleRows} de ${sheet.rows.length} filas`;
  clearSearch.hidden = !state.query;
}

function renderSummary() {
  const visibleSheets = state.data.sheets.filter(isVisibleSheet);
  const rowTotal = visibleSheets.reduce((total, sheet) => total + sheet.rows.length, 0);
  summary.innerHTML = `<div class="metric"><strong>${visibleSheets.length}</strong><span>hojas visibles</span></div><div class="metric"><strong>${rowTotal.toLocaleString('es-ES')}</strong><span>filas con datos</span></div>`;
}

search.addEventListener('input', event => {
  state.query = event.target.value;
  renderTable();
});
clearSearch.addEventListener('click', () => {
  state.query = '';
  search.value = '';
  renderTable();
  search.focus();
});
document.addEventListener('keydown', event => {
  if (event.key === '/' && document.activeElement !== search) {
    event.preventDefault();
    search.focus();
  }
});

renderCompanyOptions();
newFieldScopeButton.addEventListener('click', () => {
  const current = floatingFieldForm.querySelector('input[name="scope"]').value;
  setCreateScope(current === 'detalle' ? 'cabecera' : 'detalle');
});
floatingFieldButton.addEventListener('click', () => {
  setCreateScope('cabecera');
  const submit = floatingFieldForm.querySelector('button[type="submit"]');
  submit.disabled = false;
  submit.textContent = 'Guardar campo';
  floatingFieldPanel.hidden = false;
  floatingFieldForm.querySelector('input')?.focus();
});
closeFieldPanel.addEventListener('click', () => { floatingFieldPanel.hidden = true; });
floatingFieldForm.addEventListener('submit', saveFloatingCustomField);

fetch('/api/sheets')
  .then(response => {
    if (!response.ok) throw new Error('No se pudo cargar el JSON');
    return response.json();
  })
  .then(data => {
    state.data = data;
    renderSummary();
    renderTabs();
    renderTable();
  })
  .catch(error => {
    resultCount.textContent = error.message;
    emptyState.hidden = false;
    emptyState.textContent = 'No se pudo cargar la fuente de datos desde la API. Comprueba que el backend esté iniciado.';
  });
