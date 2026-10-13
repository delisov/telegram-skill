# telegram

**A Claude Code skill that works with your own Telegram account: read and search your chats, reply, send files, and check which devices are signed in.**

```
/telegram summarize my unread chats
/telegram what did @alice say about the contract last week?
/telegram send @bob: running 10 minutes late
/telegram which devices are signed in to my account?
```

Claude reads freely and asks before every action that changes something. Before each message it shows you the recipient and the exact text and waits for your yes.

## What it can do

| Read | Write (asks first) |
|---|---|
| List recent chats, or only unread ones | Send a message, or reply to a specific one |
| Read a chat's recent messages | Send a file with a caption |
| Search one chat, or all chats at once | Mark a chat as read |
| List contacts | Sign another device out of the account |
| Resolve a username, id or phone number | Sign this tool out |
| Download a file or photo from a message | |
| List every device signed in to the account | |

It talks to Telegram directly through [mtcute](https://github.com/mtcute/mtcute), a full Telegram client library. No bot, no third-party server, no proxy: the session lives on your computer.

## Install

Requires Node.js 20 or newer.

```bash
git clone https://github.com/delisov/telegram-skill ~/.claude/skills/telegram
cd ~/.claude/skills/telegram/scripts && npm ci
```

To scope it to one project instead, clone into `<project>/.claude/skills/telegram`.

## First run

Type `/telegram` with any request. Claude walks you through two one-time steps:

1. **An API id and hash.** Open [my.telegram.org](https://my.telegram.org), sign in, choose **API development tools**, and create an application with any name. Give Claude the `api_id` and `api_hash`. They identify the app, not your account.
2. **A login code.** Telegram sends it to your Telegram app. Paste it into the chat. If your account has two-step verification, Claude asks you to put the password into a local file yourself, so it never appears in the conversation. The file is deleted as soon as sign-in ends.

After that, every command works without a code.

## Where your data lives

- The session, the config and nothing else are kept in `~/.telegram-skill` (change it with `TG_SKILL_HOME`), outside this repository. The session file is a full credential for your account; the skill tells Claude never to read, print or copy it.
- Messages are read on demand and are not stored. They do pass through Claude's context when you ask about them, like anything else you show Claude.
- Each command connects, does its work, and disconnects. Nothing stays running.
- To stop using it, run `/telegram log out`, or end the session from Telegram's **Settings → Devices**.

## Use it with care

This is an unofficial client acting on a personal account. Telegram can restrict accounts that behave like automation. The skill keeps reads small, never sends bulk messages, stops on `FLOOD_WAIT`, and asks before every write. Do not point it at an account you cannot afford to lose access to.

## Use without Claude

The helper is an ordinary command-line tool:

```bash
cd ~/.claude/skills/telegram/scripts
node tg.js help
node tg.js dialogs 10 --unread
node tg.js search invoice --in @accounting --limit 5
```

## Files

```
SKILL.md        instructions Claude follows
scripts/tg.js   the command-line client
scripts/package.json, package-lock.json
```

## Author

Dmitriy Elisov — [LinkedIn](https://www.linkedin.com/in/dmitry-elisov/) · [GitHub](https://github.com/delisov)

Issues and suggestions: [github.com/delisov/telegram-skill/issues](https://github.com/delisov/telegram-skill/issues)

## License

[MIT](LICENSE)
