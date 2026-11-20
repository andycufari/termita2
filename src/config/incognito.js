// Incognito launch mode (`termita --incognito`, alias `--ghost`): a throwaway
// session that leaves NO trace in ~/.config/termita.
//
// One process-wide flag, set by cli.js before anything is constructed, checked
// at every place termita writes its own state:
//   - sessions/<date>.log journal        → not written (engine/log.js)
//   - per-command full-output .out files → go to a private temp dir, removed on exit
//   - last-session.json (`termita -c`)   → not overwritten, so -c still resumes
//                                          your last REAL session
//   - memory.json                        → never written; recall also off by
//                                          default (/cognito off brings recall back)
//   - config.json / system.json          → read-only; /theme, /model, etc. still
//                                          apply for this session, just aren't saved
//
// Files the MODEL writes on your behalf (the write tool, shell commands) are your
// work, not termita's state — incognito doesn't touch those.
let incognito = false;

export function setIncognito(on) { incognito = !!on; }
export function isIncognito() { return incognito; }
