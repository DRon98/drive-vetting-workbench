const depthStyles = Array.from(
  { length: 17 },
  (_, depth) =>
    `.tree-node.depth-${depth} { margin-inline-start: calc(${depth} * var(--tree-indent)); }`,
).join("\n");

export const REVIEW_STYLES = `
:root {
  color-scheme: light;
  --paper: oklch(97.5% 0.006 115);
  --surface: oklch(99.7% 0.002 115);
  --ink: oklch(20% 0.014 175);
  --muted: oklch(35% 0.018 165);
  --faint: oklch(45% 0.012 160);
  --hairline: oklch(82% 0.012 125);
  --rule: oklch(28% 0.018 170);
  --green: oklch(43% 0.096 166);
  --green-dark: oklch(34% 0.082 166);
  --lime: oklch(91% 0.055 118);
  --mint: oklch(93% 0.036 163);
  --rose: oklch(91% 0.035 25);
  --amber: oklch(87% 0.065 78);
  --blue: oklch(89% 0.035 235);
  --serif: Charter, "Bitstream Charter", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  --sans: "Avenir Next", Avenir, "Segoe UI", Helvetica, sans-serif;
  --mono: ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, monospace;
  --step--1: 0.8125rem;
  --step-0: 1rem;
  --step-1: 1.25rem;
  --step-2: 1.5625rem;
  --step-3: clamp(2rem, 3.8vw, 3.35rem);
  --step-4: clamp(3.2rem, 7vw, 5.8rem);
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.5rem;
  --space-6: 2rem;
  --space-7: 3rem;
  --space-8: clamp(4rem, 9vw, 7rem);
  --tree-indent: 2.15rem;
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
}

* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  color: var(--ink);
  background: var(--paper);
  font-family: var(--sans);
  font-size: var(--step-0);
  line-height: 1.62;
  text-rendering: optimizeLegibility;
}
button, input, select, textarea { font: inherit; }
button, a, input, select, summary, textarea { -webkit-tap-highlight-color: transparent; }
a { color: var(--green-dark); text-decoration-thickness: 0.08em; text-underline-offset: 0.18em; }
a:hover { color: var(--ink); }
code, kbd, pre, .mono { font-family: var(--mono); }
code { overflow-wrap: anywhere; }
::selection { color: var(--ink); background: var(--lime); }
[hidden] { display: none !important; }

.skip-link {
  position: fixed;
  z-index: 50;
  top: var(--space-4);
  left: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--ink);
  background: var(--surface);
  opacity: 0;
  pointer-events: none;
  transform: translateY(-180%);
}
.skip-link:focus { opacity: 1; pointer-events: auto; transform: none; }
.live-region {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  border: 0;
  clip-path: inset(50%);
  white-space: nowrap;
}

.masthead {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(18rem, auto);
  gap: var(--space-5);
  align-items: center;
  width: min(calc(100% - var(--space-6)), 92rem);
  margin: 0 auto;
  padding: var(--space-5) 0 var(--space-4);
  border-bottom: 1px solid var(--rule);
}
.brand { display: flex; gap: var(--space-3); align-items: center; min-width: 0; }
.brand .brand-mark {
  display: grid;
  flex: 0 0 2.8rem;
  width: 2.8rem;
  height: 2.8rem;
  place-items: center;
  color: #f7f5e9;
  background: #0f1816;
  font-family: var(--serif);
  font-size: var(--step-1);
  font-weight: 700;
}
.brand strong { display: block; font-family: var(--serif); font-size: var(--step-1); line-height: 1.05; }
.brand span { display: block; color: var(--muted); font-size: var(--step--1); }
.masthead-meta { color: var(--muted); font-family: var(--mono); font-size: var(--step--1); text-align: right; }
.masthead-meta strong { display: block; color: var(--ink); overflow-wrap: anywhere; }

.hero {
  display: grid;
  grid-template-columns: minmax(0, 2.15fr) minmax(17rem, 0.85fr);
  gap: clamp(2rem, 6vw, 6rem);
  align-items: end;
  width: min(calc(100% - var(--space-6)), 92rem);
  margin: 0 auto;
  padding: var(--space-8) 0 var(--space-7);
  border-bottom: 2px solid var(--ink);
}
.hero h1, .section-head h2, .hero-note strong, h3, h4 {
  margin: 0;
  font-family: var(--serif);
  font-weight: 700;
  line-height: 1.05;
  text-wrap: balance;
}
.hero h1 { max-width: 13ch; font-size: var(--step-4); letter-spacing: -0.035em; }
.hero h1 em { color: var(--green-dark); font-style: normal; }
.hero .lede { max-width: 64ch; margin: var(--space-5) 0 0; color: var(--muted); font-family: var(--serif); font-size: var(--step-1); line-height: 1.48; }
.hero-note { align-self: stretch; padding: var(--space-5) 0 0 var(--space-5); border-left: 1px solid var(--rule); }
.hero-note strong { display: block; max-width: 14ch; font-size: var(--step-2); }
.hero-note p { max-width: 34ch; margin: var(--space-3) 0 0; color: var(--muted); }
.formula { display: grid; gap: var(--space-2); margin-top: var(--space-5); color: var(--green-dark); font-family: var(--mono); font-size: var(--step--1); }

.facts {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  width: min(calc(100% - var(--space-6)), 92rem);
  margin: 0 auto;
  border-bottom: 1px solid var(--rule);
}
.fact { padding: var(--space-5) var(--space-5) var(--space-5) 0; }
.fact + .fact { padding-left: var(--space-5); border-left: 1px solid var(--hairline); }
.fact small { display: block; color: var(--muted); font-family: var(--mono); font-size: var(--step--1); }
.fact strong { display: block; margin-top: var(--space-2); font-family: var(--serif); font-size: var(--step-2); line-height: 1.05; }
.fact span { display: block; margin-top: var(--space-2); color: var(--muted); font-size: var(--step--1); }
.fact a { color: inherit; text-decoration: none; }
.fact a:hover strong, .fact a:focus-visible strong { color: var(--green-dark); }

.tab-shell { position: sticky; z-index: 30; top: 0; border-bottom: 1px solid var(--rule); background: var(--paper); }
.tabs { display: flex; width: min(calc(100% - var(--space-6)), 92rem); margin: 0 auto; overflow-x: auto; scrollbar-width: thin; }
.tab-button {
  position: relative;
  flex: 0 0 auto;
  min-height: 3.35rem;
  padding: 0 var(--space-4);
  border: 0;
  border-right: 1px solid var(--hairline);
  color: var(--muted);
  background: transparent;
  cursor: pointer;
  font-size: var(--step--1);
  font-weight: 650;
}
.tab-button:first-child { border-left: 1px solid var(--hairline); }
.tab-button::after { position: absolute; right: var(--space-4); bottom: -1px; left: var(--space-4); height: 3px; background: var(--green); content: ""; opacity: 0; transform: scaleX(0.5); transition: opacity 150ms ease, transform 220ms var(--ease-out); }
.tab-button:hover, .tab-button[aria-selected="true"] { color: var(--ink); background: var(--surface); }
.tab-button[aria-selected="true"]::after { opacity: 1; transform: scaleX(1); }

button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible, textarea:focus-visible {
  outline: 2px solid var(--green);
  outline-offset: 3px;
}

main { width: min(calc(100% - var(--space-6)), 92rem); margin: 0 auto; }
.tab-panel { display: none; padding: var(--space-7) 0 var(--space-8); }
.tab-panel.is-active { display: block; }
.section-head { display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(17rem, 0.75fr); gap: var(--space-7); align-items: start; margin-bottom: var(--space-7); }
.section-head h2 { max-width: 16ch; font-size: var(--step-3); letter-spacing: -0.025em; }
.section-head p { max-width: 67ch; margin: var(--space-4) 0 0; color: var(--muted); font-family: var(--serif); font-size: var(--step-1); line-height: 1.48; }
.sidenote { padding: var(--space-4) 0 var(--space-4) var(--space-5); border-left: 1px solid var(--rule); color: var(--muted); font-size: var(--step--1); }
.sidenote strong { display: block; margin-bottom: var(--space-2); color: var(--ink); font-family: var(--mono); font-size: var(--step--1); letter-spacing: 0.05em; }

.pill { display: inline-flex; gap: 0.35rem; align-items: center; padding: 0.14rem 0.62rem; border: 1px solid var(--pill-line, var(--rule)); border-radius: 999px; color: var(--pill-ink, var(--ink)); background: var(--pill-fill, var(--surface)); font-family: var(--mono); font-size: var(--step--1); font-weight: 650; letter-spacing: 0.04em; white-space: nowrap; }
.pill-blue { --pill-fill: color-mix(in oklch, var(--blue), transparent 25%); --pill-line: oklch(58% 0.07 240); --pill-ink: oklch(33% 0.06 240); }
.pill-lime { --pill-fill: color-mix(in oklch, var(--lime), transparent 20%); --pill-line: oklch(58% 0.08 122); --pill-ink: oklch(33% 0.07 130); }
.pill-amber { --pill-fill: color-mix(in oklch, var(--amber), transparent 25%); --pill-line: oklch(60% 0.09 72); --pill-ink: oklch(36% 0.08 60); }
.pill-mint { --pill-fill: color-mix(in oklch, var(--mint), transparent 18%); --pill-line: oklch(52% 0.07 166); --pill-ink: var(--green-dark); }
.pill-rose { --pill-fill: color-mix(in oklch, var(--rose), transparent 25%); --pill-line: oklch(58% 0.08 25); --pill-ink: oklch(36% 0.08 25); }
.pill-row { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }
.pill-row small { color: var(--muted); font-family: var(--mono); font-size: var(--step--1); }

.status { display: inline-flex; gap: var(--space-2); align-items: center; padding: 0.14rem 0.6rem; border: 1px solid oklch(52% 0.07 166); border-radius: 999px; color: var(--green-dark); background: color-mix(in oklch, var(--mint), transparent 18%); font-family: var(--mono); font-size: var(--step--1); font-weight: 650; }
.status::before { width: 0.48rem; height: 0.48rem; border-radius: 50%; background: var(--green); content: ""; }
.status.warn { border-color: oklch(60% 0.09 72); color: oklch(36% 0.08 60); background: color-mix(in oklch, var(--amber), transparent 25%); }
.status.warn::before { background: oklch(62% 0.14 66); }
.status.risk { border-color: oklch(58% 0.08 25); color: oklch(36% 0.08 25); background: color-mix(in oklch, var(--rose), transparent 25%); }
.status.risk::before { background: oklch(55% 0.14 25); }

.receipt-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-5); }
.receipt { padding: var(--space-5); border-top: 2px solid var(--ink); border-bottom: 1px solid var(--hairline); background: var(--surface); }
.receipt h3 { font-size: var(--step-1); }
.receipt p { color: var(--muted); }
.receipt code { display: block; margin-top: var(--space-3); color: var(--green-dark); }
details { color: var(--muted); }
summary { color: var(--green-dark); cursor: pointer; font-weight: 650; }

.figure-shell { border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); background: var(--surface); }
.figure-toolbar { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: center; padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--hairline); background: var(--paper); }
.figure-toolbar strong { margin-right: auto; font-family: var(--mono); font-size: var(--step--1); }
.figure-toolbar label { color: var(--muted); font-size: var(--step--1); }
.figure-toolbar select { min-height: 2.75rem; padding: 0 var(--space-6) 0 var(--space-3); border: 1px solid var(--rule); border-radius: 0; color: var(--ink); background: var(--surface); }
.figure-legend { padding: var(--space-3) var(--space-5); border-bottom: 1px solid var(--hairline); }
.map-layout { display: grid; grid-template-columns: minmax(22rem, 0.92fr) minmax(24rem, 1.08fr); min-height: 34rem; }
.drive-tree { margin: 0; padding: var(--space-5); border-right: 1px solid var(--hairline); list-style: none; overflow: hidden; }
.tree-node { position: relative; margin-bottom: var(--space-3); transition: opacity 150ms ease; }
${depthStyles}
.tree-node::before { position: absolute; top: 50%; right: calc(100% + 0.25rem); width: 1.4rem; border-top: 1px solid var(--hairline); content: ""; }
.tree-node.depth-0::before { display: none; }
.tree-node button { display: grid; width: 100%; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-3); align-items: center; padding: var(--space-3) var(--space-4); border: 1px solid var(--rule); border-left: 4px solid oklch(58% 0.07 240); border-radius: 10px; color: var(--ink); background: var(--surface); cursor: pointer; text-align: left; }
.tree-node button:hover, .tree-node button.is-active { border-color: var(--green); box-shadow: 0.22rem 0.22rem 0 var(--lime); }
.tree-node.is-proposed button { border-left-color: oklch(60% 0.09 72); }
.tree-node.is-safe button { border-left-color: oklch(52% 0.07 166); }
.tree-node.is-risk button { border-left-color: oklch(58% 0.08 25); }
.tree-node .node-name { min-width: 0; overflow-wrap: anywhere; font-family: var(--serif); font-size: var(--step-1); font-weight: 700; }
.tree-node .node-meta { display: block; margin-top: var(--space-1); color: var(--muted); font-family: var(--mono); font-size: var(--step--1); font-weight: 400; }
.drive-tree.is-filtered .tree-node:not(.is-active) { opacity: 0.24; }
.map-details { padding: var(--space-5); background: var(--paper); }
.node-detail { display: none; }
.node-detail.is-active { display: block; }
.node-detail h3 { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: center; font-size: var(--step-2); }
.node-detail > p { color: var(--muted); }
.state-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); margin-top: var(--space-5); }
.state-box { padding: var(--space-4); border: 1px solid var(--hairline); background: var(--surface); }
.state-box.current { border-top: 4px solid oklch(58% 0.07 240); }
.state-box.proposed { border-top: 4px solid oklch(60% 0.09 72); }
.state-box small { color: var(--muted); font-family: var(--mono); }
.state-box strong { display: block; margin-top: var(--space-2); overflow-wrap: anywhere; }
.evidence-list { margin: var(--space-5) 0 0; padding: 0; list-style: none; }
.evidence-list li { padding: var(--space-3) 0; border-top: 1px solid var(--hairline); }
.evidence-list p { margin: var(--space-1) 0; color: var(--muted); }
figcaption { max-width: 78ch; padding: var(--space-3) var(--space-5); color: var(--muted); font-size: var(--step--1); }

.action-list { display: grid; gap: var(--space-6); }
.action-review { break-inside: avoid; border-top: 2px solid var(--ink); border-bottom: 1px solid var(--rule); background: var(--surface); }
.action-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-4); padding: var(--space-4) var(--space-5); border-bottom: 1px solid var(--hairline); }
.action-head h3 { font-size: var(--step-1); overflow-wrap: anywhere; }
.action-body { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(18rem, 0.9fr); gap: var(--space-6); padding: var(--space-5); }
.action-copy p { color: var(--muted); }
.before-after { display: grid; grid-template-columns: 1fr auto 1fr; gap: var(--space-3); align-items: stretch; margin-top: var(--space-4); }
.before-after > div { padding: var(--space-3); border: 1px solid var(--hairline); overflow-wrap: anywhere; }
.before-after .before { background: color-mix(in oklch, var(--blue), transparent 45%); }
.before-after .after { background: color-mix(in oklch, var(--amber), transparent 45%); }
.before-after small { display: block; color: var(--muted); font-family: var(--mono); }
.delta-arrow { display: grid; place-items: center; color: var(--green-dark); }
.review-controls { padding-left: var(--space-5); border-left: 1px solid var(--hairline); }
.review-controls h4 { font-size: var(--step-1); }
.disposition-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2); margin-top: var(--space-4); }
.disposition-row button { min-height: 2.75rem; border: 1px solid var(--rule); color: var(--ink); background: var(--paper); cursor: pointer; }
.disposition-row button[aria-pressed="true"] { border-color: var(--green); background: var(--lime); box-shadow: inset 0 -3px 0 var(--green); }
.review-controls label, .question-card label, .feedback-editor label { display: block; margin-top: var(--space-4); color: var(--muted); font-size: var(--step--1); }
.review-controls input, .review-controls textarea, .question-card input, .question-card select, .feedback-editor input, .feedback-editor textarea { width: 100%; min-height: 2.75rem; margin-top: var(--space-2); padding: var(--space-3); border: 1px solid var(--rule); border-radius: 0; color: var(--ink); background: var(--surface); }
textarea { min-height: 7rem; resize: vertical; }

.question-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-6); }
.question-card { padding: var(--space-5); border-top: 2px solid oklch(60% 0.09 72); border-bottom: 1px solid var(--rule); background: var(--surface); }
.question-card legend { padding: 0; font-family: var(--serif); font-size: var(--step-1); font-weight: 700; }
.choice { display: flex !important; gap: var(--space-3); align-items: flex-start; margin-top: var(--space-3) !important; color: var(--ink) !important; font-size: var(--step-0) !important; }
.choice input { width: auto; min-height: auto; margin: 0.28rem 0 0; }

.feedback-layout { display: grid; grid-template-columns: minmax(0, 0.85fr) minmax(22rem, 1.15fr); gap: var(--space-6); }
.feedback-editor, .feedback-preview { padding: var(--space-5); border-top: 2px solid var(--ink); border-bottom: 1px solid var(--rule); background: var(--surface); }
.feedback-preview pre { min-height: 22rem; max-height: 34rem; margin: var(--space-4) 0 0; padding: var(--space-4); overflow: auto; border: 1px solid var(--hairline); background: var(--paper); white-space: pre-wrap; overflow-wrap: anywhere; }
.packet-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-4); }
.packet-actions button, .file-button { display: inline-grid !important; width: auto !important; min-height: 2.75rem; margin: 0 !important; padding: 0 var(--space-4); place-items: center; border: 1px solid var(--rule); color: var(--ink) !important; background: var(--paper); cursor: pointer; font-size: var(--step--1) !important; font-weight: 650; }
.packet-actions button:hover, .file-button:hover { border-color: var(--green); background: var(--lime); }
.packet-actions button:disabled { color: var(--faint) !important; cursor: not-allowed; }
.file-button input { position: absolute; width: 1px; height: 1px; min-height: 0; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); }
.feedback-history { margin-bottom: var(--space-6); padding: var(--space-5); border: 1px solid var(--rule); border-top: 4px solid var(--blue); background: var(--surface); }
.feedback-history h3 { margin-top: var(--space-3); font-size: var(--step-2); }
.feedback-history p { color: var(--muted); }
.feedback-history pre { max-height: 24rem; padding: var(--space-4); overflow: auto; border: 1px solid var(--hairline); background: var(--paper); white-space: pre-wrap; overflow-wrap: anywhere; }
.import-report { margin-top: var(--space-4); padding: var(--space-4); border: 1px solid var(--hairline); background: var(--paper); }
.import-report h4 { font-size: var(--step-1); }
.import-report p { color: var(--muted); }
.import-report ul { max-height: 12rem; overflow: auto; padding-left: var(--space-5); font-family: var(--mono); font-size: var(--step--1); }
.import-report.is-valid { border-left: 4px solid var(--green); }
.import-report.is-invalid { border-left: 4px solid oklch(55% 0.14 25); }
.boundary-note { margin-top: var(--space-5); padding: var(--space-4); border-left: 4px solid oklch(60% 0.09 72); background: color-mix(in oklch, var(--amber), transparent 45%); }

.source-ledger { margin-top: var(--space-7); padding-top: var(--space-5); border-top: 2px solid var(--ink); }
.source-list, .glossary-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3) var(--space-6); padding: 0; list-style: none; }
.source-list li, .glossary-definition { padding: var(--space-3) 0; border-bottom: 1px solid var(--hairline); color: var(--muted); }
.source-list strong, .glossary-definition strong { display: block; color: var(--ink); }
.source-list code, .glossary-definition code { display: block; margin-top: var(--space-2); color: var(--green-dark); }
.term { display: inline; appearance: none; margin: 0; padding: 0 0.13em; border: 0; border-bottom: 1px dotted var(--green-dark); color: inherit; background: color-mix(in oklch, var(--lime), transparent 46%); cursor: help; font: inherit; font-style: italic; }
.term:hover, .term:focus-visible, .term[aria-expanded="true"] { color: var(--ink); background: var(--lime); }
.glossary-card { position: fixed; z-index: 40; width: min(28rem, calc(100vw - var(--space-5))); padding: var(--space-4); border: 1px solid var(--ink); background: var(--surface); box-shadow: 0.35rem 0.35rem 0 var(--green); }
.glossary-card small { display: block; color: var(--green-dark); font-family: var(--mono); }
.glossary-card strong { display: block; margin-top: var(--space-1); font-family: var(--serif); font-size: var(--step-1); }
.glossary-card p { margin: var(--space-2) 0 0; color: var(--muted); }
.glossary-close { position: absolute; top: var(--space-2); right: var(--space-2); width: 2.25rem; height: 2.25rem; border: 0; background: transparent; cursor: pointer; font-size: var(--step-1); }
.glossary-close:hover { background: var(--lime); }

.page-footer { display: flex; flex-wrap: wrap; gap: var(--space-4); justify-content: space-between; width: min(calc(100% - var(--space-6)), 92rem); margin: 0 auto; padding: var(--space-5) 0 var(--space-7); border-top: 1px solid var(--rule); color: var(--muted); font-size: var(--step--1); }

@media (max-width: 72rem) {
  .map-layout, .action-body { grid-template-columns: 1fr; }
  .drive-tree { border-right: 0; border-bottom: 1px solid var(--hairline); }
  .review-controls { padding: var(--space-5) 0 0; border-top: 1px solid var(--hairline); border-left: 0; }
}
@media (max-width: 56rem) {
  .hero, .section-head { grid-template-columns: 1fr; }
  .hero-note { padding: var(--space-5) 0 0; border-top: 1px solid var(--rule); border-left: 0; }
  .facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .fact:nth-child(3) { padding-left: 0; border-top: 1px solid var(--hairline); border-left: 0; }
  .fact:nth-child(4) { border-top: 1px solid var(--hairline); }
  .section-head { gap: var(--space-5); }
  .sidenote { padding: var(--space-4) 0; border-top: 1px solid var(--rule); border-left: 0; }
  .receipt-grid, .question-list, .feedback-layout, .source-list, .glossary-list { grid-template-columns: 1fr; }
}
@media (max-width: 40rem) {
  .masthead { grid-template-columns: minmax(0, 1fr); }
  .masthead-meta { text-align: left; }
  .hero { padding-top: var(--space-7); }
  .facts { grid-template-columns: 1fr; }
  .fact + .fact { padding-left: 0; border-top: 1px solid var(--hairline); border-left: 0; }
  .tab-button { padding: 0 var(--space-3); }
  .tab-panel { padding-top: var(--space-6); }
  .map-layout { display: block; }
  .drive-tree { padding: var(--space-4) 0; }
  .tree-node { margin-inline-start: 0 !important; }
  .tree-node button { border-radius: 0; }
  .tree-node::before { display: none; }
  .state-pair, .before-after { grid-template-columns: 1fr; }
  .delta-arrow { min-height: 2rem; }
  .disposition-row { grid-template-columns: 1fr; }
}

@media (prefers-reduced-motion: no-preference) {
  .anim { opacity: 0; transform: translateY(0.55rem); transition: opacity 560ms var(--ease-out), transform 560ms var(--ease-out); transition-delay: var(--d, 0ms); }
  .anim.is-in { opacity: 1; transform: none; }
  .hero h1, .hero .lede, .hero-note { animation: hero-in 700ms var(--ease-out) both; }
  .hero .lede { animation-delay: 90ms; }
  .hero-note { animation-delay: 180ms; }
  .feedback-return { animation: return-pulse 5s ease-in-out infinite; }
  @keyframes hero-in { from { opacity: 0; transform: translateY(0.6rem); } to { opacity: 1; transform: none; } }
  @keyframes return-pulse { 0%, 100% { border-color: oklch(60% 0.09 72); } 50% { border-color: var(--green); } }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
}

@media print {
  @page { margin: 0.55in; }
  body { background: white; font-size: 10pt; }
  .tab-shell, .glossary-card, .figure-toolbar, .disposition-row, .packet-actions, .skip-link { display: none !important; }
  .masthead, .hero, .facts, main, .page-footer { width: 100%; }
  .hero { padding: var(--space-6) 0; }
  .tab-panel { display: block !important; padding: var(--space-6) 0; break-before: page; }
  .tab-panel:first-child { break-before: auto; }
  .map-layout, .action-body, .feedback-layout { grid-template-columns: 1fr; }
  .drive-tree { border-right: 0; }
  .drive-tree.is-filtered .tree-node { opacity: 1; }
  .tree-node { margin-inline-start: 0 !important; }
  .tree-node button { break-inside: avoid; }
  .map-details { padding-inline: 0; }
  .node-detail { display: block !important; margin-top: var(--space-6); break-inside: avoid; }
  .node-detail[data-node-detail="all"] { display: none !important; }
  .review-controls { padding: var(--space-4) 0 0; border-top: 1px solid var(--hairline); border-left: 0; }
  details > * { display: block !important; }
  textarea, input, select { border-color: var(--hairline); }
}
`.trim();
