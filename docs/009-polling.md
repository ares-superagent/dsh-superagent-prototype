# 009 Polling

The GitHub Source keeps two cadences, so a request reaches the main Session quickly without polling the notification endpoint faster than GitHub allows.

A **full round** reads the agent account's notifications, the default-branch CI and the subscribed Threads, then waits `pollSeconds` (at least 60, the interval GitHub asks for notifications) before the next one. Between full rounds, the **repository streams** — new Issues and pull requests, conversation comments and review comments — are read every 10 seconds. Most requests arrive as a comment on an existing Issue, so such a request is seen within that window instead of waiting for the next notification round.

## Why

Before this split, every trigger waited for the next full round. A round itself took about ten seconds, because its `gh api` reads run one after another, and the wait after a round is at least 60 seconds. A comment could therefore wait about 70 seconds before the Source even handed it to the main Session for assessment; that wait was the largest fixed part of the time from a request to its acknowledgement.

## How

`watch()` in `src/sources/github.ts` calls `pollRound()` for a full round and `pollStreams()` for the stream polls between rounds. `STREAM_POLL_MS` sets the stream cadence; the full round keeps the existing `pollSeconds` setting and GitHub's `X-Poll-Interval`.

Each stream keeps its cursor and the ETag of its last page (see `readStream()`). While nothing is newer, the next request sends `If-None-Match` and GitHub answers `304 Not Modified`, which does not count against the rate limit. A quiet stream therefore costs one conditional request per tick, and three streams at this cadence stay far below the hourly limit. The notification reads, the default-branch CI and the subscribed Threads keep running at `pollSeconds`.

A failed stream poll counts toward `failuresBeforeError` and fails only that poll; the next full round reports ready again. Only a full round clears the consecutive-failure count, so a stream failure cannot hide a broken notification read. A failed poll is followed by a full interval before the next attempt, as before.

## Tuning

`STREAM_POLL_MS` is the one constant to change for a different trade-off between detection latency and the number of conditional requests. A deployment that observes no repository Issues, pull requests or comments does not poll the streams between rounds at all.
