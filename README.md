![pi-rio logo](./logo.svg)

# pi-rio

**Keep thinking human. Know what your AI is actually doing while it works.**

[![npm](https://img.shields.io/npm/v/pi-rio?style=flat-square&color=2DD4BF&label=npm)](https://www.npmjs.com/package/pi-rio)
![Pi package](https://img.shields.io/badge/pi-package-38BDF8?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square)
![MIT License](https://img.shields.io/badge/license-MIT-64748B?style=flat-square)

---

Coding agents are great at running 30 tool calls in a row.

The problem is **what happens to you** while they work:

- Your terminal fills up with `read`, `grep`, `bash`, and `edit` calls.
- You can see *what* the agent clicked, not *why* it's doing it.
- So you either stare at raw logs trying to guess its plan—or you zone out, wait for the final answer, and **hand over the thinking**.

**`pi-rio` brings the thinking back to the human.**

While your main agent codes, `pi-rio` puts a tiny, cheap model beside it to narrate the work in plain language—live, above your prompt:

- **What** it's trying to figure out right now
- **What hypothesis** it's testing
- **What** worked, what got ruled out, and **when it changed direction**
- **Why** it edited each file
- **When** it's stuck going in circles

You stay in the loop. You keep the mental model of your codebase. You stay the pilot.

> *Why the name **RIO**?* In a fighter jet, the Radar Intercept Officer sits in the backseat watching the scope so the pilot never flies blind.

---

## What it looks like

![pi-rio live HUD and fullscreen reasoning overlay preview](./assets/preview.svg)

### Before vs. After

| Raw agent logs | What `pi-rio` tells you |
|---|---|
| `read refreshClient.ts` → `read tokenStore.ts` → `bash vitest` → `edit tokenStore.ts` | `✓` Found the retry path → `✗` Mutex wasn't the bug (clock skew) → `▶` Adding a 60s expiry buffer |
| Dead ends disappear into scrollback | Ruled-out ideas are clearly marked `✗` with the reason |
| Diffs show changed lines, not intent | Every edited file shows `(+added/-removed)` plus a one-line **why** |
| Hard to notice an agent stuck retrying | Surfaces a `⚠` warning when it repeats the same mistake |

---

## Quick Start

Install in Pi:

```bash
pi install git:github.com/JJack27/pi-rio
```

*(Or try it for one session without saving to settings: `pi -e git:github.com/JJack27/pi-rio`)*

It works right away—by default, `pi-rio` automatically picks the cheapest fast model available in your Pi setup, writes in English, and uses balanced detail.

You can adjust anything mid-session:

```text
/rio model openai/gpt-4.1-mini   # pick your default sidecar model (or "auto")
/rio lang en                     # switch output language (en, zh, ja, ko, es, auto...)
/rio detail high                 # choose how much detail to show (low | medium | high)
```

Press **`Ctrl+Shift+I`** anytime to open the full interactive trail and inspect earlier steps or past requests in the session.

---

## Choose how much detail you want

Not every task needs the same level of detail. `pi-rio` ships with **three separate prompts and views**—switch anytime with `/rio detail <low|medium|high>`:

| Level | Best for | What you see |
|---|---|---|
| **`low`** | Quick glance, lowest cost | Just the major milestones and final outcomes—minimal noise. |
| **`medium`** *(default)* | Everyday coding | Current step, active hypothesis, pivots (`✗`), verdicts (`✓`), and why each file changed. |
| **`high`** | Tricky bugs & deep reviews | Full play-by-play with specific symbols/functions, **concrete evidence** from code or errors, and the **next planned move**. |

---

## Commands & Shortcuts

### Slash commands

| Command | Aliases | What it does |
|---|---|---|
| `/rio` | — | Open the full interactive trail overlay |
| `/rio model [provider/id \| auto]` | — | Show or switch the default cheap model (Tab-completes available models) |
| `/rio lang [en \| zh \| auto \| code]` | `/rio language` | Switch output language (`en` & `zh` also localize UI labels; `auto` follows your system locale) |
| `/rio detail [low \| medium \| high]` | `/rio level`, `/rio granularity` | Switch prompt & display detail level |
| `/rio toggle` | `/rio on`, `/rio off` | Pause or resume live narration |
| `/rio status` | `/rio debug` | Show active model, language, detail level, call count, tokens, cost, and latency |
| `/rio clear` | — | Clear the current trail |

### Shortcuts & Overlay keys

| Key | Action |
|---|---|
| `Ctrl+Shift+I` | Open the fullscreen trail overlay |
| `↑` / `↓` or `k` / `j` | Move between steps |
| `Enter` / `Space` | Expand or collapse the tool calls behind a step |
| `a` | Expand or collapse all steps |
| `←` / `→` or `h` / `l` or `[` / `]` | Flip through earlier requests in this session |
| `Esc` / `q` | Close overlay |

---

## Fast, cheap, and out of your way

- **Never slows down your main agent.** All sidecar calls run asynchronously in the background—your main model never waits on `pi-rio`.
- **Instant feedback.** Tool status (`⋯` / `✓` / `✗`) and file line diffs update locally at 0ms while the sidecar summarizes the *why* in parallel.
- **Pennies per session.** Uses minimal reasoning on a cheap model, skips pure chitchat turns, and merges bursts of read-only steps—while never dropping why a file was edited.
- **Works with `/tree`.** Snapshots are saved to your Pi session branch, so jumping between branches restores the right trail.

---

## Configuration

Settings are saved at `~/.pi/agent/rio.json` and updated automatically when you run `/rio` commands:

```json
{
  "enabled": true,
  "provider": "",
  "modelId": "auto",
  "language": "en",
  "detail": "medium",
  "showWidgetWhenIdle": true
}
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Turn live narration on or off |
| `provider` | `""` | Provider name (left empty when `modelId` is `"auto"`) |
| `modelId` | `"auto"` | Model ID, or `"auto"` to pick the fastest cheap available model |
| `language` | `"en"` | `"en"`, `"zh"`, `"auto"`, or any language code/name (`"ja"`, `"ko"`, `"es"`, `"fr"`, `"de"`, ...) |
| `detail` | `"medium"` | `"low"`, `"medium"`, or `"high"` |
| `showWidgetWhenIdle` | `true` | Keep the summary visible above the editor after a run finishes |

---

## Live JSON Feed

Want to build an external status bar or multi-agent dashboard? `pi-rio` atomically writes each active session to:

```text
~/.pi/agent/rio-live/<sessionId>.json
```

Each file contains `sessionId`, `cwd`, `projectName`, `detail`, `language`, `alive`, `stats`, and the full reasoning tree. Stale dead files older than 24 hours are cleaned up automatically.

---

## Development

```bash
npm install
npm test
npm run typecheck
```

---

MIT License · Built for [Pi](https://pi.dev)
