Write comprehensive tests for the following GitHub issue, following TDD principles.

Issue #{{issue_number}}:
{{issue_body}}

## Before writing tests

Read the existing test directories to understand the project's patterns and conventions. Do not assume — actually open the files and read them. Your tests should look like they belong to this codebase, not like they were parachuted in from elsewhere. Pay attention to how assertions are written, how fixtures are set up, how async code is tested, and how WebSocket events are exercised.

## Choosing the test file path

Decide the correct path based on what is being tested:

- Game logic (rules, scoring, bidding, trick resolution, hand validation) → `test/unit/game/`
- HTTP API routes and controllers → `test/integration/`
- WebSocket events and real-time flows → `test/integration/`
- Anything that crosses the network or database boundary → `test/integration/`

If the issue touches multiple layers, prefer one test file per layer over cramming everything into one file.

## Test style

- Use Node's built-in test runner: `node:test` and `node:assert`. Do not introduce Jest, Mocha, Vitest, or any other test framework. If you find yourself wanting one, that's a signal to re-read existing tests — the patterns you need are already in the codebase.
- Each test must be independent. No shared mutable state between tests. No ordering dependencies.
- Cover both happy paths and edge cases. For game logic specifically, edge cases include: empty hands, illegal plays, simultaneous bids, disconnections mid-trick, and the transition between hands.
- Prefer small, focused tests over large end-to-end scenarios. One behavior per test.
- Test names should describe the behavior, not the implementation. `"rejects a bid of zero when partner has nil"` is good; `"test_bid_validation"` is not.

## Spades-specific reminders

- Spades has partnerships: tests involving scoring, bidding, or winning conditions must account for partnership totals, not just individual player state.
- Bags (overtricks) carry over across hands and trigger penalties at thresholds — make sure tests that touch scoring consider bag state.
- A nil bid has different success/failure conditions than a regular bid. Tests around nil should be explicit about which is being exercised.
- The game uses a standard 52-card deck with spades as the permanent trump. Don't write tests that assume configurable trump suits.

## Writing the file

Use the Edit tool to write the test file to disk at the path you chose. Do not run the tests yourself — the coder agent will run them when it implements the code they're testing.
