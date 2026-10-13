#!/usr/bin/env node
'use strict';

/**
 * tg — drive your own Telegram account from the command line with mtcute.
 *
 * Signs in once, keeps the resulting session string in a private data directory outside this
 * repository, and then lets short subcommands read and send on the account. Each command connects,
 * does its work and disconnects, so no client stays attached to the account between commands.
 *
 * The session string is a FULL ACCOUNT CREDENTIAL: anyone holding it is logged into the account.
 * It is never printed, never logged, and never leaves the data directory.
 */

{
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    if (typeof chunk === 'string' && chunk.includes('[@mtcute/node]')) return true;
    return realWrite(chunk, ...rest);
  };
}

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.TG_SKILL_HOME || path.join(os.homedir(), '.telegram-skill');
const CONFIG_FILE = path.join(HOME, 'config.json');
const SESSION_FILE = path.join(HOME, 'session.txt');
const CODE_FILE = path.join(HOME, 'code.txt');
const PASSWORD_FILE = path.join(HOME, 'password.txt');

const { TelegramClient, MemoryStorage } = require('@mtcute/node');

function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
}

function readConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(`No config at ${CONFIG_FILE}. Run "node tg.js init --apiId <id> --apiHash <hash> --phone <+number>".`);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  for (const key of ['apiId', 'apiHash', 'phone']) {
    if (!cfg[key]) throw new Error(`${CONFIG_FILE} is missing "${key}"`);
  }
  return cfg;
}

function hasSession() {
  return fs.existsSync(SESSION_FILE) && fs.readFileSync(SESSION_FILE, 'utf8').trim().length > 0;
}

function readSession() {
  if (!hasSession()) throw new Error('Not logged in. Run "node tg.js login" first.');
  return fs.readFileSync(SESSION_FILE, 'utf8').trim();
}

function saveSession(str) {
  ensureHome();
  fs.writeFileSync(SESSION_FILE, str, { encoding: 'utf8', mode: 0o600 });
}

/**
 * The optional "device" block in config.json overrides what this client reports to Telegram
 * (deviceModel, systemVersion, appVersion, systemLangCode). Without it, mtcute's defaults are used.
 */
function createClient(cfg) {
  const options = {
    apiId: Number(cfg.apiId),
    apiHash: cfg.apiHash,
    storage: new MemoryStorage(),
  };
  if (cfg.device && typeof cfg.device === 'object') options.initConnectionOptions = cfg.device;
  return new TelegramClient(options);
}

function log(msg) {
  console.log(msg);
}

async function withClient(fn) {
  const cfg = readConfig();
  const client = createClient(cfg);
  await client.importSession(readSession());
  try {
    const me = await client.getMe();
    return await fn(client, me);
  } finally {
    // destroy(), never logOut(): logOut would end the session we want to keep.
    await client.destroy().catch(() => {});
  }
}

function fmtUser(u) {
  const uname = u.username ? `@${u.username}` : '(no username)';
  return `${u.displayName} ${uname} — id ${u.id}`;
}

function fmtMessage(m) {
  const who = m.sender ? m.sender.displayName : '?';
  const when = m.date ? new Date(m.date).toISOString().replace('T', ' ').slice(0, 16) : '';
  const body = m.text ? oneLine(m.text) : '';
  const media = m.media ? ` [${m.media.type}]` : '';
  return `  #${m.id}  ${when}  ${who}: ${body}${media}`;
}

// ---------------------------------------------------------------------------
// setup and session
// ---------------------------------------------------------------------------

async function cmdInit(args) {
  ensureHome();
  const opts = parseFlags(args);
  const existing = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
  const cfg = {
    ...existing,
    apiId: opts.apiId || existing.apiId,
    apiHash: opts.apiHash || existing.apiHash,
    phone: opts.phone || existing.phone,
  };
  for (const key of ['apiId', 'apiHash', 'phone']) {
    if (!cfg[key]) throw new Error(`init needs --${key}`);
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
  log(`Wrote ${CONFIG_FILE}.`);
}

async function cmdStatus() {
  log(`data dir : ${HOME}`);
  if (!fs.existsSync(CONFIG_FILE)) {
    log('config   : MISSING — run "node tg.js init"');
    return;
  }
  readConfig();
  log('config   : present');
  if (!hasSession()) {
    log('session  : none — run "node tg.js login"');
    return;
  }
  log('session  : present');
  try {
    await withClient(async (_client, me) => {
      log(`logged in: ${fmtUser(me)}`);
    });
  } catch (err) {
    log(`logged in: NO — session rejected (${err.message}). Run "node tg.js login --force".`);
  }
}

/**
 * Telegram delivers the login code inside the user's Telegram app (from the service account 777000).
 * The code is accepted from --code, then $TG_CODE, then by polling code.txt in the data directory.
 * A two-step verification password is taken from $TG_2FA_PASSWORD, or from password.txt in the data
 * directory, which the user writes themselves; that file is deleted as soon as login ends.
 */
async function cmdLogin(args) {
  ensureHome();
  const opts = parseFlags(args);
  const cfg = readConfig();

  if (hasSession() && !opts.force) {
    log('Already have a session. Run "node tg.js status" to check it, or pass --force to replace it.');
    return;
  }

  const constCode = opts.code || process.env.TG_CODE || null;
  const client = createClient(cfg);
  log('Signing in …');
  try {
    const me = await client.start({
      phone: cfg.phone,
      codeSentCallback: sent => {
        log(`Telegram sent a login code (type: ${sent.type || 'app'}). Check your Telegram app now.`);
        if (!constCode) log(`Waiting for the code in: ${CODE_FILE}`);
      },
      code: async () => constCode || waitForFile(CODE_FILE, 'login code'),
      password: async () => {
        if (process.env.TG_2FA_PASSWORD) return process.env.TG_2FA_PASSWORD;
        log(`The account has two-step verification. Waiting for the password in: ${PASSWORD_FILE}`);
        return waitForFile(PASSWORD_FILE, 'password');
      },
      invalidCodeCallback: type => {
        log(`Telegram rejected the ${type}. It will be requested again.`);
      },
    });

    saveSession(await client.exportSession());
    log(`Signed in as ${fmtUser(me)}.`);
    log('Session stored. The other commands now work without a code.');
  } finally {
    await client.destroy().catch(() => {});
    for (const f of [CODE_FILE, PASSWORD_FILE]) {
      try { fs.unlinkSync(f); } catch { /* not there */ }
    }
  }
}

const POLL_MS = 1500;
const WAIT_MS = 10 * 60 * 1000;

async function waitForFile(file, what) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const value = fs.readFileSync(file, 'utf8').trim();
      fs.unlinkSync(file);
      if (value) {
        log(`Got the ${what}.`);
        return value;
      }
    }
    await sleep(POLL_MS);
  }
  throw new Error(`Timed out waiting for the ${what}.`);
}

async function cmdLogout() {
  if (!hasSession()) {
    log('No session to log out.');
    return;
  }
  const client = createClient(readConfig());
  await client.importSession(readSession());
  try {
    await client.logOut();
    log('Logged out on Telegram.');
  } catch (err) {
    log(`logOut failed (${err.message}); removing the local session anyway.`);
  } finally {
    await client.destroy().catch(() => {});
  }
  try { fs.unlinkSync(SESSION_FILE); } catch { /* not there */ }
  log('Local session removed.');
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

async function cmdWhoami() {
  await withClient(async (_c, me) => {
    log(fmtUser(me));
    log(`premium : ${me.isPremium ? 'yes' : 'no'}`);
  });
}

async function cmdSessions() {
  await withClient(async client => {
    const res = await client.call({ _: 'account.getAuthorizations' });
    const rows = res.authorizations || [];
    log(`Active sessions: ${rows.length}\n`);
    for (const a of rows) {
      log(`  hash=${a.hash}${a.current ? '  <-- THIS SESSION' : ''}`);
      log(`    device : ${a.deviceModel} / ${a.platform} ${a.systemVersion}`);
      log(`    app    : ${a.appName} ${a.appVersion}`);
      log(`    where  : ${a.country || '?'}  ${a.ip || ''}`);
      log(`    seen   : ${new Date(a.dateActive * 1000).toISOString()}`);
      log('');
    }
  });
}

async function cmdDialogs(args) {
  const opts = parseFlags(args);
  const limit = Number(positional(args)[0]) || 20;
  await withClient(async client => {
    let n = 0;
    for await (const d of client.iterDialogs({ limit })) {
      if (opts.unread && !d.unreadCount) continue;
      const chat = d.peer || {};
      const uname = chat.username ? ` @${chat.username}` : '';
      const unread = d.unreadCount ? `  (${d.unreadCount} unread)` : '';
      const last = d.lastMessage && d.lastMessage.text ? ` — ${oneLine(d.lastMessage.text)}` : '';
      log(`  [${chat.chatType || 'user'}] ${chat.displayName}${uname} — id ${chat.id}${unread}${last}`);
      n += 1;
    }
    if (n === 0) log('  (none)');
  });
}

async function cmdHistory(args) {
  const [peer, count] = positional(args);
  if (!peer) throw new Error('Usage: history <peer> [count]');
  await withClient(async client => {
    const msgs = await client.getHistory(coercePeer(peer), { limit: Number(count) || 20 });
    for (const m of [...msgs].reverse()) log(fmtMessage(m));
    if (msgs.length === 0) log('  (no messages)');
  });
}

async function cmdSearch(args) {
  const opts = parseFlags(args);
  const query = positional(args).join(' ');
  if (!query) throw new Error('Usage: search <text> [--in <peer>] [--limit N]');
  const limit = Number(opts.limit) || 20;
  await withClient(async client => {
    const msgs = opts.in
      ? await client.searchMessages({ chatId: coercePeer(opts.in), query, limit })
      : await client.searchGlobal({ query, limit });
    for (const m of msgs) {
      const where = opts.in ? '' : `[${m.chat ? m.chat.displayName : '?'}] `;
      log(`${where}${fmtMessage(m).trimStart()}`);
    }
    if (msgs.length === 0) log('  (nothing found)');
  });
}

async function cmdContacts(args) {
  const limit = Number(positional(args)[0]) || 50;
  await withClient(async client => {
    const contacts = await client.getContacts();
    log(`${contacts.length} contacts`);
    for (const u of contacts.slice(0, limit)) {
      log(`  ${u.displayName}${u.username ? ` @${u.username}` : ''} — id ${u.id}`);
    }
  });
}

async function cmdResolve(args) {
  const peer = positional(args)[0];
  if (!peer) throw new Error('Usage: resolve <peer>');
  await withClient(async client => {
    const p = await client.getPeer(coercePeer(peer));
    log(`${p.type}: ${p.displayName}${p.username ? ` @${p.username}` : ''} — id ${p.id}`);
  });
}

async function cmdDownload(args) {
  const [peer, id, dir] = positional(args);
  if (!peer || !id) throw new Error('Usage: download <peer> <messageId> [dir]');
  await withClient(async client => {
    const [msg] = await client.getMessages(coercePeer(peer), Number(id));
    if (!msg || !msg.media) throw new Error(`Message ${id} has no downloadable media.`);
    const ext = msg.media.type === 'photo' ? '.jpg' : '';
    const name = msg.media.fileName || `${peer.replace(/[^\w.-]/g, '_')}-${id}${ext}`;
    const target = path.resolve(dir || '.', name);
    await client.downloadToFile(target, msg.media);
    log(`Saved ${target}`);
  });
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

async function cmdSend(args) {
  const opts = parseFlags(args);
  const [peer, ...words] = positional(args);
  const text = words.join(' ');
  if (!peer || !text) throw new Error('Usage: send <peer> <text…> [--reply <messageId>]');
  await withClient(async client => {
    const params = opts.reply ? { replyTo: Number(opts.reply) } : undefined;
    const sent = await client.sendText(coercePeer(peer), text, params);
    log(`Sent to ${peer} (message #${sent.id}).`);
  });
}

async function cmdSendFile(args) {
  const opts = parseFlags(args);
  const [peer, file] = positional(args);
  if (!peer || !file) throw new Error('Usage: send-file <peer> <path> [--caption <text>]');
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`No such file: ${abs}`);
  await withClient(async client => {
    const sent = await client.sendMedia(coercePeer(peer), {
      type: 'document',
      file: fs.createReadStream(abs),
      fileName: path.basename(abs),
      caption: typeof opts.caption === 'string' ? opts.caption : undefined,
    });
    log(`Sent ${path.basename(abs)} to ${peer} (message #${sent.id}).`);
  });
}

async function cmdMarkRead(args) {
  const peer = positional(args)[0];
  if (!peer) throw new Error('Usage: mark-read <peer>');
  await withClient(async client => {
    await client.readHistory(coercePeer(peer));
    log(`Marked ${peer} as read.`);
  });
}

async function cmdKillSession(args) {
  const hash = positional(args)[0];
  if (!hash) throw new Error('Usage: kill-session <hash>  (get the hash from "sessions")');
  if (hash === '0') throw new Error('Refusing to end the current session (hash 0). Use "logout" instead.');
  await withClient(async client => {
    await client.call({ _: 'account.resetAuthorization', hash: BigInt(hash) });
    log(`Ended session ${hash}.`);
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function coercePeer(peer) {
  if (/^-?\d+$/.test(peer)) return Number(peer);
  if (peer === 'me' || peer === 'self') return 'me';
  return peer;
}

function oneLine(s) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (process.env.TG_FULL === '1') return t;
  return t.length > 160 ? `${t.slice(0, 157)}…` : t;
}

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    if (!args[i].startsWith('--')) continue;
    const key = args[i].slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function positional(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith('--')) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------

const COMMANDS = {
  init: cmdInit,
  status: cmdStatus,
  login: cmdLogin,
  logout: cmdLogout,
  whoami: cmdWhoami,
  sessions: cmdSessions,
  dialogs: cmdDialogs,
  history: cmdHistory,
  search: cmdSearch,
  contacts: cmdContacts,
  resolve: cmdResolve,
  download: cmdDownload,
  send: cmdSend,
  'send-file': cmdSendFile,
  'mark-read': cmdMarkRead,
  'kill-session': cmdKillSession,
};

const HELP = `Usage: node tg.js <command> [args]

Setup
  status                                   configured? logged in? as whom?
  init --apiId <id> --apiHash <hash> --phone <+number>
  login [--code N] [--force]               sign in (code arrives in your Telegram app)
  logout                                   end this session on Telegram and delete it locally

Read
  whoami                                   the signed-in account
  sessions                                 every device signed in to the account
  dialogs [count] [--unread]               recent chats
  history <peer> [count]                   recent messages in a chat
  search <text> [--in <peer>] [--limit N]  search one chat, or all chats
  contacts [count]                         the address book
  resolve <peer>                           what a username, id or phone points to
  download <peer> <messageId> [dir]        save a message's file

Write (the agent asks before each one)
  send <peer> <text…> [--reply <id>]       send a text message
  send-file <peer> <path> [--caption <t>]  send a file
  mark-read <peer>                         mark a chat as read
  kill-session <hash>                      sign another device out

<peer> is @username, a numeric id, +phone, or "me" for Saved Messages.
Data directory: ${HOME} (override with TG_SKILL_HOME).`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') {
    log(HELP);
    return;
  }
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error(`Unknown command "${cmd}". Run "node tg.js help".`);
    process.exit(2);
  }
  await fn(rest);
}

main().catch(err => {
  console.error(`[tg] ${err && err.message ? err.message : err}`);
  process.exit(1);
});
