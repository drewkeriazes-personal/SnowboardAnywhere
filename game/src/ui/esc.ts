/** Text for innerHTML: pack names come from OSM, so `&` and `<` show as written and a pack can't add markup. */
export const esc = (t: string): string => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
