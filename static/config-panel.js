// ─── Config panel ─────────────────────────────────────────────────────────────
// Left-side panel rendered from the schema. Each field validates on edit: a valid
// value is applied+persisted (via the store); an invalid one gets an LSP-style red
// squiggle under the input and a hint message, and is NOT applied until fixed.

import { CONFIG_SCHEMA, validateField, coerce } from './config-schema.js';
import { configValue, setConfig, configPath } from './config.js';

export function renderConfigPanel(container) {
  container.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'cfg-header';
  header.textContent = 'config';
  container.appendChild(header);

  for (const section of CONFIG_SCHEMA) {
    const sec = document.createElement('div');
    sec.className = 'cfg-section';
    const title = document.createElement('div');
    title.className = 'cfg-section-title';
    title.textContent = section.title;
    sec.appendChild(title);
    for (const f of section.fields) sec.appendChild(fieldRow(f));
    container.appendChild(sec);
  }

  const foot = document.createElement('div');
  foot.className = 'cfg-foot';
  foot.textContent = configPath();
  foot.title = 'personal config file (per-project)';
  container.appendChild(foot);
}

function fieldRow(f) {
  const row = document.createElement('div');
  row.className = 'cfg-row';

  const label = document.createElement('label');
  label.className = 'cfg-label';
  label.textContent = f.label;
  label.title = f.help || '';
  row.appendChild(label);

  const controls = document.createElement('div');
  controls.className = 'cfg-controls';
  row.appendChild(controls);

  let input, swatch;
  if (f.type === 'enum') {
    input = document.createElement('select');
    for (const opt of f.enum) {
      const o = document.createElement('option');
      o.value = opt; o.textContent = opt;
      input.appendChild(o);
    }
  } else {
    input = document.createElement('input');
    input.type = 'text';      // text (not number/color) so we can validate & squiggle freely
    input.spellcheck = false;
    if (f.type === 'color') {
      swatch = document.createElement('span');
      swatch.className = 'cfg-swatch';
      controls.appendChild(swatch);
    }
  }
  input.className = 'cfg-input';
  input.value = configValue(f.key);
  controls.appendChild(input);

  const hint = document.createElement('div');
  hint.className = 'cfg-hint';
  row.appendChild(hint);

  if (swatch) swatch.style.background = configValue(f.key);

  const onEdit = () => {
    const val = coerce(f, typeof input.value === 'string' ? input.value.trim() : input.value);
    const err = validateField(f, val);
    if (err) {
      input.classList.add('cfg-invalid');
      hint.textContent = err;
    } else {
      input.classList.remove('cfg-invalid');
      hint.textContent = '';
      if (swatch) swatch.style.background = val;
      setConfig(f.key, val);
    }
  };
  input.addEventListener(f.type === 'enum' ? 'change' : 'input', onEdit);
  return row;
}
