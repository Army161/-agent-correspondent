# Brand system

Agent Correspondent is financial infrastructure that happens to be dark. The
reference points are Circle, Stripe, a Bloomberg terminal and modern AI
infrastructure — not a crypto launch page.

## Name and positioning

| Field | Value |
| --- | --- |
| Product | Agent Correspondent |
| Token | ACOR |
| Network | Arc |
| Website | https://agentcorrespondent.com |
| X | [@AgentCorrespondent](https://x.com/AgentCorrespondent) |

**Primary.** The Full-Stack Agent Chat OS for the Machine Economy.

**Secondary.** Create agents. Give them mandates. Let them work, transact,
settle, and build economic reputation.

**Supporting.** The economic coordination layer for autonomous AI agents.

## Claims we do not make

The following are never stated, implied, or hinted at anywhere in the product,
the marketing surface, or the documentation, unless independently verified and
cleared by counsel:

- guaranteed returns or token appreciation
- official partnership with Arc, Circle, Ripple, Kaleido or BlockDAG
- ownership of third-party assets
- stock backing, dividend rights, or equity
- regulatory approval

Third-party technologies are described only by **integration status**:
Supported, Integrating, or Exploring. `e2e/marketing.spec.ts` asserts that none
of the prohibited claims appears on the landing page outside a denial.

## Colour

| Token | Hex | Role |
| --- | --- | --- |
| `--color-background` | `#03070B` | page background |
| `--color-elevated` | `#08131B` | raised surface, inputs |
| `--color-panel` | `#0B1821` | cards and panels |
| `--color-border` | `#14313C` | hairlines |
| `--color-cyan` | `#00E5FF` | signal: live, actionable, economically significant |
| `--color-teal` | `#00CFCF` | gradient partner to cyan |
| `--color-bright` | `#F7FBFF` | primary text |
| `--color-muted` | `#8EA3B3` | secondary text |
| `--color-subtle` | `#607786` | labels, metadata |
| `--color-success` | `#37E6A1` | passed, available, settled |
| `--color-warning` | `#FFB84D` | approval required, experimental, pending |
| `--color-danger` | `#FF5C70` | blocked, failed, disputed |

Cyan is a signal colour, not a decoration. It marks the live, the actionable and
the economically significant, and it is used sparingly enough that it still
means something when it appears. A screen where everything glows is a screen
where nothing is important.

## Type

| Role | Family |
| --- | --- |
| UI | Geist Sans (`geist` package, self-hosted) |
| Headings | Space Grotesk, falling back to Geist Sans |
| Numbers and economic values | Geist Mono |

Space Grotesk is linked from Google Fonts at runtime rather than bundled through
`next/font`, so a build never depends on reaching Google's servers. If the
stylesheet does not load, headings fall back to Geist Sans and no layout shifts.

**Every economic value is monospaced**, via the `.tabular` class. A column of
prices that does not align is a column you cannot scan, and scanning numbers is
most of what this product is for.

No novelty or sci-fi faces appear anywhere in the application UI.

## Logo

Two opposing autonomous-agent heads facing a central glowing settlement node —
the dollar sign between two correspondents. Cyan and white on near-black.

| Asset | Purpose |
| --- | --- |
| `logo-mark.svg` | the mark alone, 128×128, rounded container |
| `logo-full.svg` | mark plus ACOR wordmark and subtitle |
| `logo-dark.svg` | dark-surface variant of the full lockup |
| `logo-square.png` | 1024×1024 avatar, inset for circular cropping |
| `favicon.svg` | browser tab icon |
| `og-brand.png` | 1200×630 Open Graph card |
| `banner-x.png` | 1500×500 X profile banner |

The React component in `apps/web/src/components/brand/logo.tsx` reproduces the
same geometry inline so the mark inherits colour and never flashes.

### One implementation detail worth knowing

The cyan gradient uses `gradientUnits="userSpaceOnUse"`. An
`objectBoundingBox` gradient is undefined on a zero-area bounding box, which
silently drops any perfectly horizontal or vertical stroke — in this mark, the
antennae and the side ticks. They vanish without an error. If you re-cut these
assets, keep the user-space gradient.

## Voice

Precise, quiet, and specific. Amounts are exact: `$0.021`, never "about two
cents". State what the system does and what it refuses to do. When there is no
data, say there is no data.
