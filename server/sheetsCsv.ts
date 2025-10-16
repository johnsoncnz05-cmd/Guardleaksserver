import fetch from "node-fetch";

export async function fetchSheetCsv(csvUrl: string): Promise<string[][]> {
  const r = await fetch(csvUrl);
  if (!r.ok) throw new Error(`CSV fetch failed: ${r.status}`);
  const txt = await r.text();

  // very simple csv split (you already have a robust parser in the client if you prefer)
  const lines = txt.split(/\r?\n/).filter(Boolean);
  return lines.map(line => {
    // crude split — for perfect CSV use your parseDelimited from client or a library
    return line.split(",");
  });
}
