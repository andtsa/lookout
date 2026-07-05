const BASE = '';

export async function fetchGraph() {
  const r = await fetch(`${BASE}/graph`);
  return r.json();
}

export async function patchNode(id, delta) {
  const r = await fetch(`${BASE}/node/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(delta),
  });
  return r.json();
}

export async function patchEdge(id, delta) {
  const r = await fetch(`${BASE}/edge/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(delta),
  });
  return r.json();
}

export async function postSave() {
  const r = await fetch(`${BASE}/save`, { method: 'POST' });
  return r.json();
}

// Discard in-memory edits: the backend re-parses config + state from disk.
export async function postReload() {
  const r = await fetch(`${BASE}/reload`, { method: 'POST' });
  return r.json();
}

export async function fetchFile(path, start, end) {
  const params = new URLSearchParams({ path });
  if (start != null) params.set('start', start);
  if (end != null) params.set('end', end);
  const r = await fetch(`${BASE}/file?${params}`);
  if (!r.ok) throw new Error(`File not found: ${path}`);
  return r.json();
}

export async function fetchStatus() {
  const r = await fetch(`${BASE}/status`);
  return r.json();
}
