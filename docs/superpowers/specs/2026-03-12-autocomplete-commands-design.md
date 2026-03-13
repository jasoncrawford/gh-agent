# Autocomplete for Commands — Design Spec

**Date:** 2026-03-12
**Issue:** #10

---

## Problem

The REPL prompt accepts slash commands (`/exit`, `/clear`, and file-based commands from `~/.claude/commands/`). There is no discovery mechanism — users must know command names in advance.

## Goal

When a user types `/` at the REPL prompt, show available commands. Narrow the list as they type. Allow Tab to complete and Enter to complete-and-submit.

---

## Behaviour

- **Trigger:** Buffer starts with `/` and `buffer.slice(1)` contains no space (i.e. the user has not yet typed a space after the command token). Once the user types `/exit foo`, suggestions are hidden since arguments have begun.
- **Display:** One line below the input prompt, showing up to 3 matching command names in darkGray, formatted as `  /exit  /clear  /brainstorm`
- **Narrowing:** Re-computed and redrawn after every character insertion or deletion
- **Clearing:** Suggestions disappear when the buffer no longer triggers the condition above (e.g. after `^U` kills the whole buffer and the user types non-slash text)
- **Tab:** Replaces the current buffer with `/first-match` (no submit). If no suggestions, no-op.
- **Enter (`\r` or `\n`):** If suggestions are shown (`matches.length > 0`), replaces buffer with `/first-match` then submits. If no suggestions, submits normally. Both `\r` and `\n` follow the same path.
- **No arrow-key navigation** (may be added later if needed)

### Known terminal limitation

When `refreshSuggestions` is called for the first time on a fresh prompt (and the input line is at the very bottom of the terminal), the `\r\n` that moves to the suggestion line will scroll the terminal up by one row. This is an expected, one-time scroll per prompt — it is unavoidable without using the alternate screen buffer. Subsequent suggestion updates do not cause further scrolling.

---

## Architecture

### New pure functions (all exported, all unit-tested)

#### `listCommandNames(listDir?: ListDir): string[]`

```typescript
type ListDir = (dir: string) => Array<{ name: string; isDir: boolean }> | null;
```

Returns the full sorted list of available command names, combining built-ins and file-based commands.

- Built-ins are always: `["clear", "exit"]`
- File-based commands come from recursively walking `~/.claude/commands/`:
  - `listDir` is a **single-directory lister** (returns entries for one directory). `listCommandNames` calls it once for the base commands directory, then again for each subdirectory discovered, driving the recursion itself.
  - No maximum depth is enforced — the directory structure is user-controlled and expected to be small. Symlink cycles are not guarded against.
  - `brainstorm.md` → `"brainstorm"`
  - `foo/bar.md` → `"foo:bar"` (subdirectory names become colon-separated prefixes)
  - Only `.md` files are included; other files and non-directory entries are ignored
- **Error handling is internal to `listCommandNames`:** if `listDir` returns `null` or throws for a given directory, that directory is skipped. Built-ins are always returned.
- Result is deduplicated (e.g. if `clear.md` exists as a file, `"clear"` still appears only once) and sorted alphabetically

#### `matchCommands(prefix: string, commands: string[]): string[]`

Filters `commands` to those that start with `prefix` (case-sensitive). Returns filtered list in original order (already sorted). If `prefix` is empty, returns all commands.

---

### Modified `ask(promptStr, getCommands?)`

Signature change: add optional `getCommands?: () => string[]` parameter.

- When omitted, defaults to `() => listCommandNames()`
- Commands are fetched **once per `ask()` call** (one filesystem scan per REPL prompt, not once per session — this is intentional so that new command files added during a session are visible at the next prompt)
- The `getCommands()` call happens at the start of `ask()` inside a `try/catch`; any error from the `getCommands` function itself (not errors inside `listCommandNames`, which are handled internally) results in an empty extra-commands list; built-ins are still available from the internal `listCommandNames` error handling. The two layers are distinct: `try/catch` in `ask()` catches errors from custom injected stubs; `listCommandNames` catches filesystem errors internally.
- **All `ask()` tests — both existing and new — must supply an explicit `getCommands` stub.** Existing tests in `repl.input.test.ts` must be updated to pass `getCommands: () => []` (or similar) to avoid real filesystem I/O and ensure isolation. The default `() => listCommandNames()` is for production use only.

**New internal state:**
- `suggestionsShown: boolean` — whether the suggestion line is currently drawn below the prompt

**Terminal cursor positioning rule:** All escape sequences that move left or right by N must **skip the entire `write` call when N === 0**, because `\x1b[0C`/`\x1b[0D` are terminal-dependent and may move by 1 on some terminals. This applies to every cursor-movement write in the closures below.

**New internal closures:**

`computeMatches() → string[]`
- If `!buffer.startsWith("/")`, returns `[]`
- If `buffer.slice(1).includes(" ")`, returns `[]` (space after token means user is typing arguments)
- Extracts the prefix: `const prefix = buffer.slice(1).split(/\s+/)[0]` (when buffer is exactly `/`, prefix is `""` and all commands are returned — this is the intended trigger state)
- Returns `matchCommands(prefix, commands).slice(0, 3)`

`refreshSuggestions()`
- Calls `const matches = computeMatches()` once; uses this result throughout
- **Move to end of input:** if `buffer.length > cursor`, write `\x1b[${buffer.length - cursor}C`. Skip write entirely if `buffer.length === cursor`. (After `^K`, cursor is unchanged at its current position — `buffer.length` is the new, shorter length, so this move may be a no-op or a backward-effective step. Since `^K` only kills forward, cursor ≤ buffer.length always holds after `^K`.)
- **Go to suggestion line:** write `"\r\n\x1b[K"` (moves to column 0, down one line, erases line)
- **Draw suggestions:** if `matches.length > 0`, write `c.darkGray("  " + matches.map(m => "/" + m).join("  "))`
- **Return to input line:** write `"\x1b[A"` (cursor-up; horizontal position is now indeterminate)
- **Restore cursor:** write `"\r"` (column 0), then if `promptStr.length + cursor > 0` write `\x1b[${promptStr.length + cursor}C`. Skip second write if value is 0.
- Updates `suggestionsShown = matches.length > 0`

`clearSuggestions()`
- If `!suggestionsShown`, return immediately (guard prevents emitting spurious escape sequences on cold path and after suggestions have already been hidden)
- Uses the same move-to-end → `\r\n\x1b[K` → `\x1b[A` → restore-cursor sequence as `refreshSuggestions` (same n=0 guards apply)
- Sets `suggestionsShown = false`
- **Interaction with `submit()`:** after `clearSuggestions()` returns, the cursor is on the input line. The existing `submit()` then writes `"\r\n"`, advancing to what was the suggestion line (now cleared). This is correct.

`replaceBuffer(newText: string)`
- **Move to buffer start:** if `cursor > 0`, write `\x1b[${cursor}D`. Skip write entirely if `cursor === 0`.
- Write `newText + "\x1b[K"` to overwrite and clear trailing chars
- Sets `buffer = newText`, `cursor = newText.length`

**Modified `processTyped` — new and changed branches:**

Insert a Tab branch **before** the existing `else if (code >= 32)` guard (Tab is char code 9, below 32, so without this branch it would be silently ignored):

1. **Tab (`\x09`)** — new branch:
   ```
   const matches = computeMatches();
   if (matches.length > 0) { replaceBuffer("/" + matches[0]); refreshSuggestions(); }
   // else: no-op
   ```

2. **Enter (`\r` / `\n`)** — modify existing `if (ch === "\r" || ch === "\n")` handler:
   ```
   const matches = computeMatches();
   if (matches.length > 0) { replaceBuffer("/" + matches[0]); }
   clearSuggestions();
   submit(buffer);
   return;
   ```

3. **Call `refreshSuggestions()` after** each of these operations (immediately after the existing terminal output for that operation):
   - `insert(ch)`, `deleteBack()`, `killToEnd()`, `killToStart()`, `deleteWord()`, `insertPaste(str)`

Cursor-movement operations (`moveTo`, `moveWordLeft`, `moveWordRight`) do **not** call `refreshSuggestions` (buffer unchanged).

---

## Testing

### Unit tests (no stdin faking needed)

**`matchCommands`:**
- Prefix filtering: `matchCommands("ex", ["clear","exit"])` → `["exit"]`
- Empty prefix returns all: `matchCommands("", ["clear","exit"])` → `["clear","exit"]`
- No matches: `matchCommands("zzz", ["clear","exit"])` → `[]`
- Case-sensitive: `matchCommands("Ex", ["clear","exit"])` → `[]`

**`listCommandNames`:**
- Built-ins always present even with empty/null directory
- File in root: `brainstorm.md` → `"brainstorm"` in result
- File in subdirectory: `foo/bar.md` → `"foo:bar"` in result
- Multiple nesting levels: `a/b/c.md` → `"a:b:c"` in result
- Deduplication: built-in `"clear"` + file `clear.md` → `"clear"` appears exactly once
- Graceful on missing dir (`listDir` returns `null`): returns built-ins only
- Result is sorted alphabetically

### Integration tests

All integration tests use `withFakeStdin` and a mocked `process.stdout.write`, and **all pass `getCommands: () => ["brainstorm", "clear", "exit"]` (or similar stub)** — no test uses the default.

All existing tests in `repl.input.test.ts` must be updated to pass `getCommands: () => []` (since they test non-slash input and don't need command data).

New tests:

- **Tab with no suggestions:** type `hello` (non-slash), press Tab; buffer unchanged, no escape sequences emitted
- **Tab with one match:** type `/ex`, press Tab; buffer becomes `/exit`, cursor at end
- **Tab with multiple matches:** type `/`, press Tab; buffer becomes `/brainstorm` (first alphabetically in stub)
- **Tab with cursor not at end:** type `/ex`, move cursor left, press Tab; buffer becomes `/exit`, cursor at end
- **Enter with suggestions:** type `/ex`, press Enter; first match completed, input submitted
- **Enter with `\n` also works:** same as above but send `\n` instead of `\r`
- **Enter without suggestions (non-slash input):** type `hello`, press Enter; submits as-is
- **Enter on slash with no matching commands:** type `/zzz`, press Enter; submits `/zzz` as-is (no completion), `clearSuggestions` guard fires without emitting escapes
- **Submit without ever showing suggestions:** press Enter on empty input; verify `clearSuggestions` guard fires silently
- **Suggestions appear on `/`:** type `/`; stdout mock shows darkGray suggestion line
- **Suggestions narrow:** type `/ex`; stdout mock shows only `/exit` in suggestion line
- **Suggestions hidden after suggestions shown (guard works):** type `/ex` (suggestions shown), type ` ` (space); verify no suggestion line in subsequent stdout; verify a second space press also emits no suggestion-clearing escapes (guard on cold path)
- **Suggestions hide on space:** type `/exit ` (with space); suggestion line cleared
- **Suggestions hide on non-slash buffer:** type `/exit`, then `^U`, then `h`; suggestions do not appear
- **`^K` partial command:** type `/exit`, move cursor to position 1 (after `/`), press `^K`; buffer is now `/`; suggestions reappear showing all commands
- **Paste triggering autocomplete:** paste `/ex` via bracketed paste; suggestions appear; verify cursor position is correct after redraw (cursor at end of `/ex`)
- **Paste at non-end cursor:** type `ab`, move cursor left, paste `/ex`; buffer is `a/exb`; no suggestions (does not start with `/`); no escapes emitted
