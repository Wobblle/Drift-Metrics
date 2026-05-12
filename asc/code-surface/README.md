# asc/code-surface — the .txt drop convention

Per ASC v0.2 §9. Four lines, plain text, hosted as a static file at
`/c/<CODE>.txt` on the issuing product's domain.

```
CODE: <canonical code string>
URL:  <full https URL with ?code= param to a product page that consumes it>
LORE: <one sentence of brand voice. no marketing.>
ASC:  v<spec version> / <prefix> / <category>
```

## Rules

- Four lines. Never five. Never three.
- Plain ASCII (or UTF-8, but keep it boring).
- The `URL` line uses the FULL https URL. No shorteners. The drift-
  metrics.com / thevibez.com / skyscaffold domains are short enough.
- The `LORE` line is the only piece of voice. One sentence. Tonally
  honest. Asleepius brand: abrasive, lightweight, indie. No emojis.
  No exclamation marks. No "click here."
- The `ASC` line is the version-and-classification stamp so a future
  ASC v0.3 reader knows what spec the file was minted under.

## Hosting

- Static file under `/c/` at the issuing product's domain.
- No service. No analytics. No tracking pixels.
- Anyone with the URL gets the code. Anyone with the code gets the
  access. Possession-based, not identity-based (per ASC §4 rule 5).

## Examples

`EXAMPLE.txt` in this folder is the canonical reference. When you mint
a new code that's meant to be distributed with a code-surface artifact,
write the artifact in this format and host it at
`https://<your-domain>/c/<CODE>.txt`.

The terminal output for `> drop <CODE>` (when products gain the ability
to mint codes from inside themselves) MUST emit the URL of the artifact.
See ASC_SPEC §9 for the format.
