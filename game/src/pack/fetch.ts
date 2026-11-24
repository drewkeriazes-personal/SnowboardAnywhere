/**
 * FEAT-375: every fetch of a pack file goes through here. Settings > Graphics > Cache resort files (on by default)
 * leaves the browser's cache to the servers' validators (tools/pack_routes.mjs notModified: a warm reload gets 304s);
 * off fetches each file afresh with `no-store`. Set once at boot, so a change applies on the next load.
 */
let init: RequestInit = {};
export function setPackCache(on: boolean): void { init = on ? {} : { cache: 'no-store' }; }
export const packFetch = (url: string): Promise<Response> => fetch(url, init);
