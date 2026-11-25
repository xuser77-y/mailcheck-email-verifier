# MailCheck — Email Verifier

Check a list of email addresses against their **real mail servers** and find
out which mailboxes actually exist — before you send anything.

No email is ever sent. The check opens a connection to the domain's mail
server, asks "do you accept mail for this address?" (`RCPT TO`) and hangs up
before the message itself (`DATA`). This is the same technique paid tools like
Hunter and NeverBounce use.

## What it checks, per address

1. **Syntax** — is it even a valid address?
2. **Disposable** — is it a temporary inbox (Mailinator, Guerrilla Mail, …)?
3. **Mail server (MX)** — does the domain have a mail server at all?
4. **Catch-all probe** — does the domain accept *every* address? If yes, the
   mailbox can't be confirmed and the result is **risky**, not valid.
5. **Mailbox probe** — `RCPT TO` against the mail server:
   `250` = exists, `550` = doesn't exist, `4xx` = temporarily refused
   (greylisting — retried once, then marked unknown).

## Results

| Status | Meaning |
|---|---|
| `valid` | Mailbox confirmed by the mail server |
| `invalid` | Rejected, or the domain has no mail server |
| `risky` | Catch-all domain — the mailbox can't be confirmed |
| `unknown` | Mail server unreachable, greylisted or timed out |
| `disposable` | Temporary / throwaway provider |

The results page shows **totals, success rate (valid / total), deliverable
rate (valid + risky / total), a per-domain breakdown with valid rates, and a
plain-English analysis** of what to do with the list. Export in **CSV, JSON
or plain text**, filtered to all / valid / invalid / risky / unknown /
disposable.

## Run it

```bash
node server.js
# open http://localhost:3000
```

No install step — zero dependencies, Node 18+ only. `PORT` env var changes
the port.

Upload a `.txt` / `.csv` file or paste addresses, set the options, hit
**Verify list**. Up to 10,000 addresses per run; duplicates are removed
automatically.

## Changing the outgoing IP (proxy)

**Auto mode (recommended):** tick **"Auto mode — find free proxies and
rotate automatically"** in the Outgoing IP section and just press Verify.
MailCheck fetches a fresh free SOCKS5 list, tests each proxy against a real
mail server on port 25, keeps the ones that answer, and verifies through
that pool. When a proxy stops answering (they get flagged fast — one IP
probing many mailboxes looks like spam), the run rotates to the next proxy
by itself. No searching, no copy-paste.

**Manual mode:** by default the mailbox probes go out from this machine's IP. Some mail
servers throttle or block residential / datacentre IPs, which shows up as a
lot of `unknown` results. In the **Outgoing IP** section you can route the
probes through a **SOCKS5 proxy** (host, port, optional username/password) —
the mail server then sees the proxy's IP instead. The proxy is used only for
the mailbox probes, nothing else.

You can also change the **HELO hostname** and **MAIL FROM** address the tool
announces to mail servers, plus concurrency (1–20 checks at once) and the
per-check timeout.

## API

```
POST /api/verify
{ "emails": ["a@x.com", "b@y.com"], "options": { "concurrency": 5, "timeoutMs": 12000, "helo": "mailcheck.local", "mailFrom": "verify@mailcheck.local", "proxy": { "host": "1.2.3.4", "port": 1080 } } }
```
Streams NDJSON: one `{"type":"result","result":{...}}` per address, then
`{"type":"done","summary":{...}}` with totals, rates and the domain breakdown.

```
GET /api/health   -> {"ok":true}
```

## Tests

```bash
npm test
```

Runs the verifier against a local mock SMTP server (valid / invalid /
catch-all / greylist / timeout cases) and through a local mock SOCKS5 proxy,
so the whole pipeline is checked without touching the internet.

## Honest limits

- **Blocked SMTP:** some environments (the Muse sandbox included) block
  outbound port 25 entirely. On those machines every live probe comes back
  `unknown` with a clear message saying SMTP is blocked — syntax, disposable
  and domain-existence checks still work, but the mailbox probe needs a
  machine that allows port 25: your own laptop, or a VPS. That is where this
  tool is meant to run.
- Gmail, Yahoo and Outlook sometimes block mailbox probes or answer `unknown`
  for addresses that exist — no verifier is 100% on the big free providers.
  A second run later, or from a different IP / proxy, often resolves those.
- A `valid` result means the server *accepted* the address at probe time.
  It is not a guarantee the person reads the inbox.
- Only use this on lists you collected legitimately (your own leads, public
  business addresses). Don't use it to spam.
