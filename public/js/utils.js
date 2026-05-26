// Pure utility helpers. No S, no fetch, no app-specific logic — safe to import
// from anywhere.

// ── DOM ID shorthand ────────────────────────────────────────────────────────
export function show(id)  { document.getElementById(id)?.classList.remove('hidden'); }
export function hide(id)  { document.getElementById(id)?.classList.add('hidden'); }
export function setText(id, t) { const el = document.getElementById(id); if (el) el.textContent = t; }

// ── Park factor lookup from the stadium-select dropdown ─────────────────────
// Reads HR factor, hit factor, elevation, and roof flag straight off the
// selected <option>'s data-* attributes.
export function _parkFactors() {
  const sel = document.getElementById('stadium-select');
  const opt = sel?.options[sel?.selectedIndex];
  return {
    hrF:    parseFloat(opt?.dataset.hr)  || 1.0,
    hitF:   parseFloat(opt?.dataset.hit) || 1.0,
    elev:   parseInt(opt?.dataset.elev)  || 0,
    hasRoof: opt?.dataset.roof === '1',
  };
}

// ── CSV parser (handles quoted fields with embedded commas) ─────────────────
// Returns an array of objects keyed by the first row's column names.
export function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];

  function splitCSVLine(line) {
    const result = [];
    let cur = '', inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === ',' && !inQuote) { result.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    result.push(cur.trim());
    return result;
  }

  const headers = splitCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const vals = splitCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').replace(/"/g, '').trim(); });
    return obj;
  });
}
