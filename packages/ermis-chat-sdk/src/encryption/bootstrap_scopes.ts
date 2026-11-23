/** Metadata-only selection. An inherited topic consumes its parent's one MLS slot. */
function selectScopes(rows: ReadonlyArray<{cid:string;scopeCid:string;lastMessageAt?:string|Date|null;updated_at?:string|Date|null}>, activeCid?:string|null, maximum = 5): string[] {
  const time=(row:typeof rows[number])=>{const raw=row.lastMessageAt??row.updated_at;const n=raw instanceof Date?raw.getTime():Date.parse(raw||'');return Number.isFinite(n)?n:0;};
  const ranked=[...rows].sort((a,b)=>time(b)-time(a)||(a.cid<b.cid?-1:a.cid>b.cid?1:0));
  const active=rows.find(row=>row.cid===activeCid||row.scopeCid===activeCid)?.scopeCid;
  const selected=active?[active]:[];
  const seen = new Set(selected);
  let recent=0;
  for(const row of ranked){if(seen.has(row.scopeCid))continue;if(recent===maximum)break;selected.push(row.scopeCid);seen.add(row.scopeCid);recent++;}
  return selected;
}

export const selectWarmScopes = (rows: Parameters<typeof selectScopes>[0], activeCid?: string | null) => selectScopes(rows, activeCid);
export const selectAllScopes = (rows: Parameters<typeof selectScopes>[0], activeCid?: string | null) => selectScopes(rows, activeCid, Infinity);
